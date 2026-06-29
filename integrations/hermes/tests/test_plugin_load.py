"""The plugin actually loads in real Hermes — two things the fake-`Ctx` tests
can't prove:

1. Loading through Hermes's REAL `_load_plugin` exercises the ctx contract our
   `register()` calls (register_tool/register_middleware signatures). The other
   tests hand-roll a `Ctx`, so a ctx-signature drift would pass there but break
   in production; this catches it.
2. The `hermes_agent.plugins` entry point is installed, so `hermes plugins
   enable proactivity` can find us at all.

Runs in its own process (clean global tool registry). Symbol-level drift in the
internals we import is covered by the other tests' import guards, which now fail
loud rather than skip — so there's no separate "compat" symbol list to maintain.

    pip install hermes-agent
    python3 tests/test_plugin_load.py
"""

from __future__ import annotations

import importlib.metadata as md
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import hermes_cli  # noqa: F401 — base package; its absence is the only legit skip
except Exception:  # noqa: BLE001
    print("skip: hermes-agent not installed")
    sys.exit(0)


def test_plugin_loads_against_the_real_ctx():
    # Loads through Hermes's real _load_plugin, which proves the ctx contract our
    # plugin calls (register_tool/register_middleware signatures) still matches.
    os.environ["HERMES_HOME"] = tempfile.mkdtemp()
    from hermes_cli.plugins import PluginManifest, get_plugin_manager

    mgr = get_plugin_manager()
    mgr._load_plugin(PluginManifest(name="proactivity", source="entrypoint",
                                    path="proactivity_hermes", key="proactivity"))
    err = mgr._plugins["proactivity"].error
    assert err is None, f"plugin failed to load against the real Hermes ctx: {err}"


def test_entry_point_is_discoverable():
    names = {ep.name for ep in md.entry_points(group="hermes_agent.plugins")}
    assert "proactivity" in names, f"entry point not installed; group has {names}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok   {fn.__name__}")
    print(f"\n{len(tests)} passed")
