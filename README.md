# Deskmate

**Open-source, self-hostable AI coworkers that live in Slack.** Deskmate runs a
team of AI **deskmates** — each with its own role, instructions, skills, and
scoped read tools — behind a single [Vercel Eve](https://vercel.com/docs/eve)
deployment. Summon them by tagging **`@deskmate`**; a front-desk router hands the
request to the right deskmate, which answers from your data over MCP. Every
**write** waits for a human to approve it in the Slack thread.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmama-sh%2Fdeskmate&project-name=deskmate&repository-name=deskmate&env=AI_GATEWAY_API_KEY&envDescription=Optional%3A%20model%20access%20%28OIDC%20also%20works%20once%20linked%29)

> The button forks this repo, creates a Vercel project, and builds it. Model access
> works via project OIDC (AI Gateway). It does **not** set up Slack or MCP tools —
> finish those below. Requires a public repo — this one lives at `github.com/mama-sh/deskmate`.

Pick deskmates from a built-in **library**, or author your own.

---

## Architecture

```
Slack  ──@deskmate──▶  Front desk (agent/instructions.md)
                          │  routes by reading each deskmate's description
                          ▼
              ┌───────────┴────────────┐
              ▼                        ▼
      product_analyst             devops                 … (your roster)
      ├ instructions.md           ├ instructions.md
      ├ skills/ (load on demand)  ├ skills/
      ├ tools/  (read, tested)    ├ tools/ get_incident_summary
      │                           ├ tools/ record_decision  ⏸ approval: always()
      └ connections/ Mixpanel     └ connections/ Sentry   (read-only MCP)

reads run free  ·  writes pause for a human (approve/reject buttons in-thread)
Slack credentials + durable pause/resume handled by Vercel (Connect + Workflows)
```

- **Front desk** — a thin router (`agent/instructions.md`). It does no work; it
  delegates to a deskmate and relays the answer.
- **Deskmates** — Eve [subagents](https://eve.dev/docs/subagents) under
  `agent/subagents/<id>/`. Each is isolated: its own instructions, skills, read
  tools, and MCP connection.
- **The library** — `library/deskmates/<id>/` is the catalog. `pnpm deskmate:add
  <id>` copies one into `agent/subagents/` and regenerates the roster registry.
- **Human-in-the-loop** — any tool with `approval: always()` pauses for a human.
  Eve's durable sessions (Vercel Workflows) make the wait free; nothing is held
  in memory while it's parked.

## The deskmate library

| id | Deskmate | Reads from | Ships a |
|---|---|---|---|
| `product_analyst` | 📊 Product Analyst | Mixpanel | read tool (metric deltas) |
| `devops` | 🔧 DevOps Engineer | Sentry | read tool **+ approval-gated write** |
| `customer_success` | 🤝 Customer Success Analyst | Intercom | read tool (account health) |
| `growth_hacker` | 🚀 Growth Hacker | PostHog | read tool (funnel conversion) |
| `project_manager` | 📋 Project Manager | Linear | read tool (sprint status) |

Each deskmate also vendors a role **skill** (a load-on-demand playbook) from the
open [skills.sh](https://skills.sh) ecosystem — see `skills/SOURCE.md` in each for
attribution. `product_analyst` and `devops` ship **pre-activated**; add the rest
with `pnpm deskmate:add <id>`.

> Every tool ships with **seed data**, so the repo runs and demos with zero
> external infrastructure. Point a deskmate at real data by setting its MCP
> connection env vars (see `.env.example`) and swapping the seed read for a real one.

## Quickstart

```bash
git clone https://github.com/mama-sh/deskmate && cd deskmate
pnpm install            # Node 24+ required
pnpm test               # 14 unit tests over the tool logic
pnpm deskmate:list      # see the library; • marks active deskmates

vercel link && vercel env pull   # model access (VERCEL_OIDC_TOKEN)
pnpm dev                # local TUI + HTTP session endpoint; pick a model with /model

eve deploy              # deploy to YOUR Vercel to turn on the Slack surface
```

Test agent logic locally over the HTTP endpoint:

```bash
curl -s -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"how are signups doing this week?"}' -i | grep -i x-eve-session-id
```

## Finish setup (after deploy)

The Deploy button gets you a built project with model access. Connect Slack and
activate the deskmates you want from this checkout. Slack reaches the **deployed**
project through [Vercel Connect](https://vercel.com/docs/connect) — there is no
`SLACK_BOT_TOKEN` or signing secret to manage.

```bash
vercel link && vercel env pull        # connect this checkout to the deployed project
pnpm deskmate:init                    # pick deskmates to activate + enter their MCP URLs/tokens
pnpm deskmate:mcp:add <name> --to <deskmate>   # (optional) add a custom MCP to a deskmate
# Slack (Vercel Connect):
export FF_CONNECT_ENABLED=1
vercel connect create slack --triggers
vercel connect detach <uid> --yes
vercel connect attach <uid> --triggers --trigger-path /eve/v1/slack --yes
vercel deploy                         # redeploy so activated deskmates + MCPs go live
```

This sets `SLACK_CONNECTOR` and points Slack events at Deskmate's `/eve/v1/slack`
route. Install the app as **Deskmate**, invite the bot to a channel, and tag
`@deskmate`. Custom MCPs are build-time: `deskmate:mcp:add` generates a connection
file, then you redeploy. They can't be added to a running bot.

## Manage your team

`pnpm deskmate:init` is the guided way to activate deskmates and set their MCP env
in one go (see [Finish setup](#finish-setup-after-deploy)). The manual commands
below still work for one-off changes:

```bash
pnpm deskmate:list                       # library + which deskmates are active
pnpm deskmate:add customer_success       # activate one (or several) from the library
pnpm deskmate:remove growth_hacker       # deactivate
```

`add` copies `library/deskmates/<id>/` → `agent/subagents/<id>/` and regenerates
`agent/lib/deskmates.ts` (the roster registry). To **edit** an active deskmate,
change the library copy, then `remove` + `add` to refresh it.

### Author a new deskmate

Add a folder under `library/deskmates/<id>/`:

```
library/deskmates/<id>/
  deskmate.json     # { displayName, emoji, summary, skill, providers }
  agent.ts          # defineAgent({ description, model }) — description is the routing hint
  instructions.md   # the role + how it works
  tools/*.ts        # read tools: a pure, tested function + a thin defineTool wrapper
  connections/*.ts  # read-only MCP (defineMcpClientConnection, tools.allow)
  skills/*/SKILL.md # optional load-on-demand playbooks
```

Writes get a human gate by adding `approval: always()` (from `eve/tools/approval`)
to the tool. Then `pnpm deskmate:add <id>`. The front desk needs no edits — it
discovers each deskmate from its `description`.

## Route channels to a deskmate

Map a Slack channel to a deskmate in `agent/lib/channel-routes.ts`:

```ts
export const CHANNEL_ROUTES = {
  C0123INCIDENTS: { deskmate: "devops", lock: true }, // only devops here
  C0456GROWTH:    { deskmate: "growth_hacker" },       // default; others still reachable
};
```

Key by channel id (Slack → channel → "Copy link" → the `Cxxxx`). In a mapped channel
the front desk routes to that deskmate; `lock: true` restricts the channel to it.
Unmapped channels and DMs use normal routing. (Enforcement is instruction-level.)

## Human-in-the-loop

Reads run free. Any tool with `approval: always()` pauses before it runs and Eve
renders **approve / reject** buttons in the Slack thread. On approve it completes
and reports the result; on reject it never runs. The example is the DevOps
`record_decision` write.

## Caveats (honest)

- **Vercel-only today.** Eve's durable runtime is Vercel-only ("other platforms
  coming soon") — self-hosting means hosting on *your own* Vercel account.
- **Slack can't be tested on localhost.** Slack delivers to the deployed project
  via Connect. Test agent logic locally over the HTTP session endpoint.
- **Single-deployment, env-token auth.** One organization per deployment; MCP
  credentials live in env vars. Per-org tenancy is intentionally out of scope
  (see below).
- **One shared Slack identity.** This Eve version doesn't expose a per-reply
  name/icon, so every deskmate answers under one **Deskmate** bot. The roster in
  `agent/lib/deskmates.ts` is the seam for per-deskmate identity later.
- **Vendored skills are community content.** The role skills come from
  [skills.sh](https://skills.sh) authors at a range of quality and licensing —
  treat them as starting points, check `skills/SOURCE.md`, and edit for your team.

## Scope

This repo is the **single-organization OSS core** of Deskmate. It ships a one-click
Deploy button and a local `deskmate:init` onboarding CLI for **your own** deployment.
What's intentionally **not** here is the *hosted* layer: multi-organization tenancy, a
per-tenant secret vault, a no-code/Slack-driven onboarding wizard that connects each
company's tools, a signup/control-plane/dashboard, billing, and per-tenant
provisioning. The seams that make that layer additive are already present: connections
resolve auth per call, and deskmates are a data-driven library.

## Links

`deskmate.sh` · [`github.com/deskmate`](https://github.com/deskmate) · npm `@deskmate`

## License

[Apache-2.0](./LICENSE).
