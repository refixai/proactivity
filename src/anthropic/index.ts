// Anthropic SDK adapter — proactivity for agents built on the raw Messages
// API, where there is no framework object to wrap because the developer IS
// the loop.
//
// Two supported shapes:
//
//   anthropicLoop({ client, model, system, tools })
//     We own the loop (the classic call → execute tools → feed results back
//     cycle), so the transcript is natively ours and governance is a
//     `governed` flag on the tool definition.
//
//   fromAnthropic({ client, run })
//     The developer keeps their own loop. Their run() receives a TRACED
//     client — a proxy that records every messages.create request/response
//     pair — and their loop code doesn't change a line. The transcript is
//     reconstructed from the recorded pairs: the Messages API is stateless,
//     so the full history is in the message arrays by construction.
//
// Everything here is structurally typed against the small slice of the SDK it
// touches, so any @anthropic-ai/sdk version (or a compatible client) works —
// there is no peer dependency to fall out of sync with.

import {
  describeGovernanceOutcome,
  governedPerform,
} from "../proactive/governed.js";
import type {
  ProactiveAgentAdapter,
  ReasoningModel,
  Transcript,
  TranscriptEvent,
  WakeContext,
} from "../proactive/types.js";

// --- The slice of the Anthropic SDK we rely on --------------------------------

export type AnthropicClientLike = {
  messages: {
    // `params: any` on purpose. The real SDK's create() takes a strict
    // MessageCreateParams union, which under strictFunctionTypes is not
    // assignable to any narrower structural param type — a Record<string,
    // unknown> param here would reject the genuine Anthropic client at the
    // fromAnthropic()/anthropicModel() call site. The contract we actually
    // rely on is what create() RETURNS, so the param stays open.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(params: any): Promise<unknown>;
  };
};

type ContentBlockLike = {
  type: string;
  // text blocks
  text?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type MessageLike = { role: string; content: string | ContentBlockLike[] };
type ResponseLike = { content: ContentBlockLike[]; stop_reason?: string | null };

const stringifyResult = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "ok";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

// --- anthropicModel ------------------------------------------------------------

// The developer's own Anthropic client as the reflection engine. Structured
// output is enforced provider-side via output_config json_schema; reflection
// re-validates defensively on top.
export const anthropicModel = (
  client: AnthropicClientLike,
  model: string,
  options: { maxTokens?: number } = {},
): ReasoningModel => ({
  async generate(prompt, schema) {
    const response = (await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema } },
    })) as ResponseLike;

    const text = response.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error("anthropicModel: structured-output response contained no text block");
    }
    return JSON.parse(text);
  },
});

// --- anthropicLoop: we own the loop ---------------------------------------------

export type LoopTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(args: unknown): Promise<unknown> | unknown;
  // Opt this tool into the governance envelope. `true` uses the full args as
  // the idempotency target; pass an object to name the identifying fields.
  governed?:
    | boolean
    | {
        actionType?: string;
        target?: (args: unknown) => Record<string, unknown>;
        reasoning?: (args: unknown) => string;
      };
};

export type AnthropicLoopOptions = {
  client: AnthropicClientLike;
  model: string;
  system?: string;
  tools?: LoopTool[];
  maxTokens?: number;
  // Bound on model turns within ONE wake (the outer cadence is unbounded).
  maxTurns?: number;
};

export const anthropicLoop = (options: AnthropicLoopOptions): ProactiveAgentAdapter<string> => ({
  name: "anthropic-loop",
  async run(input) {
    const { client, model, system, tools = [] } = options;
    const maxTurns = options.maxTurns ?? 12;
    const events: TranscriptEvent[] = [];
    let finalOutput: string | null = null;

    const toolDefs = tools.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
    const messages: MessageLike[] = [
      { role: "user", content: typeof input.custom === "string" ? input.custom : input.message },
    ];

    let turn = 0;
    for (; turn < maxTurns; turn++) {
      const response = (await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        ...(toolDefs.length ? { tools: toolDefs } : {}),
        messages,
      })) as ResponseLike;
      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          events.push({ type: "model", content: block.text });
          finalOutput = block.text;
        }
      }
      if (response.stop_reason !== "tool_use") break;

      // Answer every tool_use in ONE user message (the Messages API requires it).
      const results: ContentBlockLike[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { resultText, isError } = await executeLoopTool(tools, block);
        events.push({
          type: "tool_call",
          name: block.name ?? "tool",
          args: block.input,
          result: resultText,
          ...(isError ? { isError } : {}),
        });
        results.push({
          type: "tool_result",
          tool_use_id: block.id ?? "",
          content: resultText,
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
    }

    if (turn === maxTurns) {
      // Not silent: reflection should know the run was cut, not concluded.
      events.push({
        type: "model",
        content: `[runtime] agent loop halted at maxTurns=${maxTurns} before a natural stop`,
      });
    }

    return { events, finalOutput };
  },
});

const executeLoopTool = async (
  tools: LoopTool[],
  block: ContentBlockLike,
): Promise<{ resultText: string; isError: boolean }> => {
  const tool = tools.find((t) => t.name === block.name);
  if (!tool) return { resultText: `Unknown tool: ${block.name}`, isError: true };

  try {
    if (tool.governed) {
      const config = typeof tool.governed === "object" ? tool.governed : {};
      const outcome = await governedPerform({
        actionType: config.actionType ?? tool.name,
        target: config.target
          ? config.target(block.input)
          : ((block.input ?? {}) as Record<string, unknown>),
        reasoning: config.reasoning?.(block.input),
        perform: async () => tool.execute(block.input),
      });
      if (!outcome.governed || outcome.outcome === "taken" || outcome.outcome === "soft_cap_overridden") {
        return { resultText: stringifyResult(outcome.result), isError: false };
      }
      // A denial is information, not an error — the model reads it and re-plans.
      return {
        resultText: describeGovernanceOutcome(outcome.outcome, outcome.denialReason),
        isError: false,
      };
    }
    return { resultText: stringifyResult(await tool.execute(block.input)), isError: false };
  } catch (err) {
    return { resultText: err instanceof Error ? err.message : String(err), isError: true };
  }
};

// --- fromAnthropic: the developer keeps their loop -------------------------------

export type AnthropicRunContext<TCustom = unknown> = {
  // The TRACED client — same surface as the one passed in, but every
  // messages.create through it is recorded for the transcript. Use this one.
  client: AnthropicClientLike;
  context: WakeContext;
  message: string;
  custom?: TCustom;
};

export type FromAnthropicOptions<TCustom = unknown> = {
  client: AnthropicClientLike;
  run(ctx: AnthropicRunContext<TCustom>): Promise<unknown>;
};

export const fromAnthropic = <TCustom = unknown>(
  options: FromAnthropicOptions<TCustom>,
): ProactiveAgentAdapter<TCustom> => ({
  name: "anthropic",
  async run(input) {
    const recorder = createMessagesRecorder();
    const traced = traceClient(options.client, recorder.record);

    await options.run({
      client: traced,
      context: input.context,
      message: input.message,
      ...(input.custom !== undefined ? { custom: input.custom } : {}),
    });

    return recorder.transcript();
  },
});

// A proxy over the client that records every messages.create pair and changes
// nothing else — properties and methods besides create pass straight through.
const traceClient = (
  client: AnthropicClientLike,
  record: (params: Record<string, unknown>, response: unknown) => void,
): AnthropicClientLike =>
  new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "messages") return Reflect.get(target, prop, receiver);
      const messages = Reflect.get(target, prop, receiver) as AnthropicClientLike["messages"];
      return new Proxy(messages, {
        get(mTarget, mProp, mReceiver) {
          if (mProp !== "create") return Reflect.get(mTarget, mProp, mReceiver);
          return async (params: Record<string, unknown>, ...rest: unknown[]) => {
            const response = await (
              mTarget.create as (...args: unknown[]) => Promise<unknown>
            ).call(mTarget, params, ...rest);
            record(params, response);
            return response;
          };
        },
      });
    },
  }) as AnthropicClientLike;

// Rebuilds a Transcript from recorded request/response pairs.
//
// The standard hand-rolled loop mutates ONE messages array, so consecutive
// requests share message/content object references — a WeakSet dedupes them
// and event order tracks true chronology. Loops that rebuild fresh message
// objects per call degrade to duplicate events (visible in the transcript,
// never silently dropped); parallel side-threads are each recorded as their
// pairs arrive.
const createMessagesRecorder = () => {
  const events: TranscriptEvent[] = [];
  const seenMessages = new WeakSet<object>();
  const seenContent = new WeakSet<object>();
  const openToolUses = new Map<string, Extract<TranscriptEvent, { type: "tool_call" }>>();
  let finalOutput: string | null = null;

  const processAssistantBlocks = (blocks: ContentBlockLike[]) => {
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        events.push({ type: "model", content: block.text });
        finalOutput = block.text;
      } else if (block.type === "tool_use") {
        const event: Extract<TranscriptEvent, { type: "tool_call" }> = {
          type: "tool_call",
          name: block.name ?? "tool",
          args: block.input,
        };
        events.push(event);
        if (block.id) openToolUses.set(block.id, event);
      }
    }
  };

  const processUserBlocks = (blocks: ContentBlockLike[]) => {
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const event = openToolUses.get(block.tool_use_id);
      if (!event) continue;
      event.result = stringifyResult(block.content);
      if (block.is_error) event.isError = true;
    }
  };

  const record = (params: Record<string, unknown>, response: unknown) => {
    const messages = Array.isArray(params.messages) ? (params.messages as MessageLike[]) : [];
    for (const message of messages) {
      if (message && typeof message === "object") {
        if (seenMessages.has(message)) continue;
        seenMessages.add(message);
      }
      const content = message.content;
      if (typeof content === "string") {
        // User text is the injected report (not an agent event); assistant
        // text arrives via response content and is recorded there.
        continue;
      }
      if (!Array.isArray(content)) continue;
      if (seenContent.has(content)) continue;
      seenContent.add(content);
      if (message.role === "assistant") processAssistantBlocks(content);
      else processUserBlocks(content);
    }

    const responseContent = (response as ResponseLike | undefined)?.content;
    if (Array.isArray(responseContent) && !seenContent.has(responseContent)) {
      seenContent.add(responseContent);
      processAssistantBlocks(responseContent);
    }
  };

  return {
    record,
    transcript: (): Transcript => ({ events, finalOutput }),
  };
};
