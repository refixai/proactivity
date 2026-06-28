"""Runnable self-check for the governance envelope + store — the non-trivial
logic the plugin is built on. No framework needed:

    python3 tests/test_governance.py

Drives the real SQLite store (in-memory) through the real `Governance` so the
idempotency / cap / soft-cap / failure paths are exercised end to end.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from proactivity_hermes.governance import DispatchRequest, Governance  # noqa: E402
from proactivity_hermes.store import SqliteStore  # noqa: E402


def _gov(per_tick=5, soft_caps=None):
    store = SqliteStore(":memory:")
    store.migrate()
    return store, Governance(
        store, entity_id="t", per_tick_cap=per_tick, soft_caps=soft_caps or []
    )


def test_taken_then_idempotent():
    _, gov = _gov()
    calls = []
    make = lambda: DispatchRequest(  # noqa: E731 — terse on purpose in a test
        action_type="send_message",
        target={"to": "u1", "message": "hi"},
        perform=lambda: (calls.append(1), "sent")[1],
    )
    r1 = gov.dispatch("tick1", make())
    assert r1.performed and r1.outcome == "taken" and r1.result == "sent", r1

    r2 = gov.dispatch("tick1", make())  # same target + tick -> duplicate
    assert not r2.performed and r2.outcome == "hard_denied", r2
    assert "Duplicate" in r2.denial_reason, r2
    assert len(calls) == 1, "perform must fire exactly once for a duplicate"

    r3 = gov.dispatch("tick2", make())  # new tick -> allowed again
    assert r3.performed and len(calls) == 2, r3


def test_per_tick_cap():
    _, gov = _gov(per_tick=2)
    send = lambda n: gov.dispatch(  # noqa: E731
        "tick1", DispatchRequest("send_message", {"to": f"u{n}"}, perform=lambda: "ok")
    )
    assert send(1).performed
    assert send(2).performed
    r3 = send(3)
    assert not r3.performed and "cap" in r3.denial_reason.lower(), r3


def test_soft_cap_recent_contact_and_override():
    def recent_contact(action_type, target, recent):
        to = target.get("to")
        prior = sum(1 for a in recent if a.target.get("to") == to)
        return f"already contacted {to} recently" if prior >= 1 else None

    _, gov = _gov(soft_caps=[recent_contact])
    a = gov.dispatch("t1", DispatchRequest("send_message", {"to": "u1"}, perform=lambda: "ok"))
    assert a.performed, a

    b = gov.dispatch("t2", DispatchRequest("send_message", {"to": "u1"}, perform=lambda: "ok"))
    assert not b.performed and "recently" in b.denial_reason, b

    c = gov.dispatch(
        "t3",
        DispatchRequest("send_message", {"to": "u1"}, perform=lambda: "ok", override_reason="user asked"),
    )
    assert c.performed and c.outcome == "soft_cap_overridden", c


def test_perform_failure_is_recorded():
    _, gov = _gov()

    def boom():
        raise RuntimeError("network down")

    r = gov.dispatch("t1", DispatchRequest("send_message", {"to": "u1"}, perform=boom))
    assert not r.performed and "network down" in r.denial_reason, r


def test_per_tick_cap_resets_next_tick():
    _, gov = _gov(per_tick=2)
    send = lambda tick, n: gov.dispatch(  # noqa: E731
        tick, DispatchRequest("send_message", {"to": f"u{n}"}, perform=lambda: "ok")
    )
    assert send("t1", 1).performed and send("t1", 2).performed
    assert not send("t1", 3).performed, "tick is full at the cap"
    assert send("t2", 4).performed, "a new tick resets the per-tick budget"


def test_dry_run_holds_without_performing():
    store = SqliteStore(":memory:")
    store.migrate()
    gov = Governance(store, entity_id="t", per_tick_cap=5, dry_run=True)
    calls = []
    r = gov.dispatch("t1", DispatchRequest("send_message", {"to": "u1"}, perform=lambda: calls.append(1)))
    assert r.outcome == "pending_approval" and not r.performed, r
    assert not calls, "dry_run must not perform the side effect"


def test_goal_lifecycle():
    store, _ = _gov()
    g = store.apply_goal_mutation(
        "t", {"op": "create", "title": "Re-engage churned user", "objective": "win back", "reasoning": "signal"}
    )
    assert g["status"] == "active" and g["title"] == "Re-engage churned user", g
    assert len(store.list_goals("t", ["active", "paused"])) == 1

    store.apply_goal_mutation("t", {"op": "update", "goal_id": g["id"], "findings": "learned X", "reasoning": "r"})
    assert store.get_goal(g["id"])["findings"] == "learned X"

    store.apply_goal_mutation("t", {"op": "pause", "goal_id": g["id"], "reasoning": "r"})
    assert store.get_goal(g["id"])["status"] == "paused"
    assert len(store.list_goals("t", ["active", "paused"])) == 1, "paused goals still surface"

    store.apply_goal_mutation("t", {"op": "complete", "goal_id": g["id"], "reasoning": "done"})
    assert store.get_goal(g["id"])["status"] == "completed"
    assert store.list_goals("t", ["active", "paused"]) == []


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok   {fn.__name__}")
    print(f"\n{len(tests)} passed")
