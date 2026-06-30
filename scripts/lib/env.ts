/** Pure: merge KEY=VALUE updates into existing .env text, replacing in place or appending. */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  let out = existing;
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, line);
    } else {
      out += `${out.length && !out.endsWith("\n") ? "\n" : ""}${line}\n`;
    }
  }
  return out;
}
