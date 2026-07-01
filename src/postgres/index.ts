import pg from "pg";
import type {
  ActionAttempt,
  EntityState,
  GoalMutation,
  GoalRecord,
  InsertAttempt,
  InsertAttemptResult,
  InsertGoalTick,
  InsertTick,
  InsertTickResult,
  ProactivityStore,
  TickPatch,
  TickRecord,
} from "../core/types.js";

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS proactivity_state (
  entity_id varchar PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  last_tick_at timestamptz,
  next_scheduled_tick_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proactivity_ticks (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id varchar NOT NULL REFERENCES proactivity_state(entity_id),
  tick_number integer NOT NULL,
  trigger varchar NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  status varchar NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  goals_worked_count integer NOT NULL DEFAULT 0,
  actions_taken_count integer NOT NULL DEFAULT 0,
  cadence_hint_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, tick_number)
);

CREATE INDEX IF NOT EXISTS idx_ticks_entity_number ON proactivity_ticks (entity_id, tick_number);
CREATE INDEX IF NOT EXISTS idx_ticks_entity_status ON proactivity_ticks (entity_id, status, started_at);

CREATE TABLE IF NOT EXISTS proactivity_goals (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id varchar NOT NULL REFERENCES proactivity_state(entity_id),
  title text NOT NULL,
  objective text NOT NULL,
  done_condition text NOT NULL,
  findings text NOT NULL DEFAULT '',
  next_actions text,
  creation_reasoning text NOT NULL,
  status varchar NOT NULL DEFAULT 'active',
  priority varchar NOT NULL DEFAULT 'medium',
  last_worked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goals_entity_status ON proactivity_goals (entity_id, status);

CREATE TABLE IF NOT EXISTS proactivity_goal_ticks (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id varchar NOT NULL REFERENCES proactivity_goals(id),
  tick_id varchar NOT NULL REFERENCES proactivity_ticks(id),
  order_index integer NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, tick_id)
);

CREATE INDEX IF NOT EXISTS idx_goal_ticks_tick ON proactivity_goal_ticks (tick_id, order_index);

CREATE TABLE IF NOT EXISTS proactivity_attempts (
  id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id varchar NOT NULL REFERENCES proactivity_goals(id),
  tick_id varchar NOT NULL REFERENCES proactivity_ticks(id),
  goal_tick_id varchar NOT NULL REFERENCES proactivity_goal_ticks(id),
  action_type varchar NOT NULL,
  idempotency_key varchar NOT NULL UNIQUE,
  governance_outcome varchar NOT NULL,
  reasoning text NOT NULL,
  denial_reason text,
  override_reason text,
  target jsonb NOT NULL DEFAULT '{}',
  payload jsonb,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS idx_attempts_tick ON proactivity_attempts (tick_id, governance_outcome);
CREATE INDEX IF NOT EXISTS idx_attempts_goal ON proactivity_attempts (goal_id, attempted_at);
`;

export type PostgresStoreConfig =
  | { connectionString: string }
  | { pool: pg.Pool };

const toEntityState = (row: Record<string, unknown>): EntityState => ({
  entityId: row.entity_id as string,
  enabled: row.enabled as boolean,
  lastTickAt: row.last_tick_at ? new Date(row.last_tick_at as string) : null,
  nextScheduledTickAt: row.next_scheduled_tick_at ? new Date(row.next_scheduled_tick_at as string) : null,
});

const toTickRecord = (row: Record<string, unknown>): TickRecord => ({
  id: row.id as string,
  entityId: row.entity_id as string,
  tickNumber: row.tick_number as number,
  trigger: row.trigger as TickRecord["trigger"],
  dryRun: row.dry_run as boolean,
  status: row.status as TickRecord["status"],
  startedAt: new Date(row.started_at as string),
  completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
  goalsWorkedCount: row.goals_worked_count as number,
  actionsTakenCount: row.actions_taken_count as number,
  cadenceHintMs: row.cadence_hint_ms as number | null,
  error: row.error as string | null,
});

const toGoalRecord = (row: Record<string, unknown>): GoalRecord => ({
  id: row.id as string,
  entityId: row.entity_id as string,
  title: row.title as string,
  objective: row.objective as string,
  doneCondition: row.done_condition as string,
  findings: row.findings as string,
  nextActions: row.next_actions as string | null,
  creationReasoning: row.creation_reasoning as string,
  status: row.status as GoalRecord["status"],
  priority: row.priority as GoalRecord["priority"],
  lastWorkedAt: row.last_worked_at ? new Date(row.last_worked_at as string) : null,
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
});

const toAttempt = (row: Record<string, unknown>): ActionAttempt => ({
  id: row.id as string,
  goalId: row.goal_id as string,
  tickId: row.tick_id as string,
  goalTickId: row.goal_tick_id as string,
  actionType: row.action_type as string,
  idempotencyKey: row.idempotency_key as string,
  governanceOutcome: row.governance_outcome as ActionAttempt["governanceOutcome"],
  reasoning: row.reasoning as string,
  denialReason: row.denial_reason as string | null,
  overrideReason: row.override_reason as string | null,
  target: row.target as Record<string, unknown>,
  payload: row.payload ?? null,
  attemptedAt: new Date(row.attempted_at as string),
  completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
  error: row.error as string | null,
});

export const createPostgresStore = (config: PostgresStoreConfig): ProactivityStore & { end: () => Promise<void> } => {
  const pool = "pool" in config ? config.pool : new pg.Pool({ connectionString: config.connectionString });
  const ownsPool = !("pool" in config);

  const query = (text: string, values?: unknown[]) => pool.query(text, values);

  return {
    // --- Entity State ---

    async getState(entityId) {
      const { rows } = await query("SELECT * FROM proactivity_state WHERE entity_id = $1", [entityId]);
      return rows[0] ? toEntityState(rows[0]) : null;
    },

    async upsertState(entityId, patch) {
      const columns: string[] = [];
      const values: unknown[] = [entityId];
      let idx = 2;

      if (patch.enabled !== undefined) { columns.push("enabled"); values.push(patch.enabled); }
      if (patch.lastTickAt !== undefined) { columns.push("last_tick_at"); values.push(patch.lastTickAt); }
      if (patch.nextScheduledTickAt !== undefined) { columns.push("next_scheduled_tick_at"); values.push(patch.nextScheduledTickAt); }

      const colList = columns.length ? `, ${columns.join(", ")}` : "";
      const valList = columns.length ? `, ${columns.map(() => `$${idx++}`).join(", ")}` : "";
      const updateSet = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
      const updateClause = updateSet ? `${updateSet}, updated_at = now()` : "updated_at = now()";

      await query(
        `INSERT INTO proactivity_state (entity_id${colList})
         VALUES ($1${valList})
         ON CONFLICT (entity_id) DO UPDATE SET ${updateClause}`,
        values,
      );
    },

    // --- Ticks ---

    async insertTick(tick: InsertTick): Promise<InsertTickResult> {
      const { rows } = await query(
        `INSERT INTO proactivity_ticks (entity_id, tick_number, trigger, dry_run)
         VALUES ($1, (SELECT COALESCE(MAX(tick_number), 0) + 1 FROM proactivity_ticks WHERE entity_id = $1::varchar), $2, $3)
         RETURNING id, tick_number, started_at`,
        [tick.entityId, tick.trigger, tick.dryRun],
      );
      return {
        tickId: rows[0].id as string,
        tickNumber: rows[0].tick_number as number,
        startedAt: new Date(rows[0].started_at as string),
      };
    },

    async updateTick(tickId, patch: TickPatch) {
      const setClauses: string[] = [];
      const values: unknown[] = [tickId];
      let idx = 2;

      if (patch.status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(patch.status); }
      if (patch.completedAt !== undefined) { setClauses.push(`completed_at = $${idx++}`); values.push(patch.completedAt); }
      if (patch.goalsWorkedCount !== undefined) { setClauses.push(`goals_worked_count = $${idx++}`); values.push(patch.goalsWorkedCount); }
      if (patch.actionsTakenCount !== undefined) { setClauses.push(`actions_taken_count = $${idx++}`); values.push(patch.actionsTakenCount); }
      if (patch.cadenceHintMs !== undefined) { setClauses.push(`cadence_hint_ms = $${idx++}`); values.push(patch.cadenceHintMs); }
      if (patch.error !== undefined) { setClauses.push(`error = $${idx++}`); values.push(patch.error); }

      if (setClauses.length === 0) return;
      await query(`UPDATE proactivity_ticks SET ${setClauses.join(", ")} WHERE id = $1`, values);
    },

    async getLatestTick(entityId) {
      const { rows } = await query(
        "SELECT * FROM proactivity_ticks WHERE entity_id = $1 ORDER BY tick_number DESC LIMIT 1",
        [entityId],
      );
      return rows[0] ? toTickRecord(rows[0]) : null;
    },

    async getPreviousTickStartedAt(entityId, currentTickNumber) {
      const { rows } = await query(
        "SELECT started_at FROM proactivity_ticks WHERE entity_id = $1 AND tick_number < $2 ORDER BY tick_number DESC LIMIT 1",
        [entityId, currentTickNumber],
      );
      return rows[0] ? new Date(rows[0].started_at as string) : null;
    },

    // --- Goals ---

    async listGoals(entityId, filter) {
      const statusFilter = filter?.status?.length
        ? ` AND status IN (${filter.status.map((_, i) => `$${i + 2}`).join(", ")})`
        : "";
      const { rows } = await query(
        `SELECT * FROM proactivity_goals WHERE entity_id = $1${statusFilter} ORDER BY created_at`,
        [entityId, ...(filter?.status ?? [])],
      );
      return rows.map(toGoalRecord);
    },

    async getGoal(goalId) {
      const { rows } = await query("SELECT * FROM proactivity_goals WHERE id = $1", [goalId]);
      return rows[0] ? toGoalRecord(rows[0]) : null;
    },

    async applyGoalMutations(tickId, mutations: GoalMutation[]) {
      // All-or-nothing: a mid-batch failure must not leave the portfolio half-mutated.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: tickRows } = await client.query("SELECT entity_id FROM proactivity_ticks WHERE id = $1", [tickId]);
        const entityId = tickRows[0]?.entity_id as string ?? "unknown";

        for (const m of mutations) {
          if (m.op === "create") {
            const goalId = m.goalId ?? crypto.randomUUID();
            await client.query(
              `INSERT INTO proactivity_goals (id, entity_id, title, objective, done_condition, findings, next_actions, creation_reasoning, priority)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [goalId, entityId, m.title, m.objective ?? "", m.doneCondition ?? "", m.findings ?? "", m.nextActions ?? null, m.reasoning, m.priority ?? "medium"],
            );
          } else if (m.op === "update") {
            const sets: string[] = ["updated_at = now()"];
            const vals: unknown[] = [m.goalId];
            let i = 2;
            if (m.title !== undefined) { sets.push(`title = $${i++}`); vals.push(m.title); }
            if (m.objective !== undefined) { sets.push(`objective = $${i++}`); vals.push(m.objective); }
            if (m.doneCondition !== undefined) { sets.push(`done_condition = $${i++}`); vals.push(m.doneCondition); }
            if (m.findings !== undefined) { sets.push(`findings = $${i++}`); vals.push(m.findings); }
            if (m.nextActions !== undefined) { sets.push(`next_actions = $${i++}`); vals.push(m.nextActions); }
            if (m.priority !== undefined) { sets.push(`priority = $${i++}`); vals.push(m.priority); }
            // entity_id scope: an LLM-supplied goalId can't reach another entity's goal.
            vals.push(entityId);
            await client.query(`UPDATE proactivity_goals SET ${sets.join(", ")} WHERE id = $1 AND entity_id = $${i}`, vals);
          } else if (m.op === "reprioritize") {
            if (m.priority !== undefined) {
              await client.query("UPDATE proactivity_goals SET priority = $2, updated_at = now() WHERE id = $1 AND entity_id = $3", [m.goalId, m.priority, entityId]);
            }
          } else if (m.op === "complete" || m.op === "archive" || m.op === "pause") {
            const status = m.op === "complete" ? "completed" : m.op === "archive" ? "archived" : "paused";
            await client.query("UPDATE proactivity_goals SET status = $2, updated_at = now() WHERE id = $1 AND entity_id = $3", [m.goalId, status, entityId]);
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async insertGoalTick(entry: InsertGoalTick) {
      const { rows } = await query(
        "INSERT INTO proactivity_goal_ticks (goal_id, tick_id, order_index) VALUES ($1, $2, $3) RETURNING id",
        [entry.goalId, entry.tickId, entry.orderIndex],
      );
      return rows[0].id as string;
    },

    async updateGoalTick(goalTickId, patch) {
      await query(
        "UPDATE proactivity_goal_ticks SET acted = $2, summary = $3 WHERE id = $1",
        [goalTickId, patch.acted, patch.summary],
      );
    },

    // --- Attempts ---

    async insertAttempt(attempt: InsertAttempt): Promise<InsertAttemptResult> {
      try {
        const { rows } = await query(
          `INSERT INTO proactivity_attempts (goal_id, tick_id, goal_tick_id, action_type, idempotency_key, governance_outcome, reasoning, denial_reason, override_reason, target, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [attempt.goalId, attempt.tickId, attempt.goalTickId, attempt.actionType, attempt.idempotencyKey, attempt.governanceOutcome, attempt.reasoning, attempt.denialReason, attempt.overrideReason, JSON.stringify(attempt.target), attempt.payload ? JSON.stringify(attempt.payload) : null],
        );
        return { kind: "inserted", attemptId: rows[0].id as string };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("proactivity_attempts_idempotency_key_key")) {
          const { rows } = await query(
            "SELECT id, governance_outcome FROM proactivity_attempts WHERE idempotency_key = $1",
            [attempt.idempotencyKey],
          );
          return { kind: "idempotency_conflict", prior: { attemptId: rows[0].id as string, outcome: rows[0].governance_outcome } };
        }
        throw err;
      }
    },

    async markAttemptCompleted(attemptId, overrides) {
      if (overrides) {
        await query("UPDATE proactivity_attempts SET completed_at = now(), target = target || $2 WHERE id = $1", [attemptId, JSON.stringify(overrides)]);
      } else {
        await query("UPDATE proactivity_attempts SET completed_at = now() WHERE id = $1", [attemptId]);
      }
    },

    async markAttemptFailed(attemptId, error) {
      await query("UPDATE proactivity_attempts SET error = $2 WHERE id = $1", [attemptId, error]);
    },

    async listAttempts(tickId) {
      const { rows } = await query("SELECT * FROM proactivity_attempts WHERE tick_id = $1 ORDER BY attempted_at", [tickId]);
      return rows.map(toAttempt);
    },

    async getRecentAttempts(entityId, opts) {
      const { rows } = await query(
        `SELECT a.* FROM proactivity_attempts a
         JOIN proactivity_ticks t ON a.tick_id = t.id
         WHERE t.entity_id = $1
           AND t.tick_number > (SELECT COALESCE(MAX(tick_number), 0) - $2 FROM proactivity_ticks WHERE entity_id = $1)
         ORDER BY a.attempted_at`,
        [entityId, opts.tickWindow],
      );
      return rows.map(toAttempt);
    },

    async listSchedulableEntities() {
      const { rows } = await query(
        "SELECT * FROM proactivity_state WHERE enabled = true AND next_scheduled_tick_at IS NOT NULL",
      );
      return rows.map(toEntityState);
    },

    async migrate() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS proactivity_migrations (
            id serial PRIMARY KEY,
            name varchar NOT NULL UNIQUE,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        const { rows } = await client.query("SELECT name FROM proactivity_migrations WHERE name = $1", ["001_initial"]);
        if (rows.length === 0) {
          await client.query(MIGRATION_001);
          await client.query("INSERT INTO proactivity_migrations (name) VALUES ($1)", ["001_initial"]);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async end() {
      // Only close the pool we created. A caller-owned pool ({ pool }) is
      // theirs to manage; closing it here would kill a connection they still use.
      if (ownsPool) await pool.end();
    },
  };
};
