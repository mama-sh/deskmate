// Map a Slack channel to the deskmate that should handle it.
// Key by channel id (the Cxxxx from the channel's "Copy link") — always available
// on the inbound event. Channel *names* also work IF you resolve name->id yourself
// (needs the channels:read scope); the resolver accepts either.
//
// `lock: true` makes that deskmate the ONLY one reachable in the channel
// (instruction-enforced — see agent/channels/slack.ts). Omit it for a soft default.
export type ChannelWatch = {
  react?: boolean;                       // Tier-1 emoji reactions (default true)
  reply?: boolean;                       // Tier-2 thread answers (default true)
  post?: boolean;                        // Tier-2 top-level posts (default false)
  approvePosts?: boolean;                // HITL approve/reject before a post (default false)
  picker?: "routed" | "frontdesk";       // who acts (default "routed")
  reactionPalette?: string[];            // allowed reaction emoji (curated default otherwise)
  digest?: boolean;                      // include in the scheduled sweep (Phase 2)
};

export type ChannelRoute = { deskmate: string; lock?: boolean; watch?: ChannelWatch };

export const CHANNEL_ROUTES: Record<string, ChannelRoute> = {
  // "C0123INCIDENTS": { deskmate: "devops", lock: true },
  // "C0456GROWTH": { deskmate: "growth_hacker" },
};

export type ResolvedRoute = { deskmate: string; lock: boolean };

/** Resolve a channel (by name or id) to its route, or null when unmapped. */
export function resolveRoute(
  channel: { name?: string; id?: string },
  routes: Record<string, ChannelRoute> = CHANNEL_ROUTES,
): ResolvedRoute | null {
  const key =
    (channel.name && routes[channel.name] ? channel.name : undefined) ??
    (channel.id && routes[channel.id] ? channel.id : undefined);
  if (!key) return null;
  return { deskmate: routes[key].deskmate, lock: routes[key].lock ?? false };
}
