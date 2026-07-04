// LangGraph adapter — plug an UNCHANGED LangGraph agent into proactive().
//
// Transcript capture rides the LangChain callbacks system: callbacks passed in
// the invoke config are inheritable, so one recorder receives every event from
// every child runnable — every node, every nested subgraph, every model and
// tool call. It's the same mechanism LangSmith tracing uses; this is an
// in-process mini-tracer that normalizes into the SDK's Transcript shape.
//
// Governance is the governed() wrapper: rebuilds a tool with the same
// name/description/schema whose body routes through governedPerform. Inside a
// wake it dispatches through the envelope; outside a wake (the same agent
// serving normal traffic) it's a transparent passthrough.

import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import {
  describeGovernanceOutcome,
  governedPerform,
} from "../proactive/governed.js";
import type {
  AgentRunInput,
  ProactiveAgentAdapter,
  ReasoningModel,
  Transcript,
  TranscriptEvent,
} from "../proactive/types.js";

// --- Transcript recorder ----------------------------------------------------

// The slice of the LangChain callback surface we listen to. Kept structural so
// the recorder is a plain object (LangChain accepts handler-method objects in
// the callbacks array), not a class tied to one @langchain/core version.
type LLMResultLike = {
  generations?: Array<Array<{ text?: string; message?: { content?: unknown } }>>;
};

export type TranscriptRecorder = {
  // Hand this to invoke(): { callbacks: [recorder.handler] }.
  handler: {
    handleLLMEnd(output: LLMResultLike, runId: string): void;
    handleToolStart(
      tool: { id?: string[]; name?: string },
      input: string,
      runId: string,
      parentRunId?: string,
      tags?: string[],
      metadata?: Record<string, unknown>,
      runName?: string,
    ): void;
    handleToolEnd(output: unknown, runId: string): void;
    handleToolError(err: Error, runId: string): void;
  };
  transcript(finalOutput: string | null): Transcript;
};

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block && typeof block.text === "string"
          ? block.text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const outputToText = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    // ToolMessage-shaped outputs carry their payload in `content`.
    if ("content" in output) return contentToText((output as { content: unknown }).content);
    try {
      return JSON.stringify(output) ?? String(output);
    } catch {
      return String(output);
    }
  }
  return String(output ?? "");
};

export const createTranscriptRecorder = (): TranscriptRecorder => {
  const events: TranscriptEvent[] = [];
  // Tool events are opened at start (preserving call order) and completed at
  // end/error via the runId — starts and ends interleave across parallel calls.
  const openToolRuns = new Map<string, Extract<TranscriptEvent, { type: "tool_call" }>>();

  return {
    handler: {
      handleLLMEnd(output, _runId) {
        const generation = output.generations?.[0]?.[0];
        const text = generation?.text || contentToText(generation?.message?.content);
        if (text) events.push({ type: "model", content: text });
      },
      handleToolStart(toolInfo, input, runId, _parentRunId, _tags, _metadata, runName) {
        let args: unknown = input;
        try {
          args = JSON.parse(input);
        } catch {
          // keep the raw string — some tools receive plain-text input
        }
        const event: Extract<TranscriptEvent, { type: "tool_call" }> = {
          type: "tool_call",
          name: runName ?? toolInfo.name ?? toolInfo.id?.[toolInfo.id.length - 1] ?? "tool",
          args,
        };
        events.push(event);
        openToolRuns.set(runId, event);
      },
      handleToolEnd(output, runId) {
        const event = openToolRuns.get(runId);
        if (!event) return;
        event.result = outputToText(output);
        openToolRuns.delete(runId);
      },
      handleToolError(err, runId) {
        const event = openToolRuns.get(runId);
        if (!event) return;
        event.result = err.message;
        event.isError = true;
        openToolRuns.delete(runId);
      },
    },
    transcript(finalOutput) {
      return { events, finalOutput };
    },
  };
};

// --- fromLangGraph ------------------------------------------------------------

// Anything with invoke(input, config) — a compiled StateGraph, a
// createReactAgent, a Runnable. Structural on purpose: the adapter must not
// care how the graph was built.
export type InvokableGraph = {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
};

export type FromLangGraphOptions = {
  // How the wake enters the graph when the developer supplied no `input`
  // callback on proactive(). Default: the situation report as a user message.
  defaultInput?: (input: AgentRunInput) => unknown;
};

const lastAiText = (result: unknown): string | null => {
  if (!result || typeof result !== "object" || !("messages" in result)) return null;
  const messages = (result as { messages: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  const text = contentToText(last?.content);
  return text || null;
};

export const fromLangGraph = (
  graph: InvokableGraph,
  options: FromLangGraphOptions = {},
): ProactiveAgentAdapter => ({
  name: "langgraph",
  async run(input) {
    const recorder = createTranscriptRecorder();
    const graphInput =
      input.custom ??
      (options.defaultInput
        ? options.defaultInput(input)
        : { messages: [{ role: "user", content: input.message }] });

    const result = await graph.invoke(graphInput, {
      callbacks: [recorder.handler],
      runName: "proactive-wake",
    });

    return recorder.transcript(lastAiText(result));
  },
});

// --- governed -----------------------------------------------------------------

export type GovernedToolOptions<TArgs = Record<string, unknown>> = {
  // Names the action in the audit trail; defaults to the tool's name.
  actionType?: string;
  // The idempotency identity: the smallest set of fields that identify WHAT
  // the action lands on ({ userId }, not the whole message body). Defaults to
  // the full args object — safe, but dedupes less aggressively.
  target?: (args: TArgs) => Record<string, unknown>;
  reasoning?: (args: TArgs) => string;
};

// Wrap ONE outbound tool in the governance envelope. Reads pass through
// ungoverned — wrap the tools that scare you.
export const governed = <TArgs extends Record<string, unknown> = Record<string, unknown>>(
  inner: StructuredToolInterface,
  options: GovernedToolOptions<TArgs> = {},
): StructuredToolInterface =>
  tool(
    async (args) => {
      const typedArgs = args as TArgs;
      const outcome = await governedPerform({
        actionType: options.actionType ?? inner.name,
        target: options.target ? options.target(typedArgs) : (typedArgs as Record<string, unknown>),
        reasoning: options.reasoning?.(typedArgs),
        // Deliberately NOT forwarding the run config: the outer (wrapped) call
        // is the canonical trace event, and forwarding inherited callbacks
        // would record every governed call twice (outer + inner).
        perform: () => inner.invoke(args),
      });

      if (!outcome.governed) return outcome.result;
      if (outcome.outcome === "taken" || outcome.outcome === "soft_cap_overridden") {
        return outcome.result;
      }
      // The denial goes back to the model as the tool result — in-band, so it
      // can re-plan instead of retrying blindly.
      return describeGovernanceOutcome(outcome.outcome, outcome.denialReason);
    },
    {
      name: inner.name,
      description: inner.description,
      // Same schema object the inner tool declared (zod or JSON schema) — the
      // model sees an identical tool either way.
      schema: inner.schema as never,
    },
  ) as StructuredToolInterface;

// --- langchainModel -------------------------------------------------------------

// Any LangChain chat model with structured-output support. Structural so the
// developer's installed langchain version doesn't have to match ours exactly.
export type StructuredOutputCapableModel = {
  withStructuredOutput(
    schema: Record<string, unknown>,
  ): { invoke(input: string): Promise<unknown> };
};

// The developer's own chat model as the reflection engine:
//   proactive(fromLangGraph(agent), { model: langchainModel(llm), ... })
export const langchainModel = (model: StructuredOutputCapableModel): ReasoningModel => ({
  generate: (prompt, schema) => model.withStructuredOutput(schema).invoke(prompt),
});
