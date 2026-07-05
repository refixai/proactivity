import { describe, expect, test, vi } from "vitest";
import type { ProactivityStore } from "../core/types.js";
import { createTestStore } from "../memory/index.js";
import { parseDuration } from "./duration.js";
import { governedPerform } from "./governed.js";
import { consoleNarrator } from "./observe.js";
import { proactive } from "./proactive.js";
import { parseReflectOutput, renderTranscript } from "./reflect.js";
import type {
  AgentRunInput,
  ProactiveAgentAdapter,
  ProactiveEvent,
  ReasoningModel,
  Transcript,
} from "./types.js";

// --- Test doubles ---------------------------------------------------------
// Everything is driven through handle.wake() (the scheduler's manual path),
// so no timers ever fire and every test is deterministic.

const okTranscript = (): Transcript => ({
  events: [{ type: "model", content: "looked around, nothing to do" }],
  finalOutput: "done",
});

const makeAdapter = (
  impl?: (input: AgentRunInput) => Promise<Transcript> | Transcript,
): { adapter: ProactiveAgentAdapter; calls: AgentRunInput[] } => {
  const calls: AgentRunInput[] = [];
  return {
    calls,
    adapter: {
      name: "fake",
      run: async (input) => {
        calls.push(input);
        return impl ? await impl(input) : okTranscript();
      },
    },
  };
};

// A scripted ReasoningModel: returns the queued responses in order (the last
// one repeats), and records every prompt for assertions.
const makeModel = (
  ...responses: unknown[]
): { model: ReasoningModel; prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    model: {
      async generate(prompt) {
        prompts.push(prompt);
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
};

const reflection = (overrides: Record<string, unknown> = {}) => ({
  ledgerEntry: "reviewed the situation; nothing warranted action",
  goalMutations: [],
  nextWakeMinutes: 30,
  nextWakeReasoning: "quiet wake, standard interval",
  ...overrides,
});

const activeGoals = (store: ProactivityStore, entityId: string) =>
  store.listGoals(entityId, { status: ["active"] });

// --- The full wake pipeline ------------------------------------------------

describe("proactive() wake pipeline", () => {
  test("first wake: seeds declared goals, injects a first-wake report, reflects, persists the ledger", async () => {
    const store = createTestStore();
    const { adapter, calls } = makeAdapter();
    const { model, prompts } = makeModel(reflection());

    const handle = proactive(adapter, {
      model,
      store,
      observe: false,
      goals: [
        {
          title: "Keep the user briefed",
          objective: "Brief on Linear changes",
          doneCondition: "Standing",
          pinned: true,
        },
      ],
      cadence: { min: "15m", max: "24h" },
    });

    await handle.wake("e1");

    // The agent got the situation report as its default message.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).toContain("wake #1");
    expect(calls[0]!.message).toContain("first wake");
    expect(calls[0]!.message).toContain("Keep the user briefed");
    expect(calls[0]!.context.goals.map((g) => g.id)).toContain("keep-the-user-briefed");

    // Reflection ran on the dev's model, with the transcript in the prompt.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("looked around, nothing to do");
    expect(prompts[0]).toContain("PINNED");

    // The ledger entry landed on the wake's goal-tick.
    const tick = (await store.getLatestTick("e1"))!;
    expect(tick.status).toBe("completed");
    expect(tick.cadenceHintMs).toBe(30 * 60_000);
    expect(tick.cadenceReasoning).toBe("quiet wake, standard interval");
    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks).toHaveLength(1);
    expect(goalTicks[0]!.summary).toContain("nothing warranted action");
    expect(goalTicks[0]!.acted).toBe(false);
  });

  test("second wake: the report carries the first wake's ledger", async () => {
    const store = createTestStore();
    const { adapter, calls } = makeAdapter();
    const { model } = makeModel(
      reflection({ ledgerEntry: "briefed REX-144 to the user" }),
      reflection(),
    );

    const handle = proactive(adapter, { model, store, observe: false });
    await handle.wake("e1");
    await handle.wake("e1");

    const second = calls[1]!;
    expect(second.context.tickNumber).toBe(2);
    expect(second.context.lastWakeAt).not.toBeNull();
    expect(second.message).toContain("briefed REX-144 to the user");
    expect(second.message).not.toContain("first wake");
  });

  test("governed tools: idempotency dedupes, caps deny, audit trail drives `acted`", async () => {
    const store = createTestStore();
    const performed: string[] = [];

    const { adapter } = makeAdapter(async () => {
      const send = (userId: string) =>
        governedPerform({
          actionType: "send_brief",
          target: { userId },
          perform: async () => {
            performed.push(userId);
            return "delivered";
          },
        });

      const first = await send("u1");
      const duplicate = await send("u1");
      const second = await send("u2");
      const overCap = await send("u3");

      return {
        events: [
          { type: "tool_call", name: "send_brief", args: { userId: "u1" }, result: String(first.outcome) },
          { type: "tool_call", name: "send_brief", args: { userId: "u1" }, result: String(duplicate.outcome) },
          { type: "tool_call", name: "send_brief", args: { userId: "u2" }, result: String(second.outcome) },
          { type: "tool_call", name: "send_brief", args: { userId: "u3" }, result: String(overCap.outcome) },
        ],
        finalOutput: null,
      };
    });

    const { model } = makeModel(reflection({ ledgerEntry: "sent two briefs" }));
    const handle = proactive(adapter, { model, store, observe: false, caps: { perWake: 2 } });
    await handle.wake("e1");

    // The side effect ran exactly once per distinct target, up to the cap.
    expect(performed).toEqual(["u1", "u2"]);

    // Audit trail: two taken rows plus the cap denial. The duplicate writes
    // NO new row — the prior attempt already owns the idempotency key, and
    // the dispatcher hands back its id instead of double-recording.
    const tick = (await store.getLatestTick("e1"))!;
    const attempts = await store.listAttempts(tick.id);
    const outcomes = attempts.map((a) => a.governanceOutcome).sort();
    expect(outcomes).toEqual(["hard_denied", "taken", "taken"]);

    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks[0]!.acted).toBe(true);
  });

  test("governedPerform outside a wake is a transparent passthrough", async () => {
    const result = await governedPerform({
      actionType: "send_brief",
      target: { userId: "u1" },
      perform: async () => "delivered",
    });
    expect(result).toEqual({ governed: false, outcome: "ungoverned", result: "delivered" });
  });

  test("reflection evolves scratchpads; pinned goals survive a close attempt", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter();
    const { model } = makeModel(
      reflection({
        goalMutations: [
          {
            op: "update",
            goalId: "watch-signups",
            findings: "current state: 3 new signups\nopen threads: awaiting reply from u1 since 09:00\nnext: check tomorrow",
            reasoning: "learned from this wake",
          },
          { op: "complete", goalId: "watch-signups", reasoning: "trying to close a pinned goal" },
        ],
      }),
    );

    const handle = proactive(adapter, {
      model,
      store,
      observe: false,
      goals: [
        { id: "watch-signups", title: "Watch signups", objective: "o", doneCondition: "d", pinned: true },
      ],
    });
    await handle.wake("e1");

    const goals = await activeGoals(store, "e1");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.status).toBe("active"); // the complete was dropped
    expect(goals[0]!.findings).toContain("awaiting reply from u1");

    // The dropped mutation is visible in the ledger entry, not silently eaten.
    const tick = (await store.getLatestTick("e1"))!;
    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks[0]!.summary).toContain("dropped");
  });

  test("reflection can open its own goals (dynamic portfolio)", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter();
    const { model } = makeModel(
      reflection({
        goalMutations: [
          {
            op: "create",
            title: "Chase the churn spike",
            objective: "Find out why churn moved",
            doneCondition: "Cause identified",
            priority: "high",
            reasoning: "spotted in this wake",
          },
        ],
      }),
    );

    const handle = proactive(adapter, { model, store, observe: false });
    await handle.wake("e1");

    const goals = await activeGoals(store, "e1");
    expect(goals.map((g) => g.title)).toContain("Chase the churn spike");
  });

  test("a failing reflection degrades the bookkeeping, never the wake", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter();
    const { model } = makeModel(new Error("provider 500"));

    const handle = proactive(adapter, { model, store, observe: false, cadence: { min: "10m", max: "2h" } });
    await handle.wake("e1");

    const tick = (await store.getLatestTick("e1"))!;
    expect(tick.status).toBe("completed");
    // Fallback cadence: back off to max when reflection is unavailable.
    expect(tick.cadenceHintMs).toBe(2 * 3_600_000);
    const goalTicks = await store.listGoalTicks(tick.id);
    expect(goalTicks[0]!.summary).toContain("reflection model call failed");
  });

  test("an agent crash fails the wake honestly", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter(() => {
      throw new Error("graph exploded");
    });
    const { model, prompts } = makeModel(reflection());

    const handle = proactive(adapter, { model, store, observe: false });
    await handle.wake("e1");

    const tick = (await store.getLatestTick("e1"))!;
    expect(tick.status).toBe("failed");
    expect(tick.error).toContain("graph exploded");
    // Reflection never ran — there was nothing truthful to reflect on.
    expect(prompts).toHaveLength(0);
  });

  test("the wake gate skips the model entirely and says so", async () => {
    const store = createTestStore();
    const { adapter, calls } = makeAdapter();
    const { model, prompts } = makeModel(reflection());

    const handle = proactive(adapter, {
      model,
      store,
      observe: false,
      cadence: { min: "5m", max: "1h", default: "10m" },
      gate: async () => false,
    });
    await handle.wake("e1");

    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    const tick = (await store.getLatestTick("e1"))!;
    expect(tick.status).toBe("completed");
    expect(tick.cadenceHintMs).toBe(10 * 60_000);
    expect(tick.cadenceReasoning).toContain("wake gate declined");
  });

  test("the input callback shapes what reaches the adapter", async () => {
    const store = createTestStore();
    const { adapter, calls } = makeAdapter();
    const { model } = makeModel(reflection());

    const handle = proactive<{ state: string }>(adapter as ProactiveAgentAdapter<{ state: string }>, {
      model,
      store,
      input: (ctx) => ({ state: `custom for wake ${ctx.tickNumber}` }),
    });
    await handle.wake("e1");

    expect(calls[0]!.custom).toEqual({ state: "custom for wake 1" });
  });

  test("cadence from reflection is clamped to configured bounds", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter();
    const { model } = makeModel(reflection({ nextWakeMinutes: 1 })); // below min

    const handle = proactive(adapter, { model, store, observe: false, cadence: { min: "15m", max: "24h" } });
    await handle.wake("e1");

    const tick = (await store.getLatestTick("e1"))!;
    expect(tick.cadenceHintMs).toBe(15 * 60_000);
  });

  test("proactive() refuses to construct without a model", () => {
    const { adapter } = makeAdapter();
    expect(() => proactive(adapter, {} as never)).toThrow(/requires `model`/);
  });
});

// --- Unit: parseReflectOutput ----------------------------------------------

describe("parseReflectOutput", () => {
  const cadence = { minMs: 15 * 60_000, maxMs: 24 * 3_600_000 };

  test("non-object input degrades to defaults with warnings", () => {
    const out = parseReflectOutput("garbage", { goals: [], pinnedGoalIds: [], cadence });
    expect(out.ledgerEntry).toContain("no ledger entry");
    expect(out.nextWakeMinutes).toBe(cadence.maxMs / 60_000);
    expect(out.goalMutations).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  test("unknown ops and unknown goals are dropped; valid mutations survive", () => {
    const goals = [
      { id: "g1", status: "active" },
      { id: "g2", status: "active" },
    ] as never;
    const out = parseReflectOutput(
      {
        ledgerEntry: "x",
        nextWakeMinutes: 60,
        nextWakeReasoning: "r",
        goalMutations: [
          { op: "explode", goalId: "g1", reasoning: "?" },
          { op: "update", goalId: "ghost", findings: "f", reasoning: "r" },
          { op: "update", goalId: "g2", findings: "kept", reasoning: "r" },
        ],
      },
      { goals, pinnedGoalIds: [], cadence },
    );
    expect(out.goalMutations).toEqual([
      { op: "update", goalId: "g2", findings: "kept", reasoning: "r" },
    ]);
    expect(out.warnings.join(" ")).toContain("explode");
    expect(out.warnings.join(" ")).toContain("ghost");
  });

  test("status changes on pinned goals are stripped from updates", () => {
    const goals = [{ id: "p1", status: "active" }] as never;
    const out = parseReflectOutput(
      {
        ledgerEntry: "x",
        nextWakeMinutes: 60,
        nextWakeReasoning: "r",
        goalMutations: [{ op: "update", goalId: "p1", status: "paused", findings: "f", reasoning: "r" }],
      },
      { goals, pinnedGoalIds: ["p1"], cadence },
    );
    expect(out.goalMutations[0]!.status).toBeUndefined();
    expect(out.goalMutations[0]!.findings).toBe("f");
  });
});

// --- Unit: renderTranscript / parseDuration --------------------------------

describe("renderTranscript", () => {
  test("renders tool calls and truncates oversized results visibly", () => {
    const rendered = renderTranscript({
      events: [
        { type: "tool_call", name: "list", args: { a: 1 }, result: "y".repeat(5_000) },
        { type: "model", content: "thinking" },
      ],
      finalOutput: "the end",
    });
    expect(rendered).toContain("[tool] list");
    expect(rendered).toContain("truncated");
    expect(rendered).toContain("[final] the end");
  });

  test("an empty transcript says so instead of rendering nothing", () => {
    expect(renderTranscript({ events: [], finalOutput: null })).toContain("no observable events");
  });
});

describe("parseDuration", () => {
  test("parses units and passes numbers through", () => {
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration(500)).toBe(500);
    expect(parseDuration("500")).toBe(500);
  });

  test("rejects garbage with the config key in the message", () => {
    expect(() => parseDuration("soon", "cadence.min")).toThrow(/cadence\.min/);
    expect(() => parseDuration(-5, "cadence.max")).toThrow(/cadence\.max/);
  });
});

// --- Observability -----------------------------------------------------------

describe("observe", () => {
  test("a custom observer receives the whole wake as one ordered event stream", async () => {
    const store = createTestStore();
    const events: ProactiveEvent[] = [];
    // The adapter streams its own activity through input.observe (what the
    // framework adapters do live) and takes one governed action.
    const { adapter } = makeAdapter(async (input) => {
      input.observe?.({ type: "tool_call", name: "lookup", args: { q: "x" } });
      await governedPerform({
        actionType: "send_brief",
        target: { userId: "u1" },
        perform: async () => "sent",
      });
      return okTranscript();
    });
    const { model } = makeModel(reflection({ ledgerEntry: "sent the brief" }));

    const handle = proactive(adapter, { model, store, observe: (e) => events.push(e) });
    await handle.wake("e1");

    expect(events.map((e) => e.type)).toEqual([
      "wake_started",
      "agent_event",
      "governance",
      "reflection",
      "wake_completed",
    ]);
    const started = events[0] as Extract<ProactiveEvent, { type: "wake_started" }>;
    expect(started.trigger).toBe("manual");
    expect(started.tickNumber).toBe(1);
    const agent = events[1] as Extract<ProactiveEvent, { type: "agent_event" }>;
    expect(agent.event).toEqual({ type: "tool_call", name: "lookup", args: { q: "x" } });
    const governance = events[2] as Extract<ProactiveEvent, { type: "governance" }>;
    expect(governance.actionType).toBe("send_brief");
    expect(governance.outcome).toBe("taken");
    const reflected = events[3] as Extract<ProactiveEvent, { type: "reflection" }>;
    expect(reflected.ledgerEntry).toBe("sent the brief");
    const completed = events[4] as Extract<ProactiveEvent, { type: "wake_completed" }>;
    expect(completed.acted).toBe(true);
    expect(completed.nextWakeMs).toBe(30 * 60_000);
  });

  test("a gate-skipped wake emits wake_skipped and nothing else", async () => {
    const events: ProactiveEvent[] = [];
    const { adapter } = makeAdapter();
    const { model } = makeModel(reflection());
    const handle = proactive(adapter, {
      model,
      store: createTestStore(),
      gate: () => false,
      observe: (e) => events.push(e),
    });
    await handle.wake("e1");
    expect(events.map((e) => e.type)).toEqual(["wake_skipped"]);
  });

  test("narration is on by default and observe: false silences it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { adapter } = makeAdapter();
      const { model } = makeModel(reflection());

      const loud = proactive(adapter, { model, store: createTestStore() });
      await loud.wake("e1");
      const loudLines = log.mock.calls.map((c) => String(c[0]));
      expect(loudLines.some((l) => l.includes("[proactive:e1] wake #1"))).toBe(true);

      log.mockClear();
      const quiet = proactive(adapter, { model, store: createTestStore(), observe: false });
      await quiet.wake("e1");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("a throwing observer never breaks the wake", async () => {
    const store = createTestStore();
    const { adapter } = makeAdapter();
    const { model } = makeModel(reflection());
    const handle = proactive(adapter, {
      model,
      store,
      observe: () => {
        throw new Error("observer bug");
      },
    });
    await handle.wake("e1");
    expect((await store.getLatestTick("e1"))!.status).toBe("completed");
  });

  test("consoleNarrator renders the compact one-liners", () => {
    const lines: string[] = [];
    const narrate = consoleNarrator((line) => lines.push(line));
    narrate({
      type: "wake_started",
      entityId: "e1",
      tickNumber: 3,
      trigger: "scheduled",
      goalCount: 2,
      lastWakeAt: new Date(Date.now() - 120_000),
    });
    narrate({
      type: "agent_event",
      entityId: "e1",
      event: { type: "tool_call", name: "LINEAR_LIST_ISSUES", args: { assignee: "me" } },
    });
    narrate({
      type: "agent_event",
      entityId: "e1",
      event: { type: "model", content: "two tickets changed — worth a brief" },
    });
    narrate({
      type: "governance",
      entityId: "e1",
      actionType: "send_brief",
      outcome: "hard_denied",
      denialReason: "duplicate of attempt a1",
    });
    narrate({
      type: "reflection",
      entityId: "e1",
      ledgerEntry: "briefed 2 changed tickets",
      goalMutations: [{ op: "update_findings", goalId: "g1", findings: "…" }],
      nextWakeMinutes: 1.5,
      nextWakeReasoning: "activity is fresh",
      warnings: ["model omitted nextWakeMinutes; used the default"],
    });
    narrate({
      type: "wake_completed",
      entityId: "e1",
      tickNumber: 3,
      acted: true,
      nextWakeMs: 90_000,
    });
    narrate({ type: "wake_failed", entityId: "e1", error: new Error("boom") });

    expect(lines.slice(0, 6)).toEqual([
      "[proactive:e1] wake #3 (scheduled) — 2 goals, last wake 2m ago",
      '[proactive:e1] ⚙ LINEAR_LIST_ISSUES {"assignee":"me"}',
      "[proactive:e1] 💭 two tickets changed — worth a brief",
      "[proactive:e1] ⛔ send_brief — hard_denied: duplicate of attempt a1",
      "[proactive:e1] ✎ briefed 2 changed tickets [goals: update_findings] — next wake in 90s (activity is fresh)",
      "[proactive:e1] ⚠ reflection: model omitted nextWakeMinutes; used the default",
    ]);
    // The done line carries a wall-clock time; assert shape, not the clock.
    expect(lines[6]).toContain("wake #3 done (acted) — next wake at ");
    expect(lines[7]).toBe("[proactive:e1] ✗ wake failed: boom");
  });
});
