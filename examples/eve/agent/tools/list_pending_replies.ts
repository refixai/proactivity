// Surfaces the conversations you owe a reply to this tick. It reads the briefing
// out of the ALS-scoped tick state that the session.started hook seeded — a
// file-based Eve tool can't close over the tick, so it reads context from there.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { tickState } from "../proactivity.js";

export default defineTool({
  description: "List conversations the user has left on read since the last tick.",
  inputSchema: z.object({}),
  async execute() {
    return { replies: tickState.get()?.pendingReplies ?? [] };
  },
});
