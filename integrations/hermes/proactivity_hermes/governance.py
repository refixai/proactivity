"""The governance envelope — a Python port of `@refix/proactivity`'s
`core/governance.ts`, adapted for Hermes.

This is the crown jewel: every outbound action the agent attempts passes
through `dispatch`, which enforces idempotency, a per-tick action cap, and
pluggable soft caps before the side effect runs, and records an audit trail.

It depends only on a store that implements the small attempt-protocol below
(`count_taken_for_tick`, `get_recent_attempts`, `insert_attempt`,
`mark_attempt_completed`, `mark_attempt_failed`) — `SqliteStore` provides it,
but the logic is store-agnostic and unit-testable on its own.

Differences from the TS original, by design:
- No in-memory `Ledger`. In Hermes each governed tool call is an independent
  middleware invocation, so there is no shared per-tick ledger to thread —
  the per-tick count is read from the store.
- No per-pass cap / `goal_tick`. We skip the plan/act split for a personal
  agent (Hermes drives its own loop), so the only cap is per-tick.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence


def idempotency_key(action_type: str, target: dict, tick_id: str) -> str:
    """A canonical key for an action: same action + target + tick collapse to
    one attempt, so a re-run within a tick is idempotent rather than double-fired.

    `sort_keys=True` canonicalizes nested dict key order (array order is kept,
    since it is semantic) — the stdlib equivalent of the TS `canonicalize`.
    """
    body = json.dumps(target, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return f"{action_type}:{body}:{tick_id}"


# A soft cap inspects the action plus recent attempts and returns a warning
# string to hold the action, or None to let it through. `override_reason`
# bypasses all soft caps.
SoftCap = Callable[[str, dict, Sequence[Any]], Optional[str]]


@dataclass
class DispatchRequest:
    action_type: str
    target: dict
    perform: Callable[[], Any]  # runs the real side effect; its return is surfaced
    payload: Any = None
    reasoning: str = ""
    override_reason: Optional[str] = None
    goal_id: Optional[str] = None


@dataclass
class DispatchResult:
    outcome: str  # taken | soft_cap_overridden | hard_denied | pending_approval
    performed: bool
    result: Any = None  # the side effect's own output, when performed
    denial_reason: Optional[str] = None
    attempt_id: Optional[str] = None


class Governance:
    def __init__(
        self,
        store,
        *,
        entity_id: str,
        per_tick_cap: int,
        soft_caps: Optional[Sequence[SoftCap]] = None,
        recent_window: int = 5,
        dry_run: bool = False,
    ):
        self._store = store
        self._entity_id = entity_id
        self._per_tick_cap = per_tick_cap
        self._soft_caps = list(soft_caps or [])
        self._recent_window = recent_window
        self._dry_run = dry_run

    def dispatch(self, tick_id: str, req: DispatchRequest) -> DispatchResult:
        key = idempotency_key(req.action_type, req.target, tick_id)

        # 1. Per-tick cap. Counted from the store because each governed call is
        # an independent middleware invocation — there is no shared ledger.
        if self._store.count_taken_for_tick(self._entity_id, tick_id) >= self._per_tick_cap:
            return self._deny(tick_id, key, req, f"Per-tick cap reached ({self._per_tick_cap})")

        # 2. Soft caps (skipped when the caller supplied an override reason).
        if not req.override_reason:
            recent = self._store.get_recent_attempts(self._entity_id, self._recent_window)
            for cap in self._soft_caps:
                warning = cap(req.action_type, req.target, recent)
                if warning:
                    return self._deny(tick_id, key, req, warning)

        # 3. Reserve the attempt. The UNIQUE idempotency_key turns a duplicate
        # into a conflict, which is how re-runs are deduped.
        outcome = (
            "pending_approval"
            if self._dry_run
            else ("soft_cap_overridden" if req.override_reason else "taken")
        )
        ins = self._store.insert_attempt(
            entity_id=self._entity_id,
            tick_id=tick_id,
            action_type=req.action_type,
            idempotency_key=key,
            governance_outcome=outcome,
            target=req.target,
            payload=req.payload,
            goal_id=req.goal_id,
            reasoning=req.reasoning,
            override_reason=req.override_reason,
        )
        if not ins.inserted:
            return DispatchResult(
                outcome="hard_denied",
                performed=False,
                attempt_id=ins.attempt_id,
                denial_reason=f"Duplicate of prior attempt {ins.attempt_id}",
            )

        # 4. Dry run stops before the side effect, leaving a pending row to approve.
        if self._dry_run:
            return DispatchResult(outcome="pending_approval", performed=False, attempt_id=ins.attempt_id)

        # 5. Perform the real action. Any error is caught and recorded — it never
        # escapes dispatch, so a caller's fail-open path cannot double-fire.
        try:
            result = req.perform()
        except Exception as exc:  # noqa: BLE001 — record and surface, never leak
            self._store.mark_attempt_failed(ins.attempt_id, str(exc))
            return DispatchResult(
                outcome="hard_denied",
                performed=False,
                attempt_id=ins.attempt_id,
                denial_reason=f"Side effect failed: {exc}",
            )
        self._store.mark_attempt_completed(ins.attempt_id)
        return DispatchResult(outcome=outcome, performed=True, result=result, attempt_id=ins.attempt_id)

    def _deny(self, tick_id: str, key: str, req: DispatchRequest, reason: str) -> DispatchResult:
        ins = self._store.insert_attempt(
            entity_id=self._entity_id,
            tick_id=tick_id,
            action_type=req.action_type,
            idempotency_key=key,
            governance_outcome="hard_denied",
            target=req.target,
            payload=req.payload,
            goal_id=req.goal_id,
            reasoning=req.reasoning,
            denial_reason=reason,
        )
        return DispatchResult(
            outcome="hard_denied", performed=False, attempt_id=ins.attempt_id, denial_reason=reason
        )
