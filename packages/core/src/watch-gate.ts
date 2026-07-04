export type WatchAction = "ignore" | "react" | "reply" | "post";
export type WatchVerdict = { action: WatchAction; emoji?: string; reason?: string };
export type WatchToggles = { react: boolean; reply: boolean; post: boolean; palette: string[] };

/** Force a raw model verdict back inside what the channel allows. Default: ignore. */
export function clampVerdict(raw: WatchVerdict, t: WatchToggles): WatchVerdict {
  const reason = raw.reason;
  switch (raw.action) {
    case "react": {
      const emoji = (raw.emoji ?? "").replace(/:/g, "").trim();
      if (!t.react || !emoji || !t.palette.includes(emoji)) return { action: "ignore", reason };
      return { action: "react", emoji, reason };
    }
    case "reply":
      return t.reply ? { action: "reply", reason } : { action: "ignore", reason };
    case "post":
      return t.post ? { action: "post", reason } : { action: "ignore", reason };
    default:
      return { action: "ignore", reason };
  }
}
