import { describe, test, expect, afterAll, afterEach } from "vitest";
import { Queue } from "bullmq";
import { createBullMQAdapter } from "./index.js";
import { createScheduler } from "../core/scheduler.js";
import { createTestStore } from "../memory/index.js";
import type { TickResult } from "../core/types.js";

const connection = { host: "localhost", port: 6379 };
const queueName = "proactivity-test";
const queue = new Queue(queueName, { connection });

afterEach(async () => {
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
});

describe("createBullMQAdapter", () => {
  test("enqueue adds a delayed job to the queue", async () => {
    const adapter = createBullMQAdapter({ queueName, connection });

    await adapter.enqueue({ entityId: "e1", delayMs: 60_000, jobId: "j1" });

    const job = await queue.getJob("j1");
    expect(job).toBeTruthy();
    expect(job!.data.entityId).toBe("e1");
    expect(job!.opts.delay).toBe(60_000);
    await adapter.close();
  });

  test("remove deletes a scheduled job", async () => {
    const adapter = createBullMQAdapter({ queueName, connection });

    await adapter.enqueue({ entityId: "e1", delayMs: 60_000, jobId: "j1" });
    await adapter.remove("j1");

    const job = await queue.getJob("j1");
    expect(job).toBeUndefined();
    await adapter.close();
  });

  test("onFire callback fires when job is processed", async () => {
    const adapter = createBullMQAdapter({ queueName, connection });

    const fired: string[] = [];
    adapter.onFire((entityId) => fired.push(entityId));

    await adapter.enqueue({ entityId: "e1", delayMs: 0, jobId: "j-fire" });

    await new Promise((r) => setTimeout(r, 500));

    expect(fired).toEqual(["e1"]);
    await adapter.close();
  });

  test("close shuts down queue and worker", async () => {
    const adapter = createBullMQAdapter({ queueName, connection });
    adapter.onFire(() => {});
    await adapter.close();
  });

  test("scheduler self-reschedules across ticks (same jobId fires repeatedly)", async () => {
    // Regression for the dedup bug: re-adding a completed job's id is a no-op
    // unless removeOnComplete frees it. Without the fix the loop fires exactly
    // once. Driven through createScheduler to also cover the onFire wiring.
    const adapter = createBullMQAdapter({ queueName, connection });
    const store = createTestStore();
    let ticks = 0;
    const scheduler = createScheduler({
      adapter,
      store,
      cadence: { min: 100, max: 1_000, default: 100 },
      identity: (id) => `loop:${id}`,
      onTick: async (): Promise<TickResult> => {
        ticks++;
        return { tickId: `t${ticks}`, status: "completed", goalsWorkedCount: 0, actionsTakenCount: 0, nextCadenceMs: 100 };
      },
    });

    await store.upsertState("e1", { enabled: true });
    await scheduler.start("e1");
    await new Promise((r) => setTimeout(r, 1_500));
    await scheduler.stop("e1");
    await adapter.close();

    expect(ticks).toBeGreaterThanOrEqual(3);
  }, 15_000);
});
