import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { createTestStore } from "../memory/index.js";
import { proactive } from "../proactive/proactive.js";
import type { ReasoningModel } from "../proactive/types.js";
import { anthropicLoop, anthropicModel, fromAnthropic, type AnthropicClientLike } from "./index.js";

// Type-level regression guard: the GENUINE Anthropic client must be assignable
// to our structural slice, or every real fromAnthropic()/anthropicModel() call
// site fails to compile. (Caught in the wild: a Record<string, unknown> param
// on create() rejects the SDK's strict MessageCreateParams overloads under
// strictFunctionTypes.) Never called — it exists for tsc, not vitest.
const _realClientIsAssignable = (real: Anthropic): AnthropicClientLike => real;
void _realClientIsAssignable;

// --- Stub client -------------------------------------------------------------
// Plays back scripted Messages API responses (the last one repeats) and
// records every request. No network, no SDK dependency.

type StubResponse = { content: Array<Record<string, unknown>>; stop_reason?: string };

const makeStubClient = (responses: StubResponse[]) => {
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    requests,
    client: {
      messages: {
        async create(params: Record<string, unknown>) {
          requests.push(params);
          const response = responses[Math.min(i, responses.length - 1)]!;
          i += 1;
          return response;
        },
      },
    },
  };
};

const makeReflectionModel = (): { model: ReasoningModel; prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    model: {
      async generate(prompt) {
        prompts.push(prompt);
        return {
          ledgerEntry: "sent one brief; duplicate suppressed",
          goalMutations: [],
          nextWakeMinutes: 45,
          nextWakeReasoning: "steady",
        };
      },
    },
  };
};

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input,
});

// --- anthropicLoop through the full pipeline -----------------------------------

describe("anthropicLoop through proactive()", () => {
  test("owns the loop: report in, tools executed, governed dedupe, denial fed back in-band", async () => {
    const { client, requests } = makeStubClient([
      {
        content: [
          toolUse("t1", "lookup", { q: "signups" }),
          toolUse("t2", "send_brief", { userId: "u1" }),
        ],
        stop_reason: "tool_use",
      },
      {
        content: [toolUse("t3", "send_brief", { userId: "u1" })],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "all done" }], stop_reason: "end_turn" },
    ]);

    const sent: string[] = [];
    const adapter = anthropicLoop({
      client,
      model: "claude-sonnet-5",
      system: "You are a briefing agent.",
      tools: [
        {
          name: "lookup",
          description: "Look something up (read-only)",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
          execute: (args) => `found: ${(args as { q: string }).q}`,
        },
        {
          name: "send_brief",
          description: "Deliver the brief",
          input_schema: { type: "object", properties: { userId: { type: "string" } } },
          execute: (args) => {
            sent.push((args as { userId: string }).userId);
            return "sent";
          },
          governed: { target: (args) => ({ userId: (args as { userId: string }).userId }) },
        },
      ],
    });

    const store = createTestStore();
    const { model, prompts } = makeReflectionModel();
    const handle = proactive(adapter, { reflection: { model }, store, observe: false });
    await handle.wake("workspace-1");

    // The side effect ran once; the duplicate was idempotency-denied.
    expect(sent).toEqual(["u1"]);

    // The report was the loop's opening user message; the system prompt survived.
    expect(requests[0]!.system).toBe("You are a briefing agent.");
    const firstMessages = requests[0]!.messages as Array<{ content: string }>;
    expect(firstMessages[0]!.content).toContain("Situation report");

    // The duplicate's denial went back to the model as its tool_result.
    // (requests[] share one live messages array — the loop mutates it — so
    // assert on the tool_result blocks rather than positional indexing.)
    const allMessages = requests[2]!.messages as Array<{ role: string; content: unknown }>;
    const toolResults = allMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block: { type?: string }) => block.type === "tool_result");
    expect(JSON.stringify(toolResults)).toContain("hard_denied");

    // Audit trail: exactly one taken row.
    const tick = (await store.getLatestTick("workspace-1"))!;
    const attempts = await store.listAttempts(tick.id);
    expect(attempts.map((a) => a.governanceOutcome)).toEqual(["taken"]);

    // Reflection saw the whole run.
    const prompt = prompts[0]!;
    expect(prompt).toContain("[tool] lookup");
    expect(prompt).toContain("found: signups");
    expect(prompt).toContain("hard_denied");
    expect(prompt).toContain("[final] all done");
  });

  test("a loop that never stops is halted at maxTurns, and the transcript says so", async () => {
    const { client } = makeStubClient([
      { content: [toolUse("t1", "lookup", { q: "x" })], stop_reason: "tool_use" },
    ]);
    const adapter = anthropicLoop({
      client,
      model: "m",
      maxTurns: 2,
      tools: [
        {
          name: "lookup",
          description: "d",
          input_schema: { type: "object" },
          execute: () => "y",
        },
      ],
    });

    const transcript = await adapter.run({
      context: {} as never,
      message: "go",
    });

    expect(transcript.events.at(-1)).toEqual({
      type: "model",
      content: "[runtime] agent loop halted at maxTurns=2 before a natural stop",
    });
  });

  test("unknown tools and throwing tools surface as error results, not crashes", async () => {
    const { client } = makeStubClient([
      {
        content: [toolUse("t1", "ghost", {}), toolUse("t2", "bomb", {})],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "recovered" }], stop_reason: "end_turn" },
    ]);
    const adapter = anthropicLoop({
      client,
      model: "m",
      tools: [
        {
          name: "bomb",
          description: "d",
          input_schema: { type: "object" },
          execute: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });

    const transcript = await adapter.run({ context: {} as never, message: "go" });
    const toolEvents = transcript.events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toEqual([
      { type: "tool_call", name: "ghost", args: {}, result: "Unknown tool: ghost", isError: true },
      { type: "tool_call", name: "bomb", args: {}, result: "kaboom", isError: true },
    ]);
    expect(transcript.finalOutput).toBe("recovered");
  });
});

// --- fromAnthropic: BYO loop with the traced client -----------------------------

describe("fromAnthropic", () => {
  test("reconstructs the transcript from the dev's own loop without changing it", async () => {
    const { client } = makeStubClient([
      { content: [toolUse("t1", "lookup", { q: "x" })], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "the answer" }], stop_reason: "end_turn" },
    ]);

    // A classic hand-rolled loop, exactly as a user would write it — the only
    // difference is it uses the client handed to run().
    const adapter = fromAnthropic({
      client,
      run: async ({ client: traced, message }) => {
        const messages: Array<Record<string, unknown>> = [{ role: "user", content: message }];
        const first = (await traced.messages.create({ model: "m", messages })) as {
          content: Array<Record<string, unknown>>;
        };
        messages.push({ role: "assistant", content: first.content });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "found: x" }],
        });
        await traced.messages.create({ model: "m", messages });
      },
    });

    const transcript = await adapter.run({ context: {} as never, message: "report here" });

    expect(transcript.events).toEqual([
      { type: "tool_call", name: "lookup", args: { q: "x" }, result: "found: x" },
      { type: "model", content: "the answer" },
    ]);
    expect(transcript.finalOutput).toBe("the answer");
  });
});

// --- anthropicModel --------------------------------------------------------------

describe("anthropicModel", () => {
  test("requests provider-enforced structured output and parses the text block", async () => {
    const { client, requests } = makeStubClient([
      { content: [{ type: "text", text: '{"ok":1}' }] },
    ]);

    const model = anthropicModel(client, "claude-sonnet-5");
    const result = await model.generate("reflect", { type: "object" });

    expect(result).toEqual({ ok: 1 });
    expect(requests[0]!.model).toBe("claude-sonnet-5");
    expect(requests[0]!.output_config).toEqual({
      format: { type: "json_schema", schema: { type: "object" } },
    });
    const messages = requests[0]!.messages as Array<{ content: string }>;
    expect(messages[0]!.content).toBe("reflect");
  });

  test("fails loudly when the response has no text block", async () => {
    const { client } = makeStubClient([{ content: [] }]);
    const model = anthropicModel(client, "m");
    await expect(model.generate("p", {})).rejects.toThrow(/no text block/);
  });
});
