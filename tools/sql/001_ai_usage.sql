-- AI 사용량 계측. 2026-09-11 설계(docs/superpowers/specs/2026-09-11-ai-usage-and-rag-design.md §4)
--
--   sudo -u postgres psql -d coinsect -f 001_ai_usage.sql

CREATE TABLE IF NOT EXISTS ai_usage (
  id              serial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  task            varchar(32) NOT NULL,
  model           varchar(64) NOT NULL,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  thinking_tokens integer NOT NULL DEFAULT 0,
  cost_micros     integer NOT NULL DEFAULT 0,
  latency_ms      integer NOT NULL DEFAULT 0,
  ok              boolean NOT NULL DEFAULT true,
  error           text,
  ref_type        varchar(32),
  ref_id          varchar(64),
  requester       varchar(64)
);

CREATE INDEX IF NOT EXISTS ai_usage_task_created_idx ON ai_usage (task, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day             varchar(10) NOT NULL,
  model           varchar(64) NOT NULL,
  task            varchar(32) NOT NULL,
  requests        integer NOT NULL DEFAULT 0,
  failures        integer NOT NULL DEFAULT 0,
  tokens_in       bigint NOT NULL DEFAULT 0,
  tokens_out      bigint NOT NULL DEFAULT 0,
  tokens_thinking bigint NOT NULL DEFAULT 0,
  cost_micros     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, task)
);
