import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

// Voice a message in the current Slack thread AS a specific deskmate, so it
// appears from them (their name and avatar). The front desk calls this during a
// convene; the Slack channel's action.result handler renders it under that
// deskmate's identity (a tool can't reach the channel's Slack handle). Posting a
// reply is the free, non-approval path — same as any other Slack reply.
export default defineTool({
  description:
    "Post a message into the current Slack thread AS a specific deskmate, so it appears from them " +
    "(their name and avatar). Use this only while convening multiple deskmates. `deskmate` is the " +
    "deskmate id (e.g. 'devops', 'product_analyst'); `text` is their message, in their own voice.",
  inputSchema: z.object({
    deskmate: z.string().min(1),
    text: z.string().min(1),
  }),
  approval: never(),
  async execute({ deskmate, text }) {
    return { deskmate, text };
  },
  toModelOutput(output) {
    return { type: "text", value: `Posted as ${output.deskmate}.` };
  },
});
