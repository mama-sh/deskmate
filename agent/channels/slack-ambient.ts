import { connectSlackCredentials } from "@vercel/connect/eve";
import { defineChannel, POST } from "eve/channels";
import { generateText } from "ai";
import slack from "./slack.js";

// ── Ambient thread participation ──────────────────────────────────────────────
// Reply to thread messages WITHOUT an @mention — but only in threads Deskmate
// already joined, and only when a lightweight gate decides the message is really
// for Deskmate. This complements the mention/DM-only managed channel (slack.ts).
//
// Wiring: registered as a SECOND Vercel Connect trigger destination at
// /eve/v1/slack-ambient, receiving `message.channels` events. Requires the
// connector's `channels:history` scope + `message.channels` subscription, and the
// bot must be a member of the channel.
//
// Every decision is logged with the [ambient] prefix so a single test run shows
// exactly why it responded or stayed silent.

const CONNECTOR_UID = process.env.SLACK_CONNECTOR ?? "slack/deskmate";
// Gate model. Default to the same gateway model the agent uses (known-good on this
// deployment); override with DESKMATE_GATE_MODEL (e.g. a cheaper haiku) once proven.
const GATE_MODEL = process.env.DESKMATE_GATE_MODEL ?? "anthropic/claude-sonnet-4.6";

const creds = connectSlackCredentials(CONNECTOR_UID);
const log = (...a: unknown[]) => console.log("[ambient]", ...a);

let botUserIdCache: string | null = null;
const seenEventIds = new Set<string>();

async function resolveBotToken(): Promise<string> {
  const t: unknown = (creds as { botToken?: unknown }).botToken;
  return typeof t === "function" ? String(await (t as () => Promise<string>)()) : String(t);
}

async function slackApi(method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${await resolveBotToken()}`,
    },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as any;
  if (!json?.ok) log(`slack ${method} error:`, json?.error);
  return json;
}

async function getBotUserId(): Promise<string | null> {
  if (botUserIdCache) return botUserIdCache;
  const r = await slackApi("auth.test", {});
  botUserIdCache = r?.ok ? (r.user_id ?? null) : null;
  log("botUserId =", botUserIdCache);
  return botUserIdCache;
}

/** True when the bot has already posted in this thread (so we don't barge into strangers' threads). */
async function deskmateInThread(channelId: string, threadTs: string, botUserId: string): Promise<{ joined: boolean; recent: string }> {
  const r = await slackApi("conversations.replies", { channel: channelId, ts: threadTs, limit: 30 });
  const messages: any[] = r?.ok && Array.isArray(r.messages) ? r.messages : [];
  const joined = messages.some((m) => m?.user === botUserId);
  const recent = messages
    .slice(-6)
    .map((m) => `${m?.user === botUserId ? "Deskmate" : "user"}: ${String(m?.text ?? "").slice(0, 400)}`)
    .join("\n");
  log(`participation: replies=${messages.length} joined=${joined}`);
  return { joined, recent };
}

/** LLM gate: should Deskmate act on this new thread message? Fails closed (silent). */
async function shouldRespond(text: string, recent: string): Promise<boolean> {
  try {
    const { text: verdict } = await generateText({
      model: GATE_MODEL,
      prompt:
        "You gate whether an AI teammate named Deskmate should reply to a NEW message in a Slack thread it is already part of. " +
        "Deskmate routes questions to specialist coworkers (DevOps/incidents, product metrics, etc.).\n\n" +
        'Answer "YES" only if the new message is plausibly directed at Deskmate or is a task/question it could help with ' +
        "(a follow-up question, a request, a report to analyze). " +
        'Answer "NO" for human-to-human chatter, acknowledgements ("thanks", "ok", "got it"), or anything not for Deskmate. ' +
        "When unsure, answer NO.\n\n" +
        `Recent thread:\n${recent}\n\nNEW message: ${text}\n\nAnswer with exactly YES or NO.`,
    });
    log(`gate verdict: "${verdict.trim().slice(0, 30)}"`);
    return /^\s*yes\b/i.test(verdict);
  } catch (err) {
    log(`gate ERROR (model=${GATE_MODEL}), staying silent:`, (err as Error)?.message ?? err);
    return false;
  }
}

function rememberEvent(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.add(eventId);
  if (seenEventIds.size > 1000) {
    for (const id of seenEventIds) {
      seenEventIds.delete(id);
      if (seenEventIds.size <= 800) break;
    }
  }
  return false;
}

export default defineChannel({
  routes: [
    POST("/eve/v1/slack-ambient", async (req, args) => {
      const raw = await req.text();

      // 1) Verify the inbound webhook via the Connect-supplied verifier.
      if (creds.webhookVerifier) {
        try {
          const verified = await creds.webhookVerifier(req, raw);
          if (!verified) {
            log("skip: webhook verification failed");
            return new Response("unauthorized", { status: 401 });
          }
        } catch (err) {
          log("skip: webhook verifier threw:", (err as Error)?.message ?? err);
          return new Response("unauthorized", { status: 401 });
        }
      }

      let envelope: any;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return new Response("ok");
      }

      if (envelope?.type === "url_verification") {
        return Response.json({ challenge: envelope.challenge });
      }

      const event = envelope?.event;
      log(
        `inbound: type=${event?.type} subtype=${event?.subtype ?? "-"} bot=${event?.bot_id ? "y" : "n"}` +
          ` ch=${event?.channel} thread_ts=${event?.thread_ts ?? "-"} ts=${event?.ts} user=${event?.user}` +
          ` text=${JSON.stringify(String(event?.text ?? "").slice(0, 60))}`,
      );

      if (rememberEvent(envelope?.event_id)) {
        log("skip: duplicate event_id");
        return new Response("ok");
      }
      if (!event || event.type !== "message" || event.subtype || event.bot_id) {
        log("skip: not a plain user message");
        return new Response("ok");
      }
      const channelId: string | undefined = event.channel;
      const threadTs: string | undefined = event.thread_ts;
      const userId: string | undefined = event.user;
      const text: string = typeof event.text === "string" ? event.text : "";
      if (!channelId || !threadTs || !userId || !text.trim()) {
        log("skip: missing channel/thread_ts/user/text (not a thread reply)");
        return new Response("ok");
      }
      if (threadTs === event.ts) {
        log("skip: message is the thread root, not a reply");
        return new Response("ok");
      }

      // 2) Heavy work off the response path — ack Slack immediately.
      args.waitUntil(
        (async () => {
          try {
            const botUserId = await getBotUserId();
            if (!botUserId) return log("skip: could not resolve botUserId");
            if (userId === botUserId) return log("skip: message is from the bot");
            if (text.includes(`<@${botUserId}>`)) return log("skip: message @mentions the bot (managed channel handles it)");
            const { joined, recent } = await deskmateInThread(channelId, threadTs, botUserId);
            if (!joined) return log("skip: Deskmate has not posted in this thread");
            if (!(await shouldRespond(text, recent))) return log("decision: gate said NO — staying silent");
            log("decision: dispatching a reply into the thread");
            await args.receive(slack, {
              message: text,
              target: { channelId, threadTs },
              auth: {
                authenticator: "slack",
                issuer: "slack",
                principalType: "user",
                principalId: userId,
                subject: userId,
                attributes: { teamId: envelope?.team_id ?? null, channelId },
              },
            });
            log("dispatched ok");
          } catch (err) {
            log("handler error:", (err as Error)?.message ?? err);
          }
        })(),
      );

      return new Response("ok");
    }),
  ],
});
