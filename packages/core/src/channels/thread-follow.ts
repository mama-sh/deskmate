// ── Thread participation gate ────────────────────────────────────────────────
// Deskmate should continue a conversation it's already part of. When someone
// replies in a thread the bot has already posted in, that reply is directed at
// the bot even without a fresh @mention — treat it like a normal turn, not like
// proactive channel-watching. This is the "talk to it in-thread without tagging
// again" behavior; the two-tier watcher (watch-gate.ts) covers the different case
// of proactively engaging in an opted-in channel where the bot ISN'T yet involved.
//
// Pure and side-effect free so it unit-tests without the Slack/Connect plumbing;
// slack-ambient.ts fetches the thread and composes these decisions.

// Bare closures/acknowledgements that end an exchange — don't reply to these even
// in a joined thread. Matched against the WHOLE normalized message, so anything
// with real content ("ok do it then", "thanks, but one more thing") is NOT an ack.
// Kept deliberately reply-biased: only clear gratitude/closure signals belong here.
const ACK_PHRASES = new Set([
  "thanks", "thank you", "thankyou", "thx", "thnx", "ty", "tysm", "tyvm", "cheers",
  "no problem", "np", "yw", "you're welcome", "youre welcome",
  "ok", "okay", "k", "kk", "okey", "okie",
  "got it", "gotit", "gotcha", "understood", "noted", "makes sense", "make sense",
  "sounds good", "sg", "sgtm", "will do", "wilco",
  "great", "cool", "nice", "perfect", "awesome", "amazing", "love it", "done",
  "+1", "ack", "roger",
]);

/**
 * True when `text` is a bare acknowledgement with nothing to answer — an empty
 * message, an emoji-only reaction, or a lone closure phrase. Reply-biased: when in
 * doubt (any substantive content), returns false so the bot stays in the conversation.
 */
export function isBareAck(text: string): boolean {
  // Strip emoji / non-letter-number characters to catch ":thumbsup:", "👍", "thanks!!!".
  const norm = text
    .toLowerCase()
    .replace(/:[a-z0-9_+-]+:/g, " ") // slack :emoji: shortcodes
    .replace(/[^\p{L}\p{N}'\s]/gu, " ") // punctuation + unicode emoji
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return true; // empty or emoji-only → nothing to answer
  return ACK_PHRASES.has(norm);
}

export type ThreadFollowEvent = {
  user?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
};

export type ThreadFollowDecision = { follow: boolean; reason: string };

/**
 * Decide whether the ambient handler should treat this inbound message as a direct
 * continuation of a thread the bot is already in — a reply the bot should answer
 * even though no one @mentioned it this time.
 *
 * `threadMessages` is the fetched `conversations.replies` payload for the thread;
 * "the bot already posted here" is the signal that the conversation belongs to it.
 */
export function shouldFollowThread(input: {
  event: ThreadFollowEvent;
  botUserId: string;
  threadMessages: Array<{ user?: string }>;
}): ThreadFollowDecision {
  const { event, botUserId, threadMessages } = input;
  const text = typeof event.text === "string" ? event.text : "";

  // Must be a reply INSIDE a thread — not a top-level message and not the thread root.
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return { follow: false, reason: "not a thread reply" };
  }
  if (event.user === botUserId) {
    return { follow: false, reason: "bot's own message" };
  }
  // An explicit @mention is the managed channel's job (slack.ts onAppMention).
  if (text.includes(`<@${botUserId}>`)) {
    return { follow: false, reason: "@mention → managed channel handles it" };
  }
  // Only continue threads the bot is actually part of — never barge into strangers'.
  if (!threadMessages.some((m) => m?.user === botUserId)) {
    return { follow: false, reason: "bot not active in this thread" };
  }
  if (isBareAck(text)) {
    return { follow: false, reason: "bare acknowledgement" };
  }
  return { follow: true, reason: "direct thread continuation" };
}
