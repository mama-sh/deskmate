type Msg = { user?: string; ts?: string; bot_id?: string };

/** The bot's most recent message time (float seconds) in a thread, or null. */
export function lastBotReplySec(messages: Msg[], botUserId: string): number | null {
  let latest: number | null = null;
  for (const m of messages) {
    if (m.user !== botUserId || !m.ts) continue;
    const sec = Number.parseFloat(m.ts);
    if (Number.isFinite(sec) && (latest === null || sec > latest)) latest = sec;
  }
  return latest;
}

/** True if the bot posted in this thread within `minutes` of `nowSec`. */
export function withinCooldown(messages: Msg[], botUserId: string, nowSec: number, minutes: number): boolean {
  const last = lastBotReplySec(messages, botUserId);
  if (last === null) return false;
  return nowSec - last < minutes * 60;
}
