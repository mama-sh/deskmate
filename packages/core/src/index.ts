// Public API of @deskmate/core.
//
// The engine is parameterized by the roster: consumers pass their own roster
// data into these helpers; core never imports a generated registry.
//
// defineDeskmate (Task 3) joins this surface next.

export type { Roster, DeskmateIdentity } from "./roster.js";

export { defineTeam, type TeamConfig, type DeskmateConfig, type ConnectionConfig } from "./config.js";

export {
  deskmateSlackIdentity,
  deskmateRoster,
  chunkMarkdown,
  type SlackSenderIdentity,
} from "./deskmate-identity.js";

export { resolveRoute, type ChannelRoute, type ResolvedRoute } from "./channel-routes.js";

export { nextConveneDecision, maxTurns, type ConveneState } from "./convene.js";
