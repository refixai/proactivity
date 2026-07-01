"""Governance middleware behaviours that depend on the real wrapping —
override threading, multi-tool routing, and the fail-open single-use guard.

Skips cleanly when Hermes isn't importable, so it's safe to commit:

    pip install hermes-agent
    python3 tests/test_middleware.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import hermes_cli  # noqa: F401 — base package; its absence is the only legit skip
except Exception:  # noqa: BLE001
    print("skip: hermes-agent not installed")
    sys.exit(0)

# Hermes is installed, so a missing internal below is real version drift — let it
# fail loud instead of masquerading as "Hermes not here" and silently skipping.
from tools.registry import tool_result
from hermes_cli.plugins import get_plugin_manager
from hermes_cli.middleware import run_tool_execution_middleware

import proactivity_hermes as plugin

_TUNABLES = ("PROACTIVITY_RECENT_CONTACT_THRESHOLD", "PROACTIVITY_GOVERNED_TOOLS", "PROACTIVITY_PER_TICK_CAP", "PROACTIVITY_FAIL_CLOSED")


def _register(**env):
    """Register the plugin with the given env against a capturing context (fresh
    HERMES_HOME -> fresh sqlite db) and return its tool_execution callback."""
    os.environ["HERMES_HOME"] = tempfile.mkdtemp()
    for k in _TUNABLES:
        os.environ.pop(k, None)
    for k, v in env.items():
        os.environ[k] = str(v)
    captured = {}

    class Ctx:
        def register_tool(self, *a, **k):
            pass

        def register_middleware(self, kind, callback):
            captured[kind] = callback

    plugin.register(Ctx())
    return captured["tool_execution"]


def test_override_reason_is_honored():
    # The soft cap tells the agent to "supply override_reason to proceed" — the
    # middleware threads it from the tool args so that advice is actionable.
    mw = _register(PROACTIVITY_RECENT_CONTACT_THRESHOLD=1, PROACTIVITY_GOVERNED_TOOLS="send_message")
    sends = []
    nxt = lambda a: (sends.append(a), tool_result(sent=True))[1]  # noqa: E731
    send = lambda args: json.loads(mw(tool_name="send_message", args=args, next_call=nxt))  # noqa: E731

    assert send({"to": "u1", "message": "first"}).get("sent")  # 1st contact
    held = send({"to": "u1", "message": "second"})  # repeat recipient -> soft cap
    assert held.get("error") and "soft cap" in held["error"].lower(), held
    proceeded = send({"to": "u1", "message": "third", "override_reason": "user asked"})
    assert proceeded.get("sent") is True, proceeded  # override bypasses the soft cap
    assert len(sends) == 2, sends


def test_governed_set_routes_multiple_tools():
    mw = _register(PROACTIVITY_GOVERNED_TOOLS="send_message,post_update", PROACTIVITY_PER_TICK_CAP=1)
    sends = []
    nxt = lambda a: (sends.append(a), tool_result(ok=True))[1]  # noqa: E731
    call = lambda tool, args: json.loads(mw(tool_name=tool, args=args, next_call=nxt))  # noqa: E731

    # post_update is governed: 1st taken, 2nd hits the per-tick cap of 1.
    assert call("post_update", {"channel": "c1"}).get("ok")
    denied = call("post_update", {"channel": "c2"})
    assert denied.get("error") and "cap" in denied["error"].lower(), denied
    # read_file is NOT governed: passes straight through regardless of the cap.
    before = len(sends)
    assert call("read_file", {"path": "/x"}).get("ok"), "ungoverned tool must pass through"
    assert len(sends) == before + 1


def _raise_disk_error(self, attempt_id):
    raise RuntimeError("simulated disk error after the send already happened")


def test_fail_open_does_not_double_send():
    # Force the post-perform store write (the line outside dispatch's try) to
    # fail, then drive the send through Hermes's REAL middleware runner. The
    # fail-open re-call hits the single-use next_call guard, so the send still
    # fires at most once — no double-send.
    from proactivity_hermes.store import SqliteStore

    original = SqliteStore.mark_attempt_completed
    SqliteStore.mark_attempt_completed = _raise_disk_error
    try:
        mw = _register(PROACTIVITY_GOVERNED_TOOLS="send_message")
        get_plugin_manager()._middleware["tool_execution"] = [mw]  # exactly our callback
        sends = []
        run_tool_execution_middleware(
            tool_name="send_message",
            args={"to": "u1", "message": "once"},
            next_call=lambda a: sends.append(a) or "delivered",
        )
        assert len(sends) == 1, f"double-send: the send fired {len(sends)}x"
    finally:
        SqliteStore.mark_attempt_completed = original
        get_plugin_manager()._middleware.pop("tool_execution", None)


def _raise_pre_perform(self, *a, **k):
    raise RuntimeError("simulated store failure before the gate decided")


def test_fail_closed_blocks_when_store_is_down():
    # Default is fail-open. With PROACTIVITY_FAIL_CLOSED=1, a store failure in the
    # pre-perform gate (here count_taken_for_tick) must block the send, not let it
    # through. Proves the action never fires and the caller sees a hard denial.
    from proactivity_hermes.store import SqliteStore

    original = SqliteStore.count_taken_for_tick
    SqliteStore.count_taken_for_tick = _raise_pre_perform
    try:
        mw = _register(PROACTIVITY_GOVERNED_TOOLS="send_message", PROACTIVITY_FAIL_CLOSED=1)
        sends = []
        nxt = lambda a: (sends.append(a), tool_result(sent=True))[1]  # noqa: E731
        result = json.loads(mw(tool_name="send_message", args={"to": "u1", "message": "x"}, next_call=nxt))
        assert result.get("error") and "fail-closed" in result["error"].lower(), result
        assert len(sends) == 0, f"fail-closed must not send: fired {len(sends)}x"
    finally:
        SqliteStore.count_taken_for_tick = original


def test_governs_a_real_agent_callable_tool():
    # The default "send_message" is a placeholder stock Hermes never exposes to the
    # model. `discord` IS a registered agent-callable tool (it can POST) — the kind a
    # user should actually govern. Prove the cap fires on the REAL tool name.
    import tools.discord_tool  # noqa: F401 — registers the real `discord` tool
    from tools.registry import registry

    assert "discord" in registry.get_all_tool_names(), "discord must be a real agent tool"
    mw = _register(PROACTIVITY_GOVERNED_TOOLS="discord", PROACTIVITY_PER_TICK_CAP=1)
    sends = []
    nxt = lambda a: (sends.append(a), tool_result(ok=True))[1]  # noqa: E731
    call = lambda args: json.loads(mw(tool_name="discord", args=args, next_call=nxt))  # noqa: E731

    assert call({"action": "create_message", "channel_id": "c1", "message": "hi"}).get("ok")
    capped = call({"action": "create_message", "channel_id": "c1", "message": "again"})
    assert capped.get("error") and "cap" in capped["error"].lower(), capped
    assert len(sends) == 1, sends


def test_phantom_governed_tool_warns():
    # Governing a name the agent can't call (the "send_message" default) would
    # silently do nothing; the middleware must say so out loud on the first tool flow.
    import logging
    import tools.discord_tool  # noqa: F401 — a populated registry makes the check real
    from tools.registry import registry

    assert "send_message" not in registry.get_all_tool_names(), "send_message is a phantom"
    seen = []
    handler = logging.Handler()
    handler.emit = lambda record: seen.append(record.getMessage())  # noqa: E731
    log = logging.getLogger("proactivity")
    log.addHandler(handler)
    log.setLevel(logging.WARNING)
    try:
        mw = _register(PROACTIVITY_GOVERNED_TOOLS="send_message")
        # read_file isn't governed; any tool flow triggers the one-shot phantom check.
        mw(tool_name="read_file", args={"path": "/x"}, next_call=lambda a: tool_result(ok=True))
        assert any("send_message" in m and "not registered" in m for m in seen), seen
    finally:
        log.removeHandler(handler)


def test_distinct_goal_ops_are_not_false_duplicates():
    # Regression: the middleware used to build the idempotency target from a fixed
    # ("target","to","channel","action","message") key set. The `goal` tool carries
    # NONE of those, so every goal op in a tick collapsed to the same key `goal:{}:tick`
    # and the 2nd distinct goal was falsely hard_denied as a duplicate. The target now
    # reflects the action's real identity, so distinct ops stay distinct.
    mw = _register(PROACTIVITY_GOVERNED_TOOLS="goal", PROACTIVITY_PER_TICK_CAP=5)
    taken = []
    nxt = lambda a: (taken.append(a), tool_result(ok=True))[1]  # noqa: E731
    op = lambda args: json.loads(mw(tool_name="goal", args=args, next_call=nxt))  # noqa: E731

    assert op({"op": "create", "title": "Goal A", "reasoning": "a"}).get("ok")
    second = op({"op": "create", "title": "Goal B", "reasoning": "b"})
    assert second.get("ok"), f"distinct goal must not be a false duplicate: {second}"
    assert len(taken) == 2, taken

    # A genuine exact retry within the tick is still deduped (identity unchanged).
    dup = op({"op": "create", "title": "Goal A", "reasoning": "a"})
    assert dup.get("governance") == "hard_denied", dup
    assert len(taken) == 2, "exact retry must not perform again"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok   {fn.__name__}")
    print(f"\n{len(tests)} passed")
