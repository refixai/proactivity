"""Hermes-facing tools for the proactivity plugin.

Three tools the agent calls like any native tool, each returning a JSON string
(Hermes's tool contract — see `tools.registry`):

  - goal        : manage the durable goal portfolio
  - briefing    : read the portfolio + recently governed actions
  - set_cadence : schedule the next proactive tick via Hermes cron

This module is imported only from `register()`, i.e. only inside a running
Hermes, so the top-level `tools.registry` import is always satisfiable.
"""

from __future__ import annotations

from typing import Callable

from tools.registry import tool_error, tool_result

_GOAL_OPS = ("create", "update", "complete", "archive", "pause", "reprioritize")
_PRIORITIES = ("low", "medium", "high", "critical")

GOAL_SCHEMA = {
    "description": (
        "Manage your durable goals — missions that persist across proactive ticks, each with a "
        "done-condition. Create one when you spot a real signal worth pursuing across ticks; update "
        "findings as you learn; complete or archive to keep the portfolio tight."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "op": {"type": "string", "enum": list(_GOAL_OPS)},
            "goal_id": {"type": "string", "description": "Required for every op except create."},
            "title": {"type": "string", "description": "Required for create."},
            "objective": {"type": "string"},
            "done_condition": {"type": "string", "description": "How you'll know this goal is done."},
            "findings": {"type": "string"},
            "next_actions": {"type": "string"},
            "priority": {"type": "string", "enum": list(_PRIORITIES)},
            "reasoning": {"type": "string", "description": "Why you're making this change."},
        },
        "required": ["op", "reasoning"],
    },
}

BRIEFING_SCHEMA = {
    "description": (
        "Your proactive briefing: the active goal portfolio plus the actions you've recently taken "
        "or been blocked from taking. Call this first on a proactive tick."
    ),
    "parameters": {"type": "object", "properties": {}},
}

SET_CADENCE_SCHEMA = {
    "description": (
        "Set how soon you wake up for your next proactive tick. Accepts 'every 30m', 'every 2h', or "
        "a cron expression (minute granularity). Match the interval to what you're waiting for: your "
        "own follow-through is minutes/hours, a human reply is hours/days, nothing urgent is longer."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "schedule": {"type": "string", "description": "e.g. 'every 1h', 'every 30m', or a cron expression."},
            "reasoning": {"type": "string"},
        },
        "required": ["schedule"],
    },
}


def _validate_goal_mutation(m: dict) -> list[str]:
    errors: list[str] = []
    op = m.get("op")
    if op not in _GOAL_OPS:
        errors.append(f"Unknown op '{op}' (expected one of {', '.join(_GOAL_OPS)})")
    if op != "create" and not m.get("goal_id"):
        errors.append(f"'{op}' requires goal_id")
    if op == "create" and not m.get("title"):
        errors.append("'create' requires title")
    return errors


def make_goal_handler(store, entity_id: str) -> Callable[..., str]:
    def handler(args, **_):
        errors = _validate_goal_mutation(args)
        if errors:
            return tool_error("; ".join(errors))
        goal = store.apply_goal_mutation(entity_id, args)
        if goal is None:
            return tool_error(f"goal '{args.get('goal_id')}' not found")
        return tool_result(goal=goal)

    return handler


def make_briefing_handler(store, entity_id: str) -> Callable[..., str]:
    def handler(args, **_):
        goals = store.list_goals(entity_id, ["active", "paused"])
        recent = store.get_recent_attempts(entity_id, 5)
        actions = [
            {
                "action": a.action_type,
                "outcome": a.governance_outcome,
                "target": a.target,
                "denial_reason": a.denial_reason,
            }
            for a in recent
        ]
        return tool_result(goals=goals, recent_actions=actions)

    return handler


_PROACTIVITY_JOB_NAME = "proactivity-tick"
_TICK_PROMPT = (
    "Proactivity tick. Call `briefing` to review your goal portfolio and recent actions. Investigate "
    "before acting — most ticks should end with no outbound message. Use `goal` to keep the portfolio "
    "tight, and only send when a goal genuinely warrants it (governance enforces your rate limits). "
    "Adjust your next wake with `set_cadence`."
)


def set_cadence_handler(args, **_):
    from cron.jobs import create_job, load_jobs, parse_schedule, update_job

    schedule = (args.get("schedule") or "").strip()
    if not schedule:
        return tool_error("schedule is required (e.g. 'every 1h')")
    try:
        parse_schedule(schedule)
    except Exception as exc:  # noqa: BLE001 — parse_schedule raises ValueError on bad input
        return tool_error(f"Invalid schedule '{schedule}': {exc}")

    # Update the one tick job's schedule IN PLACE so a cadence change keeps the job
    # id (and run history). A drop+recreate hands back a new id, which orphans an
    # in-flight tick from the scheduler's post-run mark_job_run. Create only if none
    # exists yet — set_cadence is the sole creator, so there's never more than one.
    existing = next((j for j in load_jobs() if j.get("name") == _PROACTIVITY_JOB_NAME), None)
    if existing:
        job = update_job(existing["id"], {"schedule": schedule})
    else:
        job = create_job(prompt=_TICK_PROMPT, schedule=schedule, name=_PROACTIVITY_JOB_NAME)
    return tool_result(
        scheduled=True,
        schedule=job.get("schedule_display", schedule),
        next_run_at=job.get("next_run_at"),
    )
