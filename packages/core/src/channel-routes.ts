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

export const DEFAULT_REACTION_PALETTE = ["eyes", "white_check_mark", "tada", "warning", "+1"];

export type EffectiveWatch = {
  react: boolean; reply: boolean; post: boolean; approvePosts: boolean;
  picker: "routed" | "frontdesk"; palette: string[];
  replyCooldownMin: number; postDailyCap: number;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** True when the whole watch layer is switched off by ops. */
export function watchDisabled(): boolean {
  return !!process.env.DESKMATE_WATCH_DISABLED;
}

/** Effective, defaulted watch settings for a route, or null when the channel isn't watched. */
export function resolveWatch(route: ChannelRoute | null | undefined): EffectiveWatch | null {
  const w = route?.watch;
  if (!w) return null;
  return {
    react: w.react ?? true,
    reply: w.reply ?? true,
    post: w.post ?? false,
    approvePosts: w.approvePosts ?? false,
    picker: w.picker ?? "routed",
    palette: w.reactionPalette ?? DEFAULT_REACTION_PALETTE,
    replyCooldownMin: numEnv("DESKMATE_REPLY_COOLDOWN_MIN", 10),
    postDailyCap: numEnv("DESKMATE_POST_DAILY_CAP", 3),
  };
}
