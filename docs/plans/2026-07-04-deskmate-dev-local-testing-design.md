# `deskmate dev` — test your config locally

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan

## Problem

You edit `deskmate.config.ts` (add a deskmate, change a model, wire a connection)
and there is no fast local loop to *see it work*. Today you have to run
`deskmate sync` yourself, then `eve dev`, and re-run both by hand every time you
touch the config. `defineTeam` validates the config's internal references, but
validation is not the same as talking to the team you just configured.

We want one command that regenerates the agent tree from the config and drops you
into a local chat with the front desk + deskmates — and keeps the tree in sync as
you edit the config, so the running agent updates live.

## Prior art in the repo

- `deskmate sync` (`packages/cli/src/sync/index.ts`) is already a programmatic
  function: `syncCommand(cwd)` loads `deskmate.config.ts`, validates it through
  `defineTeam`, and regenerates `agent/**`. It throws a clear error on an invalid
  config or on Node < 23.6 (can't import a `.ts` config).
- `eve dev` already provides the local TUI + HTTP session endpoint to chat with the
  built agent, with HMR that reloads on changes under `agent/**`
  (README ~L119–123). It can also drive a *deployment* when passed a URL
  (`eve dev https://my-app.vercel.app`).
- `sync/render.ts` already resolves a dependency's path with `createRequire` — the
  same mechanism we'll use to find the consumer's `eve` binary.

The gap is purely the glue: sync + launch + re-sync-on-edit, in one process.

## Approach

A new CLI subcommand **`deskmate dev [...args]`** (`packages/cli/src/dev.ts`),
wired into `cli.ts`. In order:

1. **Initial sync** — call `syncCommand(cwd)`. If the config is invalid, print the
   reason and **exit non-zero without launching eve**. You can't test a broken
   config; fail fast.
2. **Launch** — resolve the *consumer's* `eve` binary and
   `spawn("eve", ["dev", ...args])` with `stdio: "inherit"` so you interact with
   the TUI directly.
3. **Watch + re-sync** — a debounced `fs.watch` on `deskmate.config.ts` and
   `roles/**`. On change → re-run `syncCommand` **quietly**; eve dev's HMR picks up
   the regenerated `agent/**`. If a save leaves the config half-edited/invalid, the
   re-sync error is caught and printed as a one-line stderr warning — **eve keeps
   running** so you fix and save again.
4. **Lifecycle** — forward `SIGINT`/`SIGTERM` to the child; when eve exits, close
   the watcher and exit with eve's code. Ctrl+C tears down both.

### Alternatives considered (rejected)

- **B — `package.json` script + `concurrently`/`chokidar`.** A `"dev"` script plus
  a separate file watcher. Worse UX (no single-process live reload), and adds a
  dev-dependency. Rejected.
- **C — `deskmate sync --watch` paired with a separate `eve dev` terminal.** Simpler
  primitive, but two terminals and manual coordination. Rejected in favor of the
  one-command loop, though `dev` could later expose the watcher as a `sync --watch`
  primitive if that's ever wanted (YAGNI for now).

### Two design points

- **TUI vs. logging.** The interactive `eve dev` TUI owns the terminal, so noisy
  re-sync logs would corrupt it. `syncCommand` gains an optional `{ quiet }` so
  watch-mode re-syncs stay silent (only invalid-config warnings go to stderr). The
  *initial* sync — before the TUI starts — logs normally. Default `quiet: false`
  keeps every existing caller unchanged.
- **Deployment-target passthrough.** `deskmate dev https://my-app.vercel.app` drives
  a remote deployment (eve dev's URL mode) — there's nothing local to reload, so a
  URL-looking arg skips the initial sync + watcher and proxies straight to
  `eve dev`. Watch only applies to local dev.

## Files

| File | Change |
|------|--------|
| `packages/cli/src/dev.ts` | **New.** `export async function dev(args, cwd)`. Written for testability: injectable deps (a `spawn` fn, a `sync` fn, a `watch` fn) with real defaults — mirrors the repo's "pure, tested core + thin wrapper" ethos. |
| `packages/cli/src/lib/eve-bin.ts` | **New.** `resolveEveBin(cwd)` — `createRequire` → `require.resolve("eve/package.json")` → read `bin.eve`, resolve absolute. Throws a clear "eve isn't installed — run `npm install eve`" if unresolved. |
| `packages/cli/src/sync/index.ts` | Add optional `{ quiet }` to `syncCommand`. Default `false`; existing callers and output unchanged. |
| `packages/cli/src/cli.ts` | Add `case "dev"` + a USAGE line: `deskmate dev   sync + eve dev with live re-sync on config edits`. |
| `examples/starter/package.json` | Add `"dev": "deskmate dev"` (dogfood + implicit docs). |
| `README.md` | Update the "test locally" section (~L119–123) to lead with `deskmate dev`. |

## Error handling

- **No `deskmate.config.ts`** → reuse `syncCommand`'s existing clear error; exit non-zero.
- **`eve` not installed** → `resolveEveBin` throws the install hint.
- **Invalid config at startup** → print reason; exit non-zero; don't launch eve.
- **Invalid config during watch** → catch; one-line stderr warning; keep eve running.
- **Node < 23.6** (can't import `.ts` config) → already surfaced by `syncCommand`.

## Testing

Vitest, no real `eve` spawn, no model calls:

- **`dev.ts`** with injected fakes asserts: initial sync runs before spawn; eve is
  spawned with `["dev", ...args]` passthrough; a simulated config change triggers a
  debounced re-sync; a throwing re-sync does **not** kill the child; the child's exit
  code propagates; a URL arg skips sync + watch.
- **`eve-bin.ts`**: resolves a fake package's bin; throws the install hint when
  `eve` is missing.
- **`syncCommand({ quiet })`**: suppresses stdout but still writes files.

## Out of scope (YAGNI)

- A separate `deskmate check`/validate command (static validation is already done by
  `defineTeam` inside sync).
- A config-driven eval harness on top of eve's evals.
