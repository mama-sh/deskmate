import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { resolveRoute } from "../lib/channel-routes.js";
import { chunkMarkdown, deskmateSlackIdentity } from "../lib/deskmate-identity.js";

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
// Slack limitation: the custom name/avatar apply to the message BODY only. Thread
// reply-preview face-piles, notifications, and profile popovers fall back to a
// generic bot icon, because a per-message custom identity is not a real workspace
// member. Full per-deskmate identity everywhere would require a separate Slack app
// per deskmate — which defeats the single-install model — so we accept the trade.

/** Read the deskmate id remembered for the current session, if any. */
function activeDeskmate(state: unknown): string | null {
  const v = (state as { activeDeskmateId?: unknown } | null)?.activeDeskmateId;
  return typeof v === "string" ? v : null;
}

/** Remember (or clear) which deskmate is answering this session's turn. */
function setActiveDeskmate(state: unknown, id: string | null): void {
  (state as { activeDeskmateId?: string | null }).activeDeskmateId = id;
}

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
          setActiveDeskmate(channel.state, a.subagentName);
        }
      }
    },
    // Deliver the completed reply. When a deskmate handled the turn and we can post
    // into an anchored thread, post AS them; otherwise fall back to the default
    // shared-bot post (which also owns session anchoring for thread-less sessions).
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls") return;
      const message = data.message;
      if (!message) return;

      const id = activeDeskmate(channel.state);
      setActiveDeskmate(channel.state, null); // reset so the next turn starts clean
      const identity = deskmateSlackIdentity(id);
      const channelId = channel.state.channelId;
      const threadTs = channel.state.threadTs;

      if (!identity || !channelId || !threadTs) {
        await channel.thread.post({ markdown: message });
        return;
      }

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
        }
      } catch {
        // Customize scope missing or the call failed — don't drop the answer.
        await channel.thread.post({ markdown: message });
      }
    },
  },
});
