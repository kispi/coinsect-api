-- RAG 검색. 2026-09-11 설계(docs/superpowers/specs/2026-09-11-ai-usage-and-rag-design.md §5)
--
--   sudo -u postgres psql -d coinsect -f 002_rag.sql

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS post_chunks (
  id           serial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  post_id      integer NOT NULL,
  board_id     integer NOT NULL,
  chunk_index  integer NOT NULL DEFAULT 0,
  content      text NOT NULL,
  content_hash varchar(64) NOT NULL,
  model        varchar(64) NOT NULL,
  -- null 가능: 청크는 만들었으나 임베딩 전이거나 실패한 상태
  embedding    vector(1536)
);

CREATE UNIQUE INDEX IF NOT EXISTS post_chunks_source_unq ON post_chunks (post_id, chunk_index);
CREATE INDEX IF NOT EXISTS post_chunks_board_idx ON post_chunks (board_id);
CREATE INDEX IF NOT EXISTS post_chunks_embedding_hnsw_idx
  ON post_chunks USING hnsw (embedding vector_cosine_ops);

-- 글 하나에 행 하나가 영구히 남는다. 큐처럼 지우지 않는다 - 지우면 "이미
-- 인덱싱했는가"를 물을 곳이 없어지고 훑기가 매번 전부를 다시 집는다.
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id           serial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  post_id      integer NOT NULL,
  content_hash varchar(64),
  indexed_at   timestamptz,
  status       varchar(20) NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  locked_at    timestamptz,
  locked_by    varchar(100),
  -- 5회 실패해 'failed'가 된 시각. 훑기가 이 시각과 posts.updated_at을 비교해,
  -- 글이 실제로 바뀐 뒤에만 되살린다. indexed_at으로는 이걸 구분 못 한다 -
  -- failed 잡은 indexed_at이 계속 NULL이라 그것만 보면 매 훑기마다 되살아난다.
  failed_at    timestamptz
);

-- CREATE TABLE IF NOT EXISTS는 표가 이미 있으면 안의 컬럼 목록을 보지 않는다.
-- 이전 태스크 때 이 파일을 이미 돌린 상자는 failed_at 없이 표만 남아 있으므로,
-- 파일을 다시 돌려도 컬럼이 안 생겨 인덱서의 문장이 전부 실패한다. 따로 더한다.
ALTER TABLE embedding_jobs ADD COLUMN IF NOT EXISTS failed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS embedding_jobs_post_unq ON embedding_jobs (post_id);
CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx ON embedding_jobs (status, created_at);

-- 차원과 taskType이 키에 함께 들어간다. 같은 텍스트라도 이 둘이 다르면 다른
-- 벡터다. 빠뜨리면 설정을 바꿔도 캐시가 옛 벡터를 돌려주고, 그 벡터는 새로 만든
-- 것들과 같은 공간에 있지 않아 검색이 조용히 망가진다.
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash varchar(64) NOT NULL,
  model        varchar(64) NOT NULL,
  dims         integer NOT NULL,
  task         varchar(1) NOT NULL,
  embedding    vector(1536) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, model, dims, task)
);

-- PostgreSQL 기본 전문검색은 한국어에서 무력하다. 조사와 어미가 붙은 토큰을
-- 갈라내지 못한다. pg_trgm은 부분문자열 기반이라 어간이 남아 있으면 걸린다.
CREATE INDEX IF NOT EXISTS posts_title_trgm_idx ON posts USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS posts_content_trgm_idx ON posts USING gin (content gin_trgm_ops);
