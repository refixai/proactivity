// The proactivity "tick", opened as an Eve `session.started` hook.
//
// Eve's native cron (schedules/reply-followups.ts) is the proactive trigger:
// each scheduled run starts a session, and this hook runs first — before any
// model turn — to open the tick. It records the tick, ensures the durable goal
// exists, opens a goal-tick, and stashes the tick's ids in state the tools read
// back. (It does not build the governance handle — that's not serializable, so
// the governed tool rebuilds it per call from these ids; see proactivity.ts.)
// The hook is the correct seeding point because it runs inside an eve context
// (schedule `run` handlers do not), so `tickState.update` is legal here.
import { defineHook } from "eve/hooks";
import { ENTITY_ID, store, tickState } from "../proactivity.js";

const GOAL_TITLE = "Follow up on unanswered threads";

// Stand-in signal source: one conversation you've left on read on the first
// tick, then quiet — so you can watch the agent nudge you, then go silent. A
// real agent pulls this from your chat/email history.
const owedReplies = [{ threadId: "t_alex", who: "Alex" }];

export default defineHook({
  events: {
    "session.started": async () => {
      const { tickId } = await store.insertTick({
        entityId: ENTITY_ID,
        trigger: "scheduled",
        dryRun: false,
      });

      // Ensure the durable mission exists: created once, then reused every tick.
      let goal = (await store.listGoals(ENTITY_ID, { status: ["active"] })).find(
        (g) => g.title === GOAL_TITLE,
      );
      if (!goal) {
        await store.applyGoalMutations(tickId, [
          {
            op: "create",
            title: GOAL_TITLE,
            objective: "Nudge me once about each conversation I've left waiting on a reply",
            doneCondition: "Every stale thread surfaced in a tick has been nudged once",
            reasoning: "The pending-replies source is live",
          },
        ]);
        goal = (await store.listGoals(ENTITY_ID, { status: ["active"] })).find(
          (g) => g.title === GOAL_TITLE,
        );
      }
      if (!goal) throw new Error("follow-up goal missing after create");
      const goalId = goal.id;

      // Open a goal-tick so each dispatched action is attributed to this goal.
      const goalTickId = await store.insertGoalTick({
        goalId,
        tickId,
        orderIndex: 0,
      });

      tickState.update(() => ({
        tickId,
        goalId,
        goalTickId,
        pendingReplies: owedReplies.splice(0),
      }));
    },
  },
});
