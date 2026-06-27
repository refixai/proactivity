import { describe, test, expect, afterAll, afterEach } from "vitest";
import { Queue } from "bullmq";
import { createBullMQAdapter } from "./index.js";

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

  test("reschedule updates delay in place", async () => {
    const adapter = createBullMQAdapter({ queueName, connection });

    await adapter.enqueue({ entityId: "e1", delayMs: 60_000, jobId: "j1" });
    await adapter.reschedule({ jobId: "j1", delayMs: 120_000 });

    const job = await queue.getJob("j1");
    expect(job).toBeTruthy();
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
});
