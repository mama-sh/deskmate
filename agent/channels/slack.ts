import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { resolveRoute } from "../lib/channel-routes.js";
import { chunkMarkdown, deskmateSlackIdentity } from "../lib/deskmate-identity.js";
import { maxTurns, nextConveneDecision, type ConveneState } from "../lib/convene.js";

// Slack surface for Deskmate. Users summon the team by tagging @deskmate; the
// front desk routes each request to the right deskmate and relays the answer.
//
// Vercel Connect handles the Slack OAuth install, bot-token rotation, and inbound
// webhook verification — there is no SLACK_BOT_TOKEN or signing secret to manage.
// SLACK_CONNECTOR is the Connect connector UID you provision (see README §Slack).
//
// HITL for free: when an active deskmate calls an approval-gated tool (e.g. the
// DevOps `record_decision` write), eve renders approve/reject buttons in the thread
// and resumes the parked turn once a human answers.
//
// Per-deskmate identity: the front desk delegates to a subagent (the `actions.
// requested` event carries a `subagent-call` with its name); we remember which
// deskmate answered and post the final reply AS them — their displayName as the
// sender and their avatar as the picture — via chat.postMessage with a custom
// identity. This needs the connector's `chat:write.customize` scope; without it we
// fall back to the shared "Deskmate" bot. Identity lives in agent/lib/deskmates.ts.
//
// Convene: for cross-domain requests the front desk voices several deskmates in one
// thread via the `deskmate_says` tool; the `action.result` handler below posts each
// turn under its deskmate identity, bounded by a turn cap, and flags the turn as
// "convened" so message.completed doesn't also post the root's own final message.
//
// Slack limitation: the custom name/avatar apply to the message BODY only. Thread
// reply-preview face-piles, notifications, and profile popovers fall back to a
// generic bot icon, because a per-message custom identity is not a real workspace
// member. Full per-deskmate identity everywhere would require a separate Slack app
// per deskmate — which defeats the single-install model — so we accept the trade.

type DeskmateState = { activeDeskmateId?: string | null; activeDeskmateTurnId?: string | null };

/**
 * The deskmate delegated to on THIS turn, if any. Scoped by turnId so a value left
 * behind by an aborted turn (turn.failed, or a completion that hit an early return
 * before the reset below) can't attribute a later, non-delegating turn to the wrong
 * deskmate — a stale turnId simply won't match the current one.
 */
function activeDeskmateForTurn(state: unknown, turnId: string): string | null {
  const s = state as DeskmateState | null;
  if (!s || s.activeDeskmateTurnId !== turnId) return null;
  return typeof s.activeDeskmateId === "string" ? s.activeDeskmateId : null;
}

/** Remember which deskmate is answering this turn (or clear with null, null). */
function setActiveDeskmate(state: unknown, id: string | null, turnId: string | null): void {
  const s = state as DeskmateState;
  s.activeDeskmateId = id;
  s.activeDeskmateTurnId = turnId;
}

// Convene bookkeeping stored on the Slack channel state: the turn-cap counter
// (see agent/lib/convene.ts) plus a flag marking that deskmate_says already
// voiced this turn, so message.completed doesn't also post the root's reply.
type ConveneFields = ConveneState & { convened?: boolean };

export default slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/deskmate"),
  onAppMention: (ctx, message) => {
    const auth = defaultSlackAuth(message, ctx);
    const route = resolveRoute({ id: message.channelId });
    if (!route) return { auth };
    const directive = route.lock
      ? `[routing] This Slack channel is dedicated to the \`${route.deskmate}\` deskmate. ` +
        `Delegate ONLY to \`${route.deskmate}\`. If the request is outside their role, say so ` +
        `rather than delegating to anyone else.`
      : `[routing] This Slack channel maps to the \`${route.deskmate}\` deskmate. Delegate to ` +
        `\`${route.deskmate}\` by default, unless the user explicitly names a different deskmate.`;
    return { auth, context: [directive] };
  },
  events: {
    // Note which deskmate the front desk delegated to, so the final reply can be
    // attributed to them. Subagent calls arrive as `subagent-call` actions.
    "actions.requested"(data, channel) {
      for (const action of data.actions ?? []) {
        const a = action as { kind?: string; subagentName?: unknown };
        if (a.kind === "subagent-call" && typeof a.subagentName === "string") {
          setActiveDeskmate(channel.state, a.subagentName, data.turnId);
        }
      }
    },
    // Render a convene turn: the root called deskmate_says to voice a deskmate.
    // Post its text into the thread under that deskmate's identity, bounded by the
    // per-conversation turn cap, and mark the turn "convened" so message.completed
    // does not additionally post the root's own final message.
    async "action.result"(data, channel) {
      const result = data.result as { kind?: string; toolName?: string; output?: unknown } | undefined;
      if (result?.kind !== "tool-result" || result.toolName !== "deskmate_says") return;
      const output = result.output as { deskmate?: string; text?: string } | undefined;
      const text = output?.text?.trim();
      const channelId = channel.state.channelId;
      const threadTs = channel.state.threadTs;
      if (!text || !channelId || !threadTs) return;

      const decision = nextConveneDecision(channel.state as ConveneState, data.turnId, maxTurns());
      const cs = channel.state as ConveneFields;
      cs.convenedTurnId = decision.turnId;
      cs.convenedTurns = decision.turns;
      cs.convened = true; // suppress the root's default final post this turn
      if (!decision.post) return; // hard cap backstop — drop extra turns

      const identity = deskmateSlackIdentity(output?.deskmate);
      let posted = 0;
      try {
        for (const chunk of chunkMarkdown(text)) {
          const res = await channel.slack.request("chat.postMessage", {
            channel: channelId,
            thread_ts: threadTs,
            markdown_text: chunk,
            ...(identity ? { username: identity.username } : {}),
            ...(identity?.icon_url ? { icon_url: identity.icon_url } : {}),
            ...(identity?.icon_emoji ? { icon_emoji: identity.icon_emoji } : {}),
          });
          if (!res.ok) throw new Error(`chat.postMessage failed: ${res.error}`);
          posted++;
        }
      } catch {
        // Only fall back if nothing was posted yet — reposting after some chunks
        // already landed would duplicate content in the thread.
        if (posted === 0) await channel.thread.post({ markdown: text });
      }
    },
    // Deliver the completed reply. When a deskmate handled the turn and we can post
    // into an anchored thread, post AS them; otherwise fall back to the default
    // shared-bot post (which also owns session anchoring for thread-less sessions).
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls") return;
      const message = data.message;
      if (!message) return;

      // A convene already voiced THIS turn via deskmate_says — don't also post the
      // root's final message. Scope to the convening turn so a flag left stale by an
      // earlier failed turn can't suppress a normal reply here.
      const conveneState = channel.state as ConveneFields;
      if (conveneState.convened && conveneState.convenedTurnId === data.turnId) {
        conveneState.convened = false;
        setActiveDeskmate(channel.state, null, null);
        return;
      }
      if (conveneState.convened) conveneState.convened = false; // clear stale flag, deliver normally

      const id = activeDeskmateForTurn(channel.state, data.turnId);
      setActiveDeskmate(channel.state, null, null); // reset so the next turn starts clean
      const identity = deskmateSlackIdentity(id);
      const channelId = channel.state.channelId;
      const threadTs = channel.state.threadTs;

      if (!identity || !channelId || !threadTs) {
        await channel.thread.post({ markdown: message });
        return;
      }

      let posted = 0;
      try {
        for (const chunk of chunkMarkdown(message)) {
          const res = await channel.slack.request("chat.postMessage", {
            channel: channelId,
            thread_ts: threadTs,
            markdown_text: chunk,
            username: identity.username,
            ...(identity.icon_url ? { icon_url: identity.icon_url } : {}),
            ...(identity.icon_emoji ? { icon_emoji: identity.icon_emoji } : {}),
          });
          if (!res.ok) throw new Error(`chat.postMessage failed: ${res.error}`);
          posted++;
        }
      } catch {
        // Only fall back if nothing was posted yet — reposting the full message after
        // some chunks already landed would duplicate content in the thread.
        if (posted === 0) await channel.thread.post({ markdown: message });
      }
    },
  },
});
