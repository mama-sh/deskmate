import type { MemoryScope } from "./types.js";

/**
 * Executor-derived scope. `deskmateId` is fixed at codegen; `workspace` comes
 * from `ctx`, never the model.
 *
 * Confirmed against eve 0.19.0 (Task 11): a tool/instructions executor receives
 * a `SessionContext`, which has NO top-level `ctx.channel` — the Slack
 * workspace/team id lives on the session auth attributes. eve's default Slack
 * mention/DM auth (`buildSlackAuthContext`) writes `attributes.team_id`
 * (snake_case); Deskmate's proactive ambient channel (channels/slack-ambient.ts)
 * writes `attributes.teamId` (camelCase). We read both, then fall back to
 * `workspaceId` for any non-Slack surface. All are optional, so a workspace-less
 * surface simply scopes memory by deskmate id alone.
 */
export function resolveScope(deskmateId: string, ctx: any): MemoryScope {
  const attrs = ctx?.session?.auth?.current?.attributes;
  const workspace = attrs?.team_id ?? attrs?.teamId ?? attrs?.workspaceId ?? undefined;
  return { deskmate: deskmateId, workspace: typeof workspace === "string" ? workspace : undefined };
}
