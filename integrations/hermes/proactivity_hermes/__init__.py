"""@refixai/proactivity — Hermes plugin.

Adds three things a stock Hermes agent lacks: a **governance envelope** over
outbound actions (idempotency + per-tick cap + soft caps + audit trail), a
**durable goal portfolio**, and **self-adjusting cadence**. Hermes already
provides the loop, memory, and scheduler — this plugin layers governance and
goals on top, it does not replace them.

Distributed as a pip package exposing the `hermes_agent.plugins` entry point;
enable with `hermes plugins enable proactivity`.
"""

from __future__ import annotations

import logging
import os
import time

logger = logging.getLogger("proactivity")

_RECENT_WINDOW = 5


def _default_db_path() -> str:
    home = os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    return os.path.join(home, "proactivity.db")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _recent_contact_cap(threshold: int):
    """Soft cap: hold a send when the same recipient has already been contacted
    `threshold`+ times in the recent window. Bypassed by override_reason."""

    def cap(action_type, target, recent):
        who = target.get("target") or target.get("to")
        if who is None:
            return None
        prior = sum(1 for a in recent if (a.target.get("target") or a.target.get("to")) == who)
        if prior >= threshold:
            return (
                f"Soft cap: already contacted {who} {prior}x in the recent window — "
                "supply override_reason to proceed anyway."
            )
        return None

    return cap


def register(ctx) -> None:
    from tools.registry import tool_error

    from .governance import DispatchRequest, Governance
    from .store import SqliteStore
    from .tools import (
        BRIEFING_SCHEMA,
        GOAL_SCHEMA,
        SET_CADENCE_SCHEMA,
        make_briefing_handler,
        make_goal_handler,
        set_cadence_handler,
    )

    entity_id = os.environ.get("PROACTIVITY_ENTITY_ID", "hermes")
    per_tick = _env_int("PROACTIVITY_PER_TICK_CAP", 5)
    tick_seconds = _env_int("PROACTIVITY_TICK_SECONDS", 60)
    contact_threshold = _env_int("PROACTIVITY_RECENT_CONTACT_THRESHOLD", 2)
    dry_run = os.environ.get("PROACTIVITY_DRY_RUN", "").lower() in ("1", "true", "yes")
    governed = {
        t.strip()
        for t in os.environ.get("PROACTIVITY_GOVERNED_TOOLS", "send_message").split(",")
        if t.strip()
    }

    store = SqliteStore(_default_db_path())
    store.migrate()
    governance = Governance(
        store,
        entity_id=entity_id,
        per_tick_cap=per_tick,
        soft_caps=[_recent_contact_cap(contact_threshold)],
        recent_window=_RECENT_WINDOW,
        dry_run=dry_run,
    )

    ctx.register_tool(
        "goal", "proactivity", GOAL_SCHEMA, make_goal_handler(store, entity_id),
        description=GOAL_SCHEMA["description"],
    )
    ctx.register_tool(
        "briefing", "proactivity", BRIEFING_SCHEMA, make_briefing_handler(store, entity_id),
        description=BRIEFING_SCHEMA["description"],
    )
    ctx.register_tool(
        "set_cadence", "proactivity", SET_CADENCE_SCHEMA, set_cadence_handler,
        description=SET_CADENCE_SCHEMA["description"],
    )

    def governance_middleware(*, tool_name, args, next_call, **_):
        # Only wrap the outbound tools we govern; everything else passes straight through.
        if tool_name not in governed:
            return next_call(args)

        # A "tick" is a coarse time bucket — the unit the per-tick cap and the
        # idempotency key are scoped to.
        # ponytail: time-bucket ticks (no session plumbing). Upgrade to
        # session-scoped ticks via an on_session_start hook if exact per-turn
        # semantics are ever needed.
        tick_id = str(int(time.time() // tick_seconds))
        request = DispatchRequest(
            action_type=tool_name,
            target={k: args[k] for k in ("target", "to", "channel", "action", "message") if k in args},
            payload=args,
            perform=lambda: next_call(args),
            # Honour an agent-supplied override so the soft cap's "supply
            # override_reason to proceed" advice is actually actionable.
            override_reason=args.get("override_reason"),
        )
        try:
            result = governance.dispatch(tick_id, request)
        except Exception:  # noqa: BLE001
            # Never block on governance's own failure (Hermes itself fails open).
            # If dispatch raised *after* perform() (e.g. a post-send store write),
            # this re-call hits Hermes's single-use next_call guard and no-ops, so
            # the action still fires at most once.
            # ponytail: fail-open on internal error; add a fail-closed env flag if
            # a deployment ever needs hard guarantees.
            logger.exception("proactivity: governance error; letting the call through")
            return next_call(args)

        if result.performed:
            return result.result
        return tool_error(
            result.denial_reason or "blocked by proactivity governance", governance=result.outcome
        )

    ctx.register_middleware("tool_execution", governance_middleware)
    logger.info(
        "proactivity registered: entity=%s per_tick=%s governed=%s dry_run=%s",
        entity_id, per_tick, sorted(governed), dry_run,
    )
