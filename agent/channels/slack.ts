import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { resolveRoute } from "../lib/channel-routes.js";

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
// Per-reply identity (a custom name/icon per deskmate) is not exposed by the Slack
// channel in this eve version, so every reply posts under one shared "Deskmate" bot.
// The roster + display identity live in agent/lib/deskmates.ts — the seam that wires
// per-deskmate Slack identity once the channel supports chat:write.customize.
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
});
