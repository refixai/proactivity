import type { Ledger } from "./ledger.js";
import type {
  DispatchRequest,
  DispatchResult,
  GovernanceConfig,
  GovernanceHandle,
  ProactivityStore,
} from "./types.js";

// Recursively sort object keys so equal targets serialize identically
// regardless of key order. A replacer-array on JSON.stringify won't do this —
// it's an allowlist applied at every depth, so nested keys not present at the
// top level get dropped and distinct nested targets collide.
const canonicalize = (value: unknown): unknown =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
      )
    : value;

// Canonical key for an action: same action + target + tick collapses to one
// attempt, so a re-run within a tick is idempotent rather than double-fired.
const deriveIdempotencyKey = (parts: {
  actionType: string;
  target: Record<string, unknown>;
  tickId: string;
}): string =>
  `${parts.actionType}:${JSON.stringify(canonicalize(parts.target))}:${parts.tickId}`;

export const createGovernance = (
  config: GovernanceConfig,
  tickId: string,
  entityId: string,
  ledger: Ledger,
): GovernanceHandle => {
  const { store, caps, softCaps = [], dryRun = false } = config;

  const dispatch = async (request: DispatchRequest): Promise<DispatchResult> => {
    const idempotencyKey = deriveIdempotencyKey({
      actionType: request.actionType,
      target: request.target,
      tickId,
    });

    const tickActionCount = ledger.countActionsTaken();
    if (tickActionCount >= caps.perTick) {
      return await recordDenied(store, {
        ...request,
        tickId,
        idempotencyKey,
        denialReason: `Per-tick cap reached (${caps.perTick})`,
      });
    }

    const passActionCount = ledger.countActionsForPass(request.goalTickId);
    if (passActionCount >= caps.perPass) {
      return await recordDenied(store, {
        ...request,
        tickId,
        idempotencyKey,
        denialReason: `Per-pass cap reached (${caps.perPass})`,
      });
    }

    for (const sc of softCaps) {
      const result = sc.evaluate({
        actionType: request.actionType,
        target: request.target,
        recentAttempts: await store.getRecentAttempts(entityId, { tickWindow: 5 }),
      });
      if (result.triggered && !request.overrideReason) {
        return await recordDenied(store, {
          ...request,
          tickId,
          idempotencyKey,
          denialReason: result.warning ?? `Soft cap "${sc.name}" triggered`,
        });
      }
    }

    const insertResult = await store.insertAttempt({
      goalId: request.goalId,
      tickId,
      goalTickId: request.goalTickId,
      actionType: request.actionType,
      idempotencyKey,
      governanceOutcome: dryRun ? "pending_approval" : "taken",
      reasoning: request.reasoning,
      denialReason: null,
      overrideReason: request.overrideReason ?? null,
      target: request.target,
      payload: request.payload ?? null,
    });

    if (insertResult.kind === "idempotency_conflict") {
      return {
        governanceOutcome: "hard_denied",
        attemptId: insertResult.prior.attemptId,
        idempotencyKey,
        denialReason: `Duplicate: prior attempt ${insertResult.prior.attemptId}`,
      };
    }

    const { attemptId } = insertResult;

    if (dryRun) {
      ledger.record({
        goalId: request.goalId,
        goalTickId: request.goalTickId,
        actionType: request.actionType,
        outcome: "pending_approval",
      });
      return { governanceOutcome: "pending_approval", attemptId, idempotencyKey };
    }

    try {
      await request.perform();
      await store.markAttemptCompleted(attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.markAttemptFailed(attemptId, message);
      return {
        governanceOutcome: "hard_denied",
        attemptId,
        idempotencyKey,
        denialReason: `Side effect failed: ${message}`,
      };
    }

    const outcome = request.overrideReason ? "soft_cap_overridden" : "taken";
    ledger.record({
      goalId: request.goalId,
      goalTickId: request.goalTickId,
      actionType: request.actionType,
      outcome,
    });

    return {
      governanceOutcome: outcome,
      attemptId,
      idempotencyKey,
      overrideReason: request.overrideReason,
    };
  };

  return { dispatch };
};

const recordDenied = async (
  store: ProactivityStore,
  opts: DispatchRequest & {
    tickId: string;
    idempotencyKey: string;
    denialReason: string;
  },
): Promise<DispatchResult> => {
  const result = await store.insertAttempt({
    goalId: opts.goalId,
    tickId: opts.tickId,
    goalTickId: opts.goalTickId,
    actionType: opts.actionType,
    idempotencyKey: opts.idempotencyKey,
    governanceOutcome: "hard_denied",
    reasoning: opts.reasoning,
    denialReason: opts.denialReason,
    overrideReason: null,
    target: opts.target,
    payload: opts.payload ?? null,
  });

  const attemptId = result.kind === "inserted" ? result.attemptId : result.prior.attemptId;

  return {
    governanceOutcome: "hard_denied",
    attemptId,
    idempotencyKey: opts.idempotencyKey,
    denialReason: opts.denialReason,
  };
};
