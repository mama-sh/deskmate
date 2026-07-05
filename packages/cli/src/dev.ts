import { spawn } from "node:child_process";
import { watch as fsWatch, existsSync } from "node:fs";
import { join } from "node:path";
import { syncCommand, CONFIG_FILE } from "./sync/index.js";
import { resolveEveBin } from "./lib/eve-bin.js";

/** Minimal shape of the spawned eve child that `dev()` relies on. */
export interface EveChild {
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Side effects `dev()` needs — injected so the orchestration is unit-testable. */
export interface DevDeps {
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  resolveEve: (cwd: string) => string;
  spawnEve: (eveBin: string, args: string[], cwd: string) => EveChild;
  watchConfig: (cwd: string, onChange: () => void) => { close: () => void };
}

/** True when args carry an http(s) URL — eve dev drives a deployment, nothing local to reload. */
export function isRemoteTarget(args: string[]): boolean {
  return args.some((a) => /^https?:\/\//.test(a));
}

const defaultDeps: DevDeps = {
  sync: syncCommand,
  resolveEve: resolveEveBin,
  // `args` is the full eve argv (`dev` subcommand + passthrough) — spawn it as-is.
  spawnEve: (eveBin, args, cwd) =>
    spawn(process.execPath, [eveBin, ...args], { stdio: "inherit", cwd }),
  watchConfig: (cwd, onChange) => watchConfigDefault(cwd, onChange),
};

/**
 * `deskmate dev [...args]`: sync the config → chat with the team via `eve dev`,
 * re-syncing on every config edit so the running agent updates live.
 */
export async function dev(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: DevDeps = defaultDeps,
): Promise<number> {
  const eveBin = deps.resolveEve(cwd);

  // Remote target: nothing local to reload — just proxy to `eve dev <url>`.
  if (isRemoteTarget(args)) {
    return waitForExit(deps.spawnEve(eveBin, ["dev", ...args], cwd));
  }

  // Initial sync: fail fast on an invalid config (don't launch eve on a broken tree).
  await deps.sync(cwd, { quiet: false });

  const child = deps.spawnEve(eveBin, ["dev", ...args], cwd);

  // Watch config + roles/**; re-sync quietly on change. Serialize: a sync can outlast
  // the debounce window, and two concurrent `syncCommand` runs would interleave the
  // rm/write on `agent/**` and briefly corrupt the tree. So run at most one at a time
  // and coalesce edits that land mid-sync into a single follow-up. A broken save warns
  // but does NOT kill eve — fix and save again.
  let syncing = false;
  let queued = false;
  const resync = () => {
    if (syncing) {
      queued = true;
      return;
    }
    syncing = true;
    deps
      .sync(cwd, { quiet: true })
      .catch((err: unknown) => {
        console.error(`⚠ re-sync failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        syncing = false;
        if (queued) {
          queued = false;
          resync();
        }
      });
  };
  const watcher = deps.watchConfig(cwd, resync);

  // Ctrl+C / termination: forward to eve so it tears down cleanly.
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    return await waitForExit(child);
  } finally {
    watcher.close();
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

function waitForExit(child: EveChild): Promise<number> {
  return new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

/** Real watcher: debounced fs.watch over deskmate.config.ts + roles/**. */
function watchConfigDefault(cwd: string, onChange: () => void): { close: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };
  // Watch the project dir (not the config file inode) so atomic-rename saves
  // (vim/VS Code safe-write, which replace the inode) still fire. Filter to the
  // config file so we ignore sync's own writes (.env.example, the agent/ dir entry).
  const watchers = [
    fsWatch(cwd, (_event, filename) => {
      if (filename === CONFIG_FILE) debounced();
    }),
  ];
  // `sync` tolerates a config-only project (deskmates declared but no authored
  // `roles/` on disk — it writes TODO placeholders), so `dev` must too. Watching a
  // nonexistent `roles/` would throw ENOENT synchronously, and recursive `fs.watch`
  // can also throw on some platforms/filesystems (EMFILE, unsupported recursive). If
  // it throws here it would escape past the already-spawned eve and orphan it — so
  // degrade to config-only live-reload instead (the config watcher above still fires).
  if (existsSync(join(cwd, "roles"))) {
    try {
      watchers.push(fsWatch(join(cwd, "roles"), { recursive: true }, debounced));
    } catch (err: unknown) {
      console.error(
        `⚠ roles/ live-reload disabled (watch failed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
