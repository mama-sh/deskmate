// Per-deskmate Slack sender identity.
//
// Slack lets a single bot post under a custom name + avatar per message via
// `chat.postMessage` with `username` + `icon_url`/`icon_emoji` — gated behind the
// connector's `chat:write.customize` scope. This module turns a deskmate id into
// that identity so a reply reads as coming FROM the deskmate, not a generic bot.
//
// Avatars are served by this app itself (agent/channels/deskmate-avatars.ts), so a
// fork needs no external image host. When no hosted avatar or public base URL is
// available, we fall back to the deskmate's emoji as the icon.

import { DESKMATES } from "./deskmates.js";
import { hasAvatar } from "./deskmate-avatars.js";

export type SlackSenderIdentity = {
  username: string;
  icon_url?: string;
  icon_emoji?: string;
};

/**
 * Public origin of this deployment, used to build absolute `icon_url`s Slack can
 * fetch. Prefer an explicit override; otherwise use Vercel's production URL.
 */
function publicBaseUrl(): string {
  // Treat an empty/whitespace override as unset so it still falls back to the
  // Vercel URL, and prepend https:// when a scheme-less host is supplied (Slack
  // needs an absolute URL to fetch the avatar).
  const explicit = process.env.DESKMATE_PUBLIC_URL?.trim();
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  let raw = explicit || (vercel ? `https://${vercel}` : "");
  if (raw && !/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw.replace(/\/+$/, "");
}

/** Resolve the Slack sender identity for a deskmate id, or null if unknown. */
export function deskmateSlackIdentity(id: string | null | undefined): SlackSenderIdentity | null {
  if (!id) return null;
  const d = (DESKMATES as Record<string, { displayName: string; emoji: string } | undefined>)[id];
  if (!d) return null;
  const base = publicBaseUrl();
  if (base && hasAvatar(id)) {
    return { username: d.displayName, icon_url: `${base}/eve/v1/avatars/${id}.png` };
  }
  // Fallback: render the deskmate's emoji as the avatar (also needs chat:write.customize).
  return { username: d.displayName, icon_emoji: d.emoji };
}

// Slack's `markdown_text` accepts up to ~12k characters per message. Split longer
// replies on paragraph boundaries so each chunk posts under the limit with the same
// sender identity, rather than being rejected or truncated.
const MAX_MARKDOWN_CHARS = 11_500;

export function chunkMarkdown(text: string, limit: number = MAX_MARKDOWN_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n\n+/)) {
    const piece = current ? `${current}\n\n${para}` : para;
    if (piece.length <= limit) {
      current = piece;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= limit) {
      current = para;
      continue;
    }
    // A single paragraph longer than the limit: hard-split on width.
    for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit));
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * One line per teammate, for injecting into a deskmate's convene delegation so
 * it knows who it can tag. Optionally exclude the deskmate itself. Generated
 * from the registry, so new deskmates appear with no further wiring.
 */
export function deskmateRoster(excludeId?: string): string {
  return Object.values(
    DESKMATES as Record<string, { id: string; displayName: string; emoji: string; summary: string }>,
  )
    .filter((d) => d.id !== excludeId)
    .map((d) => `- ${d.id} (${d.emoji} ${d.displayName}): ${d.summary}`)
    .join("\n");
}
