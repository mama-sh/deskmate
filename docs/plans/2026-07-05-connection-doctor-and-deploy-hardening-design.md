# Connection doctor + deploy/scaffolding hardening

**Date:** 2026-07-05
**Status:** Approved design — ready for implementation planning

## Problem

A shakedown of the deploy + connection-setup loop exposed several real gaps.
Every one turns a fast, local, fail-fast check into a slow "tag the bot in Slack
→ read logs → guess → redeploy" loop:

1. **`deskmate deploy` never pulls the target env before building.** It runs
   `sync → vercel build → patch → deploy` with no `vercel pull`, so `vercel build`
   validates connections against a stale `.vercel/.env.production.local` (or none).
   A misconfigured connection URL ships silently instead of failing the build.
2. **The generated connection template uses `??`, not `||`, for the URL
   fallback.** `mcp-template.ts:17` emits
   `process.env["X_MCP_URL"] ?? "https://example.invalid/mcp"`. An **empty-string**
   env value (a very common misconfig) leaves `url: ""` → `eve build` dies with a
   cryptic "url must be a valid URL". The same pattern is duplicated in the stub
   generator (`sync/render.ts:292`).
3. **There is no way to validate a connection before deploy.** Empty creds (auth
   fail), wrong tool names, and the `example.invalid` unconfigured state are all
   invisible until runtime.
4. **Catalog allow-lists are guessed and often wrong.** A mismatch silently loads
   **0 tools** — the connection looks connected but does nothing, the worst
   failure mode.
5. **Non-Bearer auth has no first-class path.** Langfuse requires
   `Authorization: Basic base64(pk:sk)` and rejects Bearer; the token template
   hardcodes Bearer, so it must be hand-edited.
6. **The `vercel env add` stdin trap is undocumented.** Piping a value via stdin
   is silently ignored in non-interactive/agent/CI mode — you must use `--value`.

## Key findings

- **The authored connection file is the source of truth**, not the config. The
  config entry is only `{ kind:"mcp", env }` (token) or `{ kind:"mcp", connect,
  service }` (oauth). The `url`, `auth`/`headers`, and `tools.allow` live in
  `connections/<name>.ts` (or `roles/<id>/connections/<name>.ts`). So the
  allow-list ↔ real-tools diff **requires importing the connection file**, exactly
  as `loadTeam` already imports the config.
- **`defineMcpClientConnection` just validates and returns its definition.**
  Importing a connection file yields the exact `{ url, auth, headers, tools }` the
  eve runtime sees — so `doctor` can resolve credentials the same way the runtime
  does.
- **All three auth schemes can reuse one env pair.** `<PREFIX>_MCP_URL` +
  `<PREFIX>_MCP_TOKEN` cover bearer, basic (token holds plaintext `pk:sk`, the file
  base64-encodes it), and custom-header (token is sent under a named header). The
  scheme is a property of the *connection file*, not the config — so
  `.env.example`, the stub renderer, and the `{ kind:"mcp", env }` entry are all
  untouched.

## Decisions

1. **`doctor` is the single validation surface** (chosen over adding live
   `tools/list` introspection to `mcp-add`). `mcp-add` usually runs before the URL
   + token exist, so introspection there often can't run anyway. `doctor` catches
   every issue from the shakedown; mcp-add introspection can follow later if
   wanted.
2. **First-class auth schemes in `mcp-add`** (chosen over docs-only). A
   `bearer / basic / custom-header` prompt + a `scheme` param on the template,
   designed so the config/env model does not change.
3. **`doctor` targets Streamable HTTP** (the modern MCP transport most servers —
   Linear, PostHog, Vercel, Langfuse — speak). SSE-only servers are reported
   gracefully as "not reachable over Streamable HTTP", not crashed on.
4. **oauth connections get a shallow check.** The token is a Vercel Connect
   *runtime* credential, not available locally, so `doctor` does reachability +
   "auth verified at runtime", not a deep auth/tools check.
5. **`doctor` stays separate from `deploy`.** Auto-running it inside `deploy` is an
   easy follow-on but out of scope here; keeping `deploy`'s change to just the pull
   keeps that command's contract minimal.

## Design

### 1. `deploy` pulls env first — `packages/cli/src/deploy.ts`

Prepend step 0: `vercel pull --yes --environment=production` (plus passthrough
auth/scope args), returning its exit code on non-zero so a bad env fails **before**
build. `DeployDeps` is unchanged (reuses `run`); the new order is:

```
vercel pull --yes --environment=production [...args]   # NEW step 0, fail-fast
sync
vercel build --prod [...args]        (VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1)
patch eve trace
vercel deploy --prebuilt --prod [...args]
```

`deploy.test.ts` extends to assert the pull runs first and that a non-zero pull
short-circuits (no sync/build/patch/deploy). Exact `vercel pull` flags verified
against current CLI docs at implementation time.

### 2. `??` → `||` on URL fallbacks — `mcp-template.ts`, `sync/render.ts`

`renderMcpConnection` (`mcp-template.ts:17`) and the token stub
(`sync/render.ts:292`) switch the URL fallback from `?? "https://example.invalid/mcp"`
to `|| "https://example.invalid/mcp"`, so an empty-string env falls back gracefully
instead of producing an invalid `url: ""`. The token fallback (`?? ""`) switches to
`|| ""` for consistency (no behavior change).

### 3. `deskmate doctor` (alias `check`) — new `doctor.ts` + `lib/mcp-probe.ts`

Wired into `cli.ts` + USAGE. Injected deps for offline unit tests (mirrors
`deploy`):

```ts
export interface DoctorDeps {
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  // Import the authored connection file; resolve URL + static headers as the
  // runtime would. Returns { kind: "not-found" | "oauth" | "unconfigured" | "ready", ... }.
  resolveConnection: (name: string, cwd: string) => Promise<ResolvedConn>;
  probe: (url: string, headers: Record<string, string>) => Promise<ProbeResult>;
}
```

Flow, per `connections.<name>`:

- **Resolve** the authored file (`connections/<name>.ts`, else
  `roles/*/connections/<name>.ts`); dynamic-import it to get `{ url, auth, headers,
  tools }`. Build the outgoing headers: call `auth.getToken()` → `Authorization:
  Bearer <token>` if present, and merge any static `headers` string values.
- **Classify without a probe** when possible: no file → *not-found*; `connect`
  auth (oauth) → *oauth* (reachability only, "verified at runtime"); `url` is
  `example.invalid` or URL/token empty → *unconfigured*.
- **Probe** otherwise: `lib/mcp-probe.ts` runs a minimal Streamable HTTP MCP
  handshake — `initialize` → `notifications/initialized` → `tools/list` — carrying
  the `Mcp-Session-Id` response header, parsing both `application/json` and
  `text/event-stream` responses. Returns `{ reachable, authOk, tools?, error? }`.
- **Report** per connection:
  - **(a) reachable?** transport/HTTP connect succeeded.
  - **(b) auth OK?** no 401/403 on initialize/list.
  - **(c) allow-list ↔ real tools:** allowed tools that don't exist on the server
    (the "0 tools loaded" trap) + count of real tools.
- **Exit non-zero** if any connection is broken (unreachable / auth-fail /
  allowed-tool-missing), so `doctor` is a real pre-deploy / CI gate.
  *not-found* and *unconfigured* are warnings, not hard failures (scaffolded but
  not yet wired is a normal state).

Pure report/diff logic (given a `ProbeResult`) is separated from I/O so it unit
tests without a network. `mcp-probe` gets a focused test over canned JSON and SSE
response bodies.

### 4. `mcp-add` auth schemes — `mcp-add.ts` + `lib/mcp-template.ts`

The **token** path gains a `Token scheme [bearer/basic/custom-header]` prompt
(default `bearer`). `renderMcpConnection` gains a `scheme` (and optional
`headerName`) param:

- **bearer** (unchanged): `auth: { getToken: async () => ({ token: process.env[TOKEN] || "" }) }`.
- **basic**: no `auth`; `headers: { Authorization: \`Basic ${Buffer.from(process.env[TOKEN] || "").toString("base64")}\` }`.
  The user sets `<PREFIX>_MCP_TOKEN` to plaintext `publicKey:secretKey`; the file
  base64-encodes it. (Solves Langfuse.)
- **custom-header**: prompt a header name (e.g. `X-Api-Key`); `headers: { [name]: process.env[TOKEN] || "" }`.

All three keep the `<PREFIX>_MCP_URL` + `<PREFIX>_MCP_TOKEN` pair, so the config
entry, `.env.example`, and stub renderer are **completely unchanged**. `doctor`
reads whichever of `auth`/`headers` the file resolved, validating all three
uniformly.

### 5. Docs — README

- A note near the token-env-setup and Slack `vercel env add` sections: in
  non-interactive/agent/CI mode, **stdin-piped values to `vercel env add` are
  silently ignored — use `--value`** (`vercel env add <NAME> production --value <v>`).
- A short "**Verify before deploy: `deskmate doctor`**" line under the roster/deploy
  flow.
- The Basic scheme's `<PREFIX>_MCP_TOKEN = publicKey:secretKey` convention, in the
  `mcp-add` / token-connection section.

### 6. Testing

- `deploy.test.ts`: pull runs first; non-zero pull short-circuits.
- `mcp-template.test.ts`: bearer / basic / custom-header render correctly (base64
  encode call for basic; named header for custom).
- `mcp-add.test.ts`: the scheme prompt wires the right template call (+ header-name
  prompt for custom-header).
- New `doctor.test.ts`: report/diff over injected probe results — not-configured,
  oauth (shallow), auth-fail, tool-mismatch, all-green; correct exit code.
- New `mcp-probe.test.ts`: parse a canned JSON response and a canned SSE stream;
  extract tool names + detect a 401.

All offline via injected deps — no real network, consistent with the existing CLI
test suite.

## Out of scope

- Live `tools/list` introspection inside `mcp-add` (doctor is the surface).
- Auto-running `doctor` inside `deploy`.
- Editing specific catalog allow-lists (no offline way to verify real tool names;
  doctor surfaces the mismatch instead).
- SSE-only (non-Streamable-HTTP) MCP transport in the probe.
- Any change to eve itself.
