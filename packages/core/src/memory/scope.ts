import type { MemoryScope } from "./types.js";

/**
 * Executor-derived scope. `deskmateId` is fixed at codegen; `workspace` comes
 * from `ctx`, never the model.
 *
 * NOTE: the exact `ctx` path for the Slack workspace/team id is PROVISIONAL and
 * must be confirmed against eve's Slack channel metadata during integration
 * (Task 11). eve's base `SessionContext` (eve 0.19.0) exposes
 * `ctx.session.auth.current.attributes` (a `Record<string, string | string[]>`)
 * but no top-level `ctx.channel`; the `ctx.channel.metadata.teamId` path below
 * is the anticipated Slack shape. The two fallback paths encoded here are the
 * current contract the tests rely on.
 */
export function resolveScope(deskmateId: string, ctx: any): MemoryScope {
  const workspace =
    ctx?.channel?.metadata?.teamId ??
    ctx?.session?.auth?.current?.attributes?.workspaceId ??
    undefined;
  return { deskmate: deskmateId, workspace: typeof workspace === "string" ? workspace : undefined };
}
