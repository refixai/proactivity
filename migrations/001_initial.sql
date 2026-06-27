-- proactivity SDK initial schema

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
