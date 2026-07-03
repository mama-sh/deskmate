// Turn-cap bookkeeping for a multi-deskmate convene, kept pure so it can be
// unit-tested apart from the Slack channel. A "conversation" is one user turn;
// the counter resets when the turnId changes.

export type ConveneState = {
  convenedTurnId?: string | null;
  convenedTurns?: number;
};

export function nextConveneDecision(
  state: ConveneState,
  turnId: string,
  cap: number,
): { post: boolean; turnId: string; turns: number } {
  const sameTurn = state.convenedTurnId === turnId;
  const prior = sameTurn ? (state.convenedTurns ?? 0) : 0;
  if (prior >= cap) return { post: false, turnId, turns: prior };
  return { post: true, turnId, turns: prior + 1 };
}

/**
 * The per-conversation convene turn cap. `DESKMATE_MAX_TURNS` (a valid positive
 * number) is an ops override that wins over everything; otherwise `fallback` — the
 * consumer's `team.frontDesk.maxTurns`, baked into the generated channel shim — is
 * used, which itself defaults to 6.
 */
export function maxTurns(fallback = 6): number {
  const raw = Number(process.env.DESKMATE_MAX_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
