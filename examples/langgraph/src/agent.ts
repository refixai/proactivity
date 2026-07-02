// LangGraph + @refixai/proactivity: the "govern the tool" pattern.
// The scheduler wakes the agent on a self-adjusting cadence; each tick a
// LangGraph ReAct agent reasons over the briefing and calls send_email, whose
// implementation routes through governance.dispatch (idempotency, caps, audit).
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createHeartbeat, createScheduler, createTestStore } from "@refixai/proactivity";
import { buildTickPrompt } from "@refixai/proactivity/prompts";
import { createTimerAdapter } from "@refixai/proactivity/timer";
import { z } from "zod";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run this example.");
  process.exit(1);
}

const store = createTestStore();

// Tiny cadence so you can watch the loop in real time. Real agents use
// 15 minutes to 24 hours.
const cadence = { min: 5_000, max: 60_000, default: 10_000 };

// Stand-in signal source: one new signup on the first tick, then quiet, so
// you can watch the agent act, then back off.
const pendingSignups = ["u_alice"];

const llm = new ChatAnthropic({ model: "claude-opus-4-8" });

const heartbeat = createHeartbeat({
  store,
  cadence,
  sources: [{ name: "newSignups", load: async () => pendingSignups.splice(0) }],
  governance: { store, caps: { perPass: 3, perTick: 10 } },
  tick: async ({ briefing, goals, governance, boundary }) => {
    // First tick: give the agent a durable mission to pursue across wakes.
    if (goals.length === 0) {
      await store.applyGoalMutations(boundary.tickId, [
        {
          op: "create",
          title: "Welcome new signups",
          objective: "Send each new signup a short welcome email",
          doneCondition: "Every signup surfaced in a briefing has been emailed once",
          reasoning: "New-signup signal source is wired up",
        },
      ]);
      goals = await store.listGoals(boundary.entityId, { status: ["active"] });
    }
    const goal = goals[0]!;

    // Open a goal-tick so each dispatched action is attributed to this goal.
    const goalTickId = await store.insertGoalTick({
      goalId: goal.id,
      tickId: boundary.tickId,
      orderIndex: 0,
    });

    // The governed tool: the model calls it, the side effect goes through
    // governance. Returning the outcome lets the model see "taken" or
    // "hard_denied" and re-plan instead of retrying blindly.
    const sendEmail = tool(
      async ({ userId, body }) => {
        const { governanceOutcome } = await governance.dispatch({
          goalId: goal.id,
          goalTickId,
          actionType: "send_email",
          target: { userId },
          reasoning: `Welcome email to ${userId}`,
          perform: async () => {
            console.log(`  [send_email] to=${userId}: ${body.slice(0, 60)}`);
          },
        });
        return governanceOutcome;
      },
      {
        name: "send_email",
        description:
          "Send a welcome email to a user. Returns the governance outcome: " +
          '"taken" means it was sent; "hard_denied" means it was blocked (do not retry).',
        schema: z.object({ userId: z.string(), body: z.string() }),
      },
    );

    const agent = createReactAgent({ llm, tools: [sendEmail] });
    await agent.invoke({
      messages: [
        {
          role: "user",
          content: buildTickPrompt({
            briefing,
            goals,
            entityId: boundary.entityId,
            tickNumber: boundary.tickNumber,
            extra:
              "If the briefing lists new signups, email each one with send_email. " +
              "If there are none, take no action.",
          }),
        },
      ],
    });

    // The agent sets its own next wake: busy now, look again soon; quiet, back off.
    const busy = ((briefing.newSignups as string[]) ?? []).length > 0;
    return busy
      ? { cadenceHint: { nextTickMs: 5_000, reasoning: "activity, stay close" } }
      : { cadenceHint: { nextTickMs: 15_000, reasoning: "quiet, back off" } };
  },
});

let ticksRun = 0;
const scheduler = createScheduler({
  adapter: createTimerAdapter(),
  store,
  cadence,
  identity: (entityId) => `heartbeat:${entityId}`,
  onTick: async (entityId, trigger) => {
    const result = await heartbeat.runTick(entityId, trigger);
    ticksRun += 1;
    console.log(
      `tick #${ticksRun}: ${result.status}, ${result.actionsTakenCount} action(s), next wake in ${result.nextCadenceMs}ms`,
    );
    if (ticksRun >= 3) {
      await scheduler.stop("demo");
      console.log("3 ticks observed — demo complete.");
      process.exit(0);
    }
    return result;
  },
});

// The only call you make. First wake fires after cadence.default (10s).
await scheduler.start("demo");
console.log("scheduler started — first tick in 10s (Ctrl+C to quit early)");
