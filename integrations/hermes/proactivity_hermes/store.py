"""SQLite-backed store for the Hermes proactivity plugin.

Implements just the subset of `@refix/proactivity`'s `ProactivityStore` that a
personal Hermes agent needs: the **goal** portfolio (durable cross-tick missions)
and the **attempt** ledger that the governance envelope reads and writes. The
tick/scheduler tables from the TS store are intentionally absent — Hermes owns
the loop and the cron schedule.

Lives at `~/.hermes/proactivity.db` by default (a file of our own, not Hermes's
`state.db`, to avoid coupling to another component's schema).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS goals (
  id                 TEXT PRIMARY KEY,
  entity_id          TEXT NOT NULL,
  title              TEXT NOT NULL,
  objective          TEXT NOT NULL DEFAULT '',
  done_condition     TEXT NOT NULL DEFAULT '',
  findings           TEXT NOT NULL DEFAULT '',
  next_actions       TEXT,
  creation_reasoning TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active',
  priority           TEXT NOT NULL DEFAULT 'medium',
  last_worked_at     TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_entity_status ON goals(entity_id, status);

CREATE TABLE IF NOT EXISTS attempts (
  id                 TEXT PRIMARY KEY,
  entity_id          TEXT NOT NULL,
  goal_id            TEXT,
  tick_id            TEXT NOT NULL,
  action_type        TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  governance_outcome TEXT NOT NULL,
  reasoning          TEXT NOT NULL DEFAULT '',
  denial_reason      TEXT,
  override_reason    TEXT,
  target             TEXT NOT NULL,
  payload            TEXT,
  attempted_at       TEXT NOT NULL,
  completed_at       TEXT,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_entity_tick ON attempts(entity_id, tick_id);
CREATE INDEX IF NOT EXISTS idx_attempts_entity_time ON attempts(entity_id, attempted_at);
"""

_TAKEN_OUTCOMES = ("taken", "soft_cap_overridden")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id() -> str:
    return uuid.uuid4().hex[:16]


@dataclass
class InsertResult:
    inserted: bool
    attempt_id: str
    prior_outcome: Optional[str] = None  # set when inserted is False (idempotency conflict)


@dataclass
class Attempt:
    id: str
    entity_id: str
    goal_id: Optional[str]
    tick_id: str
    action_type: str
    idempotency_key: str
    governance_outcome: str
    denial_reason: Optional[str]
    target: dict
    payload: Any
    attempted_at: str
    completed_at: Optional[str]
    error: Optional[str]


class SqliteStore:
    def __init__(self, db_path: str):
        # One connection guarded by a lock: a personal agent has at most the
        # cron-ticker thread and the main loop touching this, so contention is
        # nil and `:memory:` (used by the self-check) needs a stable handle.
        # ponytail: global lock, one connection. Move to a pool only if a single
        # agent ever becomes write-bound — it won't.
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()

    def migrate(self) -> None:
        with self._lock:
            self._db.executescript(_SCHEMA)
            self._db.commit()

    # ------------------------------------------------------------------ goals

    def apply_goal_mutation(self, entity_id: str, m: dict) -> Optional[dict]:
        """Apply one validated goal mutation; returns the resulting goal row.

        Validation (required fields per op) happens in the tool layer before
        this is called.
        """
        op = m["op"]
        now = _now()
        with self._lock:
            if op == "create":
                gid = m.get("goal_id") or _id()
                self._db.execute(
                    "INSERT INTO goals (id, entity_id, title, objective, done_condition, findings, "
                    "next_actions, creation_reasoning, status, priority, last_worked_at, created_at, "
                    "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        gid, entity_id, m.get("title", ""), m.get("objective", ""),
                        m.get("done_condition", ""), m.get("findings", ""), m.get("next_actions"),
                        m.get("reasoning", ""), "active", m.get("priority", "medium"), None, now, now,
                    ),
                )
                self._db.commit()
                return self._get_goal_locked(gid)

            gid = m["goal_id"]
            sets, vals = ["updated_at = ?"], [now]
            if op == "update":
                for col in ("title", "objective", "done_condition", "findings", "next_actions", "priority"):
                    if m.get(col) is not None:
                        sets.append(f"{col} = ?")
                        vals.append(m[col])
            elif op == "reprioritize":
                if m.get("priority") is not None:
                    sets.append("priority = ?")
                    vals.append(m["priority"])
            elif op in ("complete", "archive", "pause"):
                sets.append("status = ?")
                vals.append({"complete": "completed", "archive": "archived", "pause": "paused"}[op])
            vals.append(gid)
            self._db.execute(f"UPDATE goals SET {', '.join(sets)} WHERE id = ?", vals)
            self._db.commit()
            return self._get_goal_locked(gid)

    def get_goal(self, goal_id: str) -> Optional[dict]:
        with self._lock:
            return self._get_goal_locked(goal_id)

    def _get_goal_locked(self, goal_id: str) -> Optional[dict]:
        row = self._db.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        return dict(row) if row else None

    def list_goals(self, entity_id: str, statuses: Optional[list[str]] = None) -> list[dict]:
        with self._lock:
            if statuses:
                placeholders = ",".join("?" * len(statuses))
                rows = self._db.execute(
                    f"SELECT * FROM goals WHERE entity_id = ? AND status IN ({placeholders}) "
                    "ORDER BY created_at",
                    (entity_id, *statuses),
                ).fetchall()
            else:
                rows = self._db.execute(
                    "SELECT * FROM goals WHERE entity_id = ? ORDER BY created_at", (entity_id,)
                ).fetchall()
        return [dict(r) for r in rows]

    # --------------------------------------------------------------- attempts

    def insert_attempt(
        self,
        *,
        entity_id: str,
        tick_id: str,
        action_type: str,
        idempotency_key: str,
        governance_outcome: str,
        target: dict,
        payload: Any = None,
        goal_id: Optional[str] = None,
        reasoning: str = "",
        denial_reason: Optional[str] = None,
        override_reason: Optional[str] = None,
    ) -> InsertResult:
        aid = _id()
        with self._lock:
            try:
                self._db.execute(
                    "INSERT INTO attempts (id, entity_id, goal_id, tick_id, action_type, "
                    "idempotency_key, governance_outcome, reasoning, denial_reason, override_reason, "
                    "target, payload, attempted_at, completed_at, error) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        aid, entity_id, goal_id, tick_id, action_type, idempotency_key,
                        governance_outcome, reasoning, denial_reason, override_reason,
                        json.dumps(target, ensure_ascii=False),
                        json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                        _now(), None, None,
                    ),
                )
                self._db.commit()
                return InsertResult(inserted=True, attempt_id=aid)
            except sqlite3.IntegrityError:
                prior = self._db.execute(
                    "SELECT id, governance_outcome FROM attempts WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
                return InsertResult(
                    inserted=False, attempt_id=prior["id"], prior_outcome=prior["governance_outcome"]
                )

    def mark_attempt_completed(self, attempt_id: str) -> None:
        with self._lock:
            self._db.execute("UPDATE attempts SET completed_at = ? WHERE id = ?", (_now(), attempt_id))
            self._db.commit()

    def mark_attempt_failed(self, attempt_id: str, error: str) -> None:
        with self._lock:
            self._db.execute("UPDATE attempts SET error = ? WHERE id = ?", (error, attempt_id))
            self._db.commit()

    def count_taken_for_tick(self, entity_id: str, tick_id: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS c FROM attempts WHERE entity_id = ? AND tick_id = ? "
                f"AND governance_outcome IN ({','.join('?' * len(_TAKEN_OUTCOMES))})",
                (entity_id, tick_id, *_TAKEN_OUTCOMES),
            ).fetchone()
        return row["c"]

    def get_recent_attempts(self, entity_id: str, tick_window: int) -> list[Attempt]:
        """Attempts from the most recent `tick_window` ticks — what soft caps
        inspect (e.g. "have I contacted this person lately")."""
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM attempts WHERE entity_id = ? AND tick_id IN ("
                "  SELECT tick_id FROM attempts WHERE entity_id = ? "
                "  GROUP BY tick_id ORDER BY MAX(attempted_at) DESC LIMIT ?"
                ") ORDER BY attempted_at DESC",
                (entity_id, entity_id, tick_window),
            ).fetchall()
        return [self._row_to_attempt(r) for r in rows]

    @staticmethod
    def _row_to_attempt(r: sqlite3.Row) -> Attempt:
        return Attempt(
            id=r["id"],
            entity_id=r["entity_id"],
            goal_id=r["goal_id"],
            tick_id=r["tick_id"],
            action_type=r["action_type"],
            idempotency_key=r["idempotency_key"],
            governance_outcome=r["governance_outcome"],
            denial_reason=r["denial_reason"],
            target=json.loads(r["target"]),
            payload=json.loads(r["payload"]) if r["payload"] else None,
            attempted_at=r["attempted_at"],
            completed_at=r["completed_at"],
            error=r["error"],
        )
