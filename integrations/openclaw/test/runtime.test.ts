/**
 * Drives the real runtime — the SDK's actual `createGovernance` over the JSON
 * store, plus the tools — without needing OpenClaw installed. (The OpenClaw glue
 * in `index.ts` is validated separately by `tsc` against OpenClaw's real types.)
 *
 *     npm test
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createRuntime, type RuntimeConfig } from "../src/runtime.js";

const mkRuntime = (over: Partial<RuntimeConfig> = {}) =>
  createRuntime({
    dbPath: join(mkdtempSync(join(tmpdir(), "ph-oc-")), "store.json"),
    entityId: "t",
    perTick: 5,
    tickSeconds: 60,
    recentContactThreshold: 3,
    dryRun: false,
    governedTools: new Set<string>(),
    ...over,
  });

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("governance via decide()", () => {
  test("allows, then dedups an identical send in the same tick", async () => {
    const rt = mkRuntime();
    expect((await rt.decide("message", { to: "u1", content: "hi" })).ok).toBe(true);
    const dup = await rt.decide("message", { to: "u1", content: "hi" });
    expect(dup.ok).toBe(false);
    expect(dup.reason).toMatch(/duplicate/i);
  });

  test("enforces the per-tick cap", async () => {
    const rt = mkRuntime({ perTick: 2 });
    expect((await rt.decide("message", { to: "u1" })).ok).toBe(true);
    expect((await rt.decide("message", { to: "u2" })).ok).toBe(true);
    const third = await rt.decide("message", { to: "u3" });
    expect(third.ok).toBe(false);
    expect(third.reason).toMatch(/cap/i);
  });

  test("serializes concurrent decisions so the per-tick cap holds", async () => {
    // OpenClaw fires governance hooks concurrently for parallel tool calls. A
    // dispatch reads the per-tick count then records, so interleaved calls race:
    // both read 0 and both clear a cap of 1. decide() must serialize them.
    const rt = mkRuntime({ perTick: 1 });
    const [a, b] = await Promise.all([
      rt.decide("message", { to: "u1" }),
      rt.decide("message", { to: "u2" }),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
    expect([a, b].some((r) => !r.ok && /cap/i.test(r.reason))).toBe(true);
  });

  test("soft-caps repeated contact to the same recipient", async () => {
    const rt = mkRuntime({ recentContactThreshold: 2, perTick: 99 });
    expect((await rt.decide("message", { to: "u1", content: "a" })).ok).toBe(true);
    expect((await rt.decide("message", { to: "u1", content: "b" })).ok).toBe(true);
    const held = await rt.decide("message", { to: "u1", content: "c" });
    expect(held.ok).toBe(false);
    expect(held.reason).toMatch(/recently/i);
  });
});

describe("tools", () => {
  test("goal create -> briefing reflects it -> complete removes it", async () => {
    const rt = mkRuntime();
    const created = parse(
      await rt.tools.goal.execute("id", {
        op: "create",
        title: "Re-engage user",
        objective: "win back",
        reasoning: "signal",
      }),
    );
    expect(created.goal.status).toBe("active");
    const gid = created.goal.id;

    const brief = parse(await rt.tools.briefing.execute());
    expect(brief.goals.some((g: { id: string }) => g.id === gid)).toBe(true);

    await rt.tools.goal.execute("id", { op: "complete", goalId: gid, reasoning: "done" });
    const after = parse(await rt.tools.briefing.execute());
    expect(after.goals.some((g: { id: string }) => g.id === gid)).toBe(false);
  });

  test("goal create requires a title", async () => {
    const rt = mkRuntime();
    const res = parse(await rt.tools.goal.execute("id", { op: "create", reasoning: "x" }));
    expect(res.error).toMatch(/title/i);
  });
});
