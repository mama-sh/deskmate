// Public API of @deskmate/core.
//
// The engine is parameterized by the roster: consumers pass their own roster
// data into these helpers; core never imports a generated registry.
//
// defineTeam (Task 2) and defineDeskmate (Task 3) join this surface next.

export type { Roster, DeskmateIdentity } from "./roster.js";

export {
  deskmateSlackIdentity,
  deskmateRoster,
  chunkMarkdown,
  type SlackSenderIdentity,
} from "./deskmate-identity.js";

export { resolveRoute, type ChannelRoute, type ResolvedRoute } from "./channel-routes.js";

export { nextConveneDecision, maxTurns, type ConveneState } from "./convene.js";
