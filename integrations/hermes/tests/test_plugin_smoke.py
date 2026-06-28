"""Integration smoke test — drives the plugin through Hermes's REAL tool
registry and tool-result helpers (no mocks at the seam).

Skips cleanly when Hermes isn't importable, so it's safe to commit and runs in
full once `hermes-agent` is installed:

    pip install hermes-agent
    python3 tests/test_plugin_smoke.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from tools.registry import registry, tool_result  # real Hermes
except Exception:  # noqa: BLE001 — any import failure means Hermes isn't here
    print("skip: Hermes not importable (set PYTHONPATH to a hermes-agent install)")
    sys.exit(0)


def main():
    os.environ["HERMES_HOME"] = tempfile.mkdtemp()  # isolate the sqlite db
    os.environ["PROACTIVITY_PER_TICK_CAP"] = "2"

    import proactivity_hermes as plugin

    captured = {"tools": {}, "middleware": []}

    class Ctx:
        def register_tool(self, name, toolset, schema, handler, **kw):
            # delegate to the REAL registry so dispatch() exercises the real path
            registry.register(
                name, toolset, schema, handler,
                description=kw.get("description", ""), override=kw.get("override", False),
            )
            captured["tools"][name] = handler

        def register_middleware(self, kind, callback):
            captured["middleware"].append((kind, callback))

    plugin.register(Ctx())

    assert set(captured["tools"]) == {"goal", "briefing", "set_cadence"}, captured["tools"]
    assert captured["middleware"] and captured["middleware"][0][0] == "tool_execution"

    # 1) goal tool, dispatched through the real registry
    created = json.loads(
        registry.dispatch(
            "goal",
            {"op": "create", "title": "Re-engage user", "objective": "win back", "reasoning": "signal"},
        )
    )
    gid = created["goal"]["id"]
    assert created["goal"]["status"] == "active", created

    # 2) briefing reflects the new goal
    brief = json.loads(registry.dispatch("briefing", {}))
    assert any(g["id"] == gid for g in brief["goals"]), brief

    # 3) governance middleware: allow, then dedup, then per-tick cap — all via real tool_result
    _, mw = captured["middleware"][0]
    sends = []

    def next_call(a):
        sends.append(a)
        return tool_result(sent=True, to=a.get("target"))

    send = lambda target, msg: json.loads(  # noqa: E731
        mw(tool_name="send_message", args={"target": target, "message": msg}, next_call=next_call)
    )

    a1 = send("telegram:42", "hi")
    assert a1.get("sent") is True, a1

    a2 = send("telegram:42", "hi")  # identical -> idempotent duplicate
    assert a2.get("error") and a2.get("governance") == "hard_denied", a2
    assert len(sends) == 1, "duplicate must not reach next_call"

    a3 = send("telegram:99", "yo")  # 2nd distinct -> reaches the per-tick cap of 2
    assert a3.get("sent") is True, a3

    a4 = send("telegram:7", "hey")  # cap reached -> denied
    assert a4.get("error") and "cap" in a4["error"].lower(), a4
    assert len(sends) == 2, sends

    # 4) briefing surfaces recently governed actions — regression: this used to
    #    crash with AttributeError on `denial_reason` the moment any attempt
    #    existed (the Attempt dataclass was missing the field).
    actions = json.loads(registry.dispatch("briefing", {}))["recent_actions"]
    assert any(a["action"] == "send_message" for a in actions), actions
    assert any(a["outcome"] == "hard_denied" and a["denial_reason"] for a in actions), actions

    print("ok   plugin registers 3 tools + governance middleware")
    print("ok   goal + briefing dispatch through the real Hermes registry")
    print("ok   middleware allows, dedups, and enforces the per-tick cap via real tool_result")
    print("ok   briefing surfaces governed actions after attempts exist (denial_reason regression)")
    print("\nsmoke passed")


if __name__ == "__main__":
    main()
