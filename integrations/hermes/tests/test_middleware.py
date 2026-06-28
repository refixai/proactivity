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
    from tools.registry import tool_result  # real Hermes
    from hermes_cli.plugins import get_plugin_manager
    from hermes_cli.middleware import run_tool_execution_middleware
except Exception:  # noqa: BLE001 — any import failure means Hermes isn't here
    print("skip: Hermes not importable (set PYTHONPATH to a hermes-agent install)")
    sys.exit(0)

import proactivity_hermes as plugin

_TUNABLES = ("PROACTIVITY_RECENT_CONTACT_THRESHOLD", "PROACTIVITY_GOVERNED_TOOLS", "PROACTIVITY_PER_TICK_CAP")


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
    mw = _register(PROACTIVITY_RECENT_CONTACT_THRESHOLD=1)
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
        mw = _register()
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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok   {fn.__name__}")
    print(f"\n{len(tests)} passed")
