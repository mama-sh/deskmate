import { describe, expect, it } from "vitest";
import tool from "../agent/tools/deskmate_says.js";

describe("deskmate_says", () => {
  it("returns the deskmate id and text verbatim for the channel to render", async () => {
    const out = await tool.execute({ deskmate: "devops", text: "spikes at 09:00" }, {} as never);
    expect(out).toEqual({ deskmate: "devops", text: "spikes at 09:00" });
  });

  it("summarizes to a short ack for the model", () => {
    const model = tool.toModelOutput?.({ deskmate: "devops", text: "x" });
    expect(model).toEqual({ type: "text", value: "Posted as devops." });
  });
});
