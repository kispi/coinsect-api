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

-- CREATE TABLE IF NOT EXISTS는 표가 이미 있으면 안의 컬럼 목록을 보지 않는다.
-- failures는 이 파일을 한 번 돌린 뒤에 더해진 칸이라, 먼저 돌린 상자에는 표만
-- 있고 칸이 없다. 그대로 두면 야간 rollup의 upsert가 매번 실패한다. 따로 더한다.
ALTER TABLE ai_usage_daily ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;

-- 확장 생성에는 superuser가 필요해 이 파일은 postgres로 돌린다. 그러면 표의 소유자도
-- postgres가 되어 앱 사용자가 접근하지 못한다("permission denied for table ai_usage").
-- 2026-09-11 첫 배포에서 실제로 밟았다. 기존 표들이 전부 앱 사용자 소유이므로 맞춰준다.
-- 앱 DB 사용자가 다르면 이 이름을 바꿀 것.
ALTER TABLE ai_usage OWNER TO coinsect;
ALTER TABLE ai_usage_daily OWNER TO coinsect;
ALTER SEQUENCE ai_usage_id_seq OWNER TO coinsect;
