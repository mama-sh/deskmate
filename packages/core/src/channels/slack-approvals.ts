// Human-readable Slack rendering for eve HITL requests (approvals + questions).
//
// eve's default renderer shows "Approve tool call: <toolName>" plus a raw
// JSON.stringify of the input. Overriding the Slack channel's `input.requested`
// handler (see slack.ts) lets us render an approval as a per-tool card instead,
// while preserving the exact block/action contract eve's interaction pipeline
// needs to resolve the click and rewrite the answered card
// (node_modules/.../eve/dist/src/public/channels/slack/{hitl,interactions}.js):
//
//   - buttons:  action_id `eve_input:<requestId>:button:<n>`, value = optionId
//   - selects:  action_id `eve_input:<requestId>`
//   - freeform: action_id `eve_input_freeform:<requestId>`, value = requestId
//   - all content blocks precede ONE trailing `actions` block (eve keeps the
//     section/context/divider/image blocks before it as the answered-card record)
//
// slack-approvals.test.ts locks this contract so an eve upgrade that changes it
// fails loudly instead of silently breaking approvals in production.

const HITL_ACTION_PREFIX = "eve_input:";
const HITL_FREEFORM_ACTION_PREFIX = "eve_input_freeform:";
const SECTION_TEXT_MAX = 3000; // Slack section text hard limit

export type InputOption = {
  id: string;
  label: string;
  description?: string;
  style?: "danger" | "default" | "primary";
};

/** Structural mirror of eve's InputRequest (not publicly exported by name). */
export type InputRequest = {
  action: { callId: string; input: Record<string, unknown>; kind: "tool-call"; toolName: string };
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  options?: InputOption[];
  prompt: string;
  requestId: string;
};

export type SlackBlock = Record<string, unknown>;
export type RenderedRequest = { blocks: SlackBlock[]; text: string };

type Field = { label: string; value: string };
type ToolDescriptor = {
  emoji: string;
  verb: string;
  danger?: boolean;
  headline?: (input: Record<string, unknown>) => string | undefined;
  fields?: (input: Record<string, unknown>) => Field[];
};

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  record_decision: {
    emoji: "📝",
    verb: "Record a decision",
    headline: (i) => str(i.title) || undefined,
    fields: (i) => (str(i.detail) ? [{ label: "Details", value: str(i.detail) }] : []),
  },
  forget: {
    emoji: "🗑️",
    verb: "Delete a memory",
    danger: true,
    headline: (i) => str(i.key) || undefined,
  },
  open_pull_request: {
    emoji: "🔀",
    verb: "Open a pull request",
    headline: (i) => str(i.title) || undefined,
    fields: (i) => {
      const f: Field[] = [];
      const base = str(i.base);
      const repo = str(i.repo);
      if (repo) f.push({ label: "Repo", value: base ? `${repo} → base ${base}` : repo });
      if (str(i.branch)) f.push({ label: "Branch", value: str(i.branch) });
      if (str(i.body)) f.push({ label: "Description", value: str(i.body) });
      return f;
    },
  },
};

function humanizeToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

function fallbackDescriptor(toolName: string): ToolDescriptor {
  return {
    emoji: "⚙️",
    verb: `Run \`${humanizeToolName(toolName)}\``,
    fields: (input) =>
      Object.entries(input)
        .filter(([, v]) => str(v) !== "")
        .map(([k, v]) => ({ label: k, value: str(v) })),
  };
}

function truncate(text: string, max = SECTION_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function section(mrkdwn: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(mrkdwn) } };
}

// Slack caps button/option/menu `plain_text` at 75 chars and rejects the WHOLE
// chat.postMessage if any element exceeds it — so an over-long option label would
// make the question fail to post. Cap every plain_text element, matching eve's
// own `truncatePlainText`.
const PLAIN_TEXT_MAX = 75;
function plainText(text: string, max = PLAIN_TEXT_MAX): SlackBlock {
  return { type: "plain_text", text: truncate(text, max) };
}

export function isApproval(req: InputRequest): boolean {
  return (
    req.display === "confirmation" &&
    req.options?.length === 2 &&
    req.options[0]?.id === "approve" &&
    req.options[1]?.id === "deny"
  );
}

function approvalActions(req: InputRequest): SlackBlock {
  const labelFor: Record<string, string> = { approve: "Approve", deny: "Reject" };
  const styleFor: Record<string, "primary" | "danger"> = { approve: "primary", deny: "danger" };
  const elements = (req.options ?? []).map((opt, i) => ({
    type: "button",
    action_id: `${HITL_ACTION_PREFIX}${req.requestId}:button:${i}`,
    text: plainText(labelFor[opt.id] ?? opt.label),
    value: opt.id,
    ...(styleFor[opt.id] ? { style: styleFor[opt.id] } : {}),
  }));
  return { type: "actions", elements };
}

function renderApproval(req: InputRequest, deskmateName?: string): RenderedRequest {
  const d = TOOL_DESCRIPTORS[req.action.toolName] ?? fallbackDescriptor(req.action.toolName);
  const ask = d.danger
    ? `:warning: ${d.emoji} *${d.verb}* — this can't be undone`
    : `${d.emoji} *${d.verb}*`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🔐 Approval needed", emoji: true } },
    section(ask),
  ];
  const headline = d.headline?.(req.action.input);
  if (headline) blocks.push(section(`*${headline}*`));
  for (const f of d.fields?.(req.action.input) ?? []) blocks.push(section(`*${f.label}:* ${f.value}`));
  const who = deskmateName ? `${deskmateName} · ` : "";
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${who}requested via \`${req.action.toolName}\`` }],
  });
  blocks.push(approvalActions(req));
  return { blocks, text: `Approval needed: ${d.verb}${headline ? ` — ${headline}` : ""}` };
}

function toOption(opt: InputOption): SlackBlock {
  const o: SlackBlock = { text: plainText(opt.label), value: opt.id };
  if (opt.description) o.description = plainText(opt.description);
  return o;
}

function renderQuestion(req: InputRequest): RenderedRequest {
  const blocks: SlackBlock[] = [section(req.prompt)];
  const opts = req.options ?? [];
  if (opts.length > 0 && req.display === "select") {
    const menu =
      opts.length <= 6
        ? { type: "radio_buttons", action_id: `${HITL_ACTION_PREFIX}${req.requestId}`, options: opts.map(toOption) }
        : {
            type: "static_select",
            action_id: `${HITL_ACTION_PREFIX}${req.requestId}`,
            options: opts.map(toOption),
            placeholder: { type: "plain_text", text: "Choose an option" },
          };
    blocks.push({ type: "actions", elements: [menu] });
  } else if (opts.length > 0) {
    blocks.push({
      type: "actions",
      elements: opts.map((opt, i) => ({
        type: "button",
        action_id: `${HITL_ACTION_PREFIX}${req.requestId}:button:${i}`,
        text: plainText(opt.label),
        value: opt.id,
        ...(opt.style === "primary" || opt.style === "danger" ? { style: opt.style } : {}),
      })),
    });
  } else {
    // freeform: eve opens the modal itself from the section block + this trigger
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `${HITL_FREEFORM_ACTION_PREFIX}${req.requestId}`,
          text: { type: "plain_text", text: "Type your answer" },
          style: "primary",
          value: req.requestId,
        },
      ],
    });
  }
  return { blocks, text: req.prompt };
}

export function renderInputRequest(req: InputRequest, deskmateName?: string): RenderedRequest {
  return isApproval(req) ? renderApproval(req, deskmateName) : renderQuestion(req);
}
