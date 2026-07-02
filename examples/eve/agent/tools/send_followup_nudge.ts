// The governed tool — this is the "govern the tool" pattern in Eve.
//
// The model calls it; the nudge routes through the governance envelope
// (idempotency, caps, audit ledger) before it fires. Keying the target on
// threadId + tickId is what stops the agent nudging you twice about the same
// conversation.
//
// The envelope is rebuilt here from the tick's ids (read from state) plus the
// shared `store`, rather than read as a live handle from state — Eve serializes
// state across workflow steps and a `GovernanceHandle` holds a function, so it
// can't live there. Idempotency survives the rebuild because it's enforced by
// the store on `tickId`, not by the in-memory handle. Returning the outcome lets
// the model see "taken" or "hard_denied" and stop instead of retrying blindly.
import { createGovernance, createLedger } from "@refixai/proactivity";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { CAPS, ENTITY_ID, store, tickState } from "../proactivity.js";

export default defineTool({
  description:
    "Nudge me to reply to a conversation I've left on read. Returns the " +
    'governance outcome: "taken" means the nudge was sent; "hard_denied" means ' +
    "it was suppressed (do not retry).",
  inputSchema: z.object({ threadId: z.string(), nudge: z.string() }),
  async execute({ threadId, nudge }) {
    const tick = tickState.get();
    if (!tick) throw new Error("send_followup_nudge ran outside a tick context");

    const governance = createGovernance(
      { store, caps: CAPS },
      tick.tickId,
      ENTITY_ID,
      createLedger(),
    );

    const { governanceOutcome } = await governance.dispatch({
      goalId: tick.goalId,
      goalTickId: tick.goalTickId,
      actionType: "send_followup_nudge",
      target: { threadId },
      reasoning: `Nudge to reply to ${threadId}`,
      perform: async () => {
        console.log(`[nudge] ${threadId}: ${nudge.slice(0, 60)}`);
      },
    });

    return { governanceOutcome };
  },
});
