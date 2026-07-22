import { describe, it, expect } from "vitest";
import { renderInputRequest, type InputRequest } from "../src/channels/slack-approvals.js";

function approvalReq(
  toolName: string,
  input: Record<string, unknown>,
  requestId = "req_1",
): InputRequest {
  return {
    action: { callId: "c1", input, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    options: [
      { id: "approve", label: "Yes" },
      { id: "deny", label: "No" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId,
  };
}

// The blocks eve preserves into the answered card (everything before the actions block).
function contentBlocks(blocks: Record<string, unknown>[]) {
  const i = blocks.findIndex((b) => b.type === "actions");
  return i === -1 ? blocks : blocks.slice(0, i);
}
function mrkdwnText(blocks: Record<string, unknown>[]): string {
  return JSON.stringify(blocks);
}

describe("renderInputRequest — eve resume contract", () => {
  it("emits approve/reject buttons with eve action ids and values", () => {
    const { blocks } = renderInputRequest(approvalReq("record_decision", { title: "T", detail: "D" }, "abc"));
    const actions = blocks.filter((b) => b.type === "actions");
    expect(actions).toHaveLength(1); // exactly one actions block
    const els = (actions[0] as any).elements as any[];
    expect(els[0].action_id).toBe("eve_input:abc:button:0");
    expect(els[0].value).toBe("approve");
    expect(els[1].action_id).toBe("eve_input:abc:button:1");
    expect(els[1].value).toBe("deny");
  });

  it("puts the single actions block last, with all content before it", () => {
    const { blocks } = renderInputRequest(approvalReq("record_decision", { title: "T", detail: "D" }));
    expect(blocks[blocks.length - 1].type).toBe("actions");
    expect(contentBlocks(blocks).every((b) => b.type !== "actions")).toBe(true);
  });
});

describe("renderInputRequest — record_decision", () => {
  it("shows the title as the headline and the detail, never raw JSON", () => {
    const { blocks, text } = renderInputRequest(
      approvalReq("record_decision", { title: "Open GitHub issue: dedup gap", detail: "Repo: mama-sh/deskmate" }),
    );
    const dump = mrkdwnText(blocks);
    expect(dump).toContain("Record a decision");
    expect(dump).toContain("Open GitHub issue: dedup gap");
    expect(dump).toContain("Repo: mama-sh/deskmate");
    expect(dump).not.toContain('\\"title\\"'); // no JSON.stringify blob
    expect(text).toContain("Open GitHub issue: dedup gap");
  });
});
