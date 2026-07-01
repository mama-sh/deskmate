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
// /eve/v1/slack_ambient, receiving `message.channels` events. Requires the
// connector to have the `channels:history` scope + `message.channels` event
// subscription (set in the Connect dashboard → Advanced), and a reinstall.
//
// Safeguards: drops the bot's own posts + subtypes, dedupes Slack retries,
// ignores @mentions (the managed channel handles those), only engages threads
// Deskmate has posted in, and the gate errs toward silence to avoid noise.

const CONNECTOR_UID = process.env.SLACK_CONNECTOR ?? "slack/deskmate";
// Cheap model for the "should I respond?" gate; override if needed.
const GATE_MODEL = process.env.DESKMATE_GATE_MODEL ?? "anthropic/claude-haiku-4.5";

const creds = connectSlackCredentials(CONNECTOR_UID);

// Best-effort per-instance caches (survive within a warm function instance).
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
  return (await res.json()) as any;
}

async function getBotUserId(): Promise<string | null> {
  if (botUserIdCache) return botUserIdCache;
  const r = await slackApi("auth.test", {});
  botUserIdCache = r?.ok ? (r.user_id ?? null) : null;
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
    return /^\s*yes\b/i.test(verdict);
  } catch (err) {
    console.error("[slack_ambient] gate error, staying silent:", err);
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
          if (!verified) return new Response("unauthorized", { status: 401 });
        } catch {
          return new Response("unauthorized", { status: 401 });
        }
      }

      let envelope: any;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return new Response("ok");
      }

      // Slack URL-verification handshake (if it ever reaches this route).
      if (envelope?.type === "url_verification") {
        return Response.json({ challenge: envelope.challenge });
      }

      // 2) Dedupe Slack retries.
      if (rememberEvent(envelope?.event_id)) return new Response("ok");

      const event = envelope?.event;
      // 3) Only human, non-subtype channel messages that are thread replies.
      if (!event || event.type !== "message" || event.subtype || event.bot_id) return new Response("ok");
      const channelId: string | undefined = event.channel;
      const threadTs: string | undefined = event.thread_ts;
      const userId: string | undefined = event.user;
      const text: string = typeof event.text === "string" ? event.text : "";
      if (!channelId || !threadTs || !userId || !text.trim()) return new Response("ok");
      if (threadTs === event.ts) return new Response("ok"); // the thread root, not a reply

      // 4) Heavy work off the response path — ack Slack immediately.
      args.waitUntil(
        (async () => {
          try {
            const botUserId = await getBotUserId();
            if (!botUserId || userId === botUserId) return;
            if (text.includes(`<@${botUserId}>`)) return; // @mention → managed channel handles it
            const { joined, recent } = await deskmateInThread(channelId, threadTs, botUserId);
            if (!joined) return; // only threads Deskmate already joined
            if (!(await shouldRespond(text, recent))) return; // relevance gate
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
          } catch (err) {
            console.error("[slack_ambient] handler error:", err);
          }
        })(),
      );

      return new Response("ok");
    }),
  ],
});
