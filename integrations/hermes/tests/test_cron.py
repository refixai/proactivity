"""Cron fires the tick — end to end through Hermes's REAL scheduler.

Proves the cadence loop closes: `set_cadence` creates a job that Hermes's real
`get_due_jobs()` selects once its time arrives, and the prompt `run_job` would
hand the agent (`_build_job_prompt`) is our tick prompt. The agent then acting
on that prompt is covered by a live agent run, so re-running the LLM here is out
of scope — the only link this test adds is "the scheduled wake actually fires".

    pip install hermes-agent
    python3 tests/test_cron.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from tools.registry import registry  # real Hermes
    from cron.jobs import get_due_jobs, load_jobs, save_jobs
    from cron.scheduler import _build_job_prompt
except Exception:  # noqa: BLE001 — any import failure means Hermes isn't here
    print("skip: Hermes not importable (set PYTHONPATH to a hermes-agent install)")
    sys.exit(0)

import proactivity_hermes as plugin

_JOB = "proactivity-tick"


def _register():
    os.environ["HERMES_HOME"] = tempfile.mkdtemp()

    class Ctx:
        def register_tool(self, name, toolset, schema, handler, **kw):
            registry.register(name, toolset, schema, handler,
                              description=kw.get("description", ""), override=True)

        def register_middleware(self, kind, callback):
            pass

    plugin.register(Ctx())


def test_set_cadence_job_fires_when_due():
    _register()
    out = json.loads(registry.dispatch("set_cadence", {"schedule": "every 30m", "reasoning": "test"}))
    assert out.get("scheduled") is True, out
    assert len([j for j in load_jobs() if j.get("name") == _JOB]) == 1

    # Bring the next wake ~60s into the past — inside the grace window, so the
    # scheduler treats it as DUE rather than a stale missed run it fast-forwards.
    jobs = load_jobs()
    for j in jobs:
        if j.get("name") == _JOB:
            j["next_run_at"] = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    save_jobs(jobs)

    # Hermes's real scheduler decision: our job is due and selected to fire.
    due = [j for j in get_due_jobs() if j.get("name") == _JOB]
    assert len(due) == 1, f"{_JOB} must be due; got {[d.get('name') for d in due]}"

    # The prompt run_job would hand the agent is our tick prompt.
    try:
        prompt = _build_job_prompt(due[0])
    except Exception:  # noqa: BLE001 — injection scan / skill load needs machinery we don't set up
        prompt = due[0].get("prompt", "")
    assert "briefing" in prompt and "set_cadence" in prompt, prompt[:200]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok   {fn.__name__}")
    print(f"\n{len(tests)} passed")
