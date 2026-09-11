# RAG 검색 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 글을 벡터로 인덱싱해, 자유게시판에 하이브리드 검색을 내고 `with_llm`을 회수 기반으로 다시 쓴다.

**Architecture:** 글이 바뀌면 청크로 잘라 임베딩해 `post_chunks`에 넣는다. 무엇을 인덱싱할지는 쓰기 경로에 기대지 않고 `posts.updated_at`을 훑어서 정한다. 검색은 벡터와 키워드를 병렬로 돌려 RRF로 합친다. 임베딩이 없거나 실패해도 키워드 경로가 검색을 살려둔다.

**Tech Stack:** TypeScript, Fastify, TypeORM 0.3, PostgreSQL 16 + pgvector 0.8.5 + pg_trgm 1.6, `@google/genai` 2.16 (`gemini-embedding-001`)

**Spec:** `docs/superpowers/specs/2026-09-11-ai-usage-and-rag-design.md` (§5)

**선행:** `docs/superpowers/plans/2026-09-11-ai-usage-tracking.md`가 먼저 끝나야 한다. 임베딩 비용을 셀 곳이 그 계획에 있다.

## Global Constraints

- 주석과 커밋 메시지는 **한국어**로 쓴다.
- 테스트는 `node:test` + `node:assert/strict`이고 **DB도 외부 API도 타지 않는다.** 타는 함수는 모듈 속성으로 노출해 테스트가 갈아끼운다.
- 실행: `npm test`. 한 파일만: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/<name>.test.ts`
- 임베딩 모델은 `gemini-embedding-001`, 차원은 **1536** 고정이다. 3072은 pgvector HNSW의 2000차원 상한을 넘고, 768은 미세한 구분이 먼저 사라진다.
- 문서는 `RETRIEVAL_DOCUMENT`, 질의는 `RETRIEVAL_QUERY`로 임베딩한다. 섞으면 관련·무관의 점수 간격이 좁아진다.
- 받은 벡터는 **단위 길이로 정규화해 저장한다.** 축소 차원은 사전 정규화가 되어 있지 않다.
- 스키마는 `tools/sql/`의 번호 붙은 `.sql`이다. 모든 문장에 `IF NOT EXISTS`를 붙인다.
- 벡터 칸은 TypeORM 엔티티에 매핑하지 않는다. 읽기와 쓰기는 `dataSource.query`로 간다.
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`를 붙인다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `tools/sql/002_rag.sql` | 확장, 표 셋, 인덱스, `posts`의 trigram 인덱스 |
| `entities/post_chunk.ts` | `post_chunks` (embedding 칸 제외) |
| `entities/embedding_job.ts` | 글당 하나씩 영구히 남는 인덱싱 상태 |
| `services/rag/chunker.ts` | 텍스트를 청크로 자른다. 순수 함수 |
| `services/rag/fusion.ts` | RRF 융합. 순수 함수 |
| `services/rag/embedding.ts` | 모델·차원·정규화·해시·캐시·배치 호출 |
| `services/rag/indexer.ts` | 등록, 훑기, 배수, 삭제, 잠금 |
| `services/rag/keyword.ts` | trigram 키워드 검색 |
| `services/rag/search.ts` | 하이브리드 검색. 벡터 SQL과 융합 |
| `services/post.ts` (수정) | `allWithLLM`을 회수 기반으로, `search`를 더한다 |
| `controllers/post_controller.ts` (수정) | 검색 컨트롤러, 삭제 시 청크 정리 |
| `core/rate_limit.ts` | IP당 속도 제한 |
| `routes.ts` (수정) | `/posts/search` 등록 |
| `services/cron.ts` (수정) | 배수 주기 등록 |
| `tools/backfill_post_embeddings.ts` | 전체 백필 |
| `tools/calibrate_search.ts` | 유사도 컷오프 실측 |

---

### Task 1: 스키마

**Files:**
- Create: `tools/sql/002_rag.sql`, `entities/post_chunk.ts`, `entities/embedding_job.ts`

**Interfaces:**
- Produces: 엔티티 `PostChunk`, `EmbeddingJob`. 표 `post_chunks`, `embedding_jobs`, `embedding_cache`

- [ ] **Step 1: SQL을 쓴다**

`tools/sql/002_rag.sql`:

```sql
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
  locked_by    varchar(100)
);

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
```

- [ ] **Step 2: 엔티티를 쓴다**

`entities/post_chunk.ts`:

```ts
import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

// 글 하나가 청크 여럿이 된다.
//
// embedding 칸은 여기 없다. TypeORM이 pgvector의 vector 타입을 모르기 때문이다.
// 벡터의 읽기와 쓰기는 services/rag의 raw SQL이 담당하고, 이 엔티티는 잡 관리와
// 청크 정리처럼 벡터를 건드리지 않는 일에 쓴다.
@Entity({ name: 'post_chunks' })
@Index(['postId', 'chunkIndex'], { unique: true })
export class PostChunk extends BaseModel {
  @Column()
  postId: number

  // posts 조인 없이 보드로 거르기 위해 중복해 둔다. 글이 보드를 옮기는 일은
  // 없다시피 하고, 있다면 재인덱싱이 같이 고친다.
  @Column()
  @Index()
  boardId: number

  @Column({ default: 0 })
  chunkIndex: number

  @Column({ type: 'text' })
  content: string

  @Column({ length: 64 })
  contentHash: string

  @Column({ length: 64 })
  model: string
}
```

`entities/embedding_job.ts`:

```ts
import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

export type TypeJobStatus = 'pending' | 'running' | 'done' | 'failed'

// 글 하나에 행 하나. 처리한 뒤에도 지우지 않는다 - 이 행이 "언제 무엇으로
// 인덱싱했는가"의 유일한 기록이고, 훑기가 그것을 근거로 다시 집을지 정한다.
@Entity({ name: 'embedding_jobs' })
@Index(['status', 'createdAt'])
export class EmbeddingJob extends BaseModel {
  @Column({ unique: true })
  postId: number

  @Column({ length: 64, nullable: true })
  contentHash: string

  @Column({ type: 'timestamptz', nullable: true })
  indexedAt: Date

  @Column({ length: 20, default: 'pending' })
  status: TypeJobStatus

  @Column({ default: 0 })
  attempts: number

  @Column({ type: 'text', nullable: true })
  lastError: string

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date

  @Column({ length: 100, nullable: true })
  lockedBy: string
}
```

- [ ] **Step 3: 빌드를 확인한다**

Run: `npm run build`
Expected: 오류 없음.

- [ ] **Step 4: 로컬 DB에 올려 본다**

로컬 Postgres가 있으면 돌려 확장이 켜지는지 본다. 없으면 Task 11에서 프로덕션에 올릴 때 확인한다.

Run: `psql -d coinsect -f tools/sql/002_rag.sql`
Expected: `CREATE EXTENSION` 둘, `CREATE TABLE` 셋, 인덱스들.

- [ ] **Step 5: 커밋**

```bash
git add tools/sql/002_rag.sql entities/post_chunk.ts entities/embedding_job.ts
git commit -m "$(cat <<'EOF'
feat: RAG 스키마를 만든다

post_chunks에 HNSW, posts에 trigram GIN을 건다. embedding_jobs는 큐가
아니라 글당 하나씩 영구히 남는 인덱싱 상태다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 청킹

**Files:**
- Create: `services/rag/chunker.ts`, `tests/rag_chunker.test.ts`

**Interfaces:**
- Produces: `chunkText(text: string, maxChunkSize?: number, overlap?: number): string[]` (기본 800, 120)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_chunker.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../services/rag/chunker'

test('상한보다 짧으면 통째로 한 조각이다', () => {
  assert.deepEqual(chunkText('짧은 글이다.'), ['짧은 글이다.'])
})

test('빈 입력은 조각이 없다', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n\n  '), [])
})

test('단락 경계로 자른다', () => {
  const a = '가'.repeat(60)
  const b = '나'.repeat(60)
  const chunks = chunkText(`${a}\n\n${b}`, 100, 0)

  assert.equal(chunks.length, 2)
  assert.equal(chunks[0], a)
  assert.equal(chunks[1], b)
})

test('한 단락이 상한을 넘으면 문장으로 쪼갠다', () => {
  const para = `${'가'.repeat(80)}. ${'나'.repeat(80)}.`
  const chunks = chunkText(para, 100, 0)

  assert.ok(chunks.length >= 2)
  chunks.forEach(chunk => assert.ok(chunk.length <= 120, `조각이 너무 길다: ${chunk.length}`))
})

test('겹침이 앞 조각의 꼬리를 다음 조각 머리에 붙인다', () => {
  // 겹침이 없으면 경계에 걸린 내용이 양쪽 어디에서도 온전하지 않다. 주제어는
  // 앞 조각에, 사실은 뒤 조각에 남아 뒤 조각의 임베딩에 주제 신호가 안 들어간다.
  const a = '워크숍 정산 이야기'
  const b = '총액은 96만원이었다'
  const chunks = chunkText(`${a}\n\n${b}`, 20, 10)

  assert.equal(chunks.length, 2)
  assert.ok(chunks[1].includes(b))
  assert.ok(chunks[1].length > b.length, '두 번째 조각에 앞 조각의 꼬리가 붙어야 한다')
})

test('겹침 조각은 단어 중간에서 시작하지 않는다', () => {
  const chunks = chunkText(`aaa bbb ccc ddd\n\neee fff`, 16, 8)
  // 꼬리를 자른 뒤 첫 공백까지를 버려 온전한 경계에서 시작한다.
  assert.ok(!/^\S*\s/.test(chunks[1]) || chunks[1].startsWith('ccc') || chunks[1].startsWith('ddd'))
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_chunker.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 구현한다**

`services/rag/chunker.ts`:

```ts
// 긴 본문을 단락 경계로 자른다. 부수효과가 없어 테스트가 쉽다.

// 앞 조각의 꼬리에서 겹침으로 쓸 부분을 떼어낸다.
//
// 마지막 N자를 그냥 자르면 단어 중간에서 시작하는 조각이 나온다. 그 조각은
// 임베딩에 잡음으로 들어간다. 잘라낸 뒤 첫 공백까지를 버려 온전한 경계에서
// 시작하게 한다. 공백이 없으면(한국어처럼 띄어쓰기가 드문 경우) 자른 그대로
// 쓴다 - 문맥을 잃는 것보다는 낫다.
const overlapTail = (prev: string, overlap: number): string => {
  if (overlap <= 0 || !prev) return ''
  if (prev.length <= overlap) return prev

  const tail = prev.slice(-overlap)
  const firstSpace = tail.search(/\s/)
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1)
}

// 각 조각 머리에 앞 조각의 꼬리를 붙인다. 겹침만큼 상한을 넘어서는 것은 의도된 동작이다.
const applyOverlap = (chunks: string[], overlap: number): string[] => {
  if (overlap <= 0 || chunks.length <= 1) return chunks

  return chunks.map((chunk, i) => {
    if (i === 0) return chunk
    const tail = overlapTail(chunks[i - 1], overlap)
    return tail ? `${tail}\n\n${chunk}` : chunk
  })
}

// 겹침은 조각 크기의 15% 남짓이 기본이다. 더 키우면 저장량과 임베딩 호출이
// 그만큼 늘고, 0으로 두면 경계에서 문맥이 끊긴다.
export const chunkText = (text: string, maxChunkSize = 800, overlap = 120): string[] => {
  const trimmed = (text || '').trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChunkSize) return [trimmed]

  const chunks: string[] = []
  let current = ''

  for (const para of trimmed.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue

    if ((current ? `${current}\n\n${p}` : p).length <= maxChunkSize) {
      current = current ? `${current}\n\n${p}` : p
      continue
    }

    if (current) chunks.push(current)

    if (p.length > maxChunkSize) {
      let temp = ''
      for (const s of p.split(/(?<=[.!?\n])\s+/)) {
        if ((temp ? `${temp} ${s}` : s).length <= maxChunkSize) {
          temp = temp ? `${temp} ${s}` : s
        } else {
          if (temp) chunks.push(temp)
          temp = s
        }
      }
      current = temp
    } else {
      current = p
    }
  }

  if (current) chunks.push(current)

  return applyOverlap(chunks, overlap)
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add services/rag/chunker.ts tests/rag_chunker.test.ts
git commit -m "$(cat <<'EOF'
feat: 본문을 단락 경계로 자르는 청커를 만든다

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: RRF 융합

**Files:**
- Create: `services/rag/fusion.ts`, `tests/rag_fusion.test.ts`

**Interfaces:**
- Produces: `RRF_K = 60`, `FusedItem<T> = { item: T, rrfScore: number, sources: number[] }`, `fuseRRF<T>(lists: T[][], keyOf: (item: T) => string): FusedItem<T>[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_fusion.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuseRRF, RRF_K } from '../services/rag/fusion'

const id = (o: { id: string }) => o.id

test('양쪽 리스트에 다 있는 항목이 위로 온다', () => {
  const a = [{ id: 'x' }, { id: 'y' }]
  const b = [{ id: 'z' }, { id: 'x' }]

  const fused = fuseRRF([a, b], id)

  assert.equal(fused[0].item.id, 'x')
  assert.deepEqual(fused[0].sources, [0, 1])
  // 1/(60+1) + 1/(60+2)
  assert.ok(Math.abs(fused[0].rrfScore - (1 / (RRF_K + 1) + 1 / (RRF_K + 2))) < 1e-12)
})

test('한 리스트에만 있으면 그 순위만큼의 점수를 갖는다', () => {
  const fused = fuseRRF([[{ id: 'a' }, { id: 'b' }]], id)

  assert.equal(fused[0].item.id, 'a')
  assert.deepEqual(fused[1].sources, [0])
})

test('먼저 등장한 리스트의 객체를 유지한다', () => {
  // 부르는 쪽이 정보량이 많은 리스트를 먼저 넘기면 그쪽이 남는다.
  const rich = [{ id: 'x', score: 0.9 }]
  const poor = [{ id: 'x' }]

  const fused = fuseRRF<{ id: string, score?: number }>([rich, poor], id)

  assert.equal(fused[0].item.score, 0.9)
})

test('동점이면 먼저 등장한 순서를 지킨다', () => {
  const fused = fuseRRF([[{ id: 'a' }], [{ id: 'b' }]], id)

  assert.equal(fused[0].rrfScore, fused[1].rrfScore)
  assert.equal(fused[0].item.id, 'a')
})

test('빈 리스트는 빈 결과다', () => {
  assert.deepEqual(fuseRRF([[], []], id), [])
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_fusion.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/rag/fusion.ts`:

```ts
// Reciprocal Rank Fusion.
//
// 점수 체계가 다른 결과를 합칠 때 점수 자체를 정규화하려 들면 실패한다. 코사인
// 유사도는 0.68~0.9의 좁은 구간에 몰려 있고 키워드 매칭에는 애초에 점수가 없다.
// RRF는 점수를 버리고 순위만 써서 이 문제를 피한다.
//
// K는 상위권의 영향력을 얼마나 눌러줄지를 정한다. 60은 원 논문 이래의 관례값으로,
// 1등과 2등의 격차를 완만하게 만들어 한쪽 리스트가 결과를 독점하지 못하게 한다.
export const RRF_K = 60

export interface FusedItem<T> {
  item: T
  rrfScore: number
  // 이 항목이 등장한 입력 리스트의 인덱스들
  sources: number[]
}

// keyOf가 같은 값을 주는 항목은 동일한 것으로 보고 합산한다. 결과 객체는 가장
// 먼저 등장한 리스트의 것을 유지한다 - 부르는 쪽이 정보량이 많은 리스트를 먼저
// 넘기면 자연스럽게 그쪽이 남는다.
export const fuseRRF = <T>(lists: T[][], keyOf: (item: T) => string): FusedItem<T>[] => {
  const byKey = new Map<string, FusedItem<T>>()
  // Map은 삽입 순서를 보존한다. 동점일 때 이 순서가 안정 정렬의 기준이 된다.
  const order: string[] = []

  lists.forEach((list, listIndex) => {
    list.forEach((item, position) => {
      const key = keyOf(item)
      const contribution = 1 / (RRF_K + position + 1)
      const existing = byKey.get(key)

      if (existing) {
        existing.rrfScore += contribution
        if (!existing.sources.includes(listIndex)) existing.sources.push(listIndex)
        return
      }

      byKey.set(key, { item, rrfScore: contribution, sources: [listIndex] })
      order.push(key)
    })
  })

  return order.map(key => byKey.get(key)).sort((a, b) => b.rrfScore - a.rrfScore)
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_fusion.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add services/rag/fusion.ts tests/rag_fusion.test.ts
git commit -m "$(cat <<'EOF'
feat: 순위만 써서 결과를 합치는 RRF 융합을 만든다

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 임베딩 모듈

**Files:**
- Create: `services/rag/embedding.ts`, `tests/rag_embedding.test.ts`

**Interfaces:**
- Consumes: `aiUsage.record` (A 계획 Task 3)
- Produces:
  - `EMBEDDING_MODEL = 'gemini-embedding-001'`, `EMBEDDING_DIMS = 1536`, `EMBED_BATCH_SIZE`
  - `TypeEmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'`
  - `computeHash(text: string): string`
  - `normalize(v: number[]): number[]`
  - `cacheTaskOf(task: TypeEmbedTask): 'd' | 'q'`
  - `estimateTokens(text: string): number`
  - `embedding.callApi(texts: string[], task): Promise<number[][]>` — API를 타는 유일한 지점
  - `embedding.embed(texts: string[], task): Promise<(number[] | null)[]>` — 캐시 조회, 배치 호출, 캐시 적재, 계측까지

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_embedding.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import embedding, {
  computeHash,
  normalize,
  cacheTaskOf,
  estimateTokens,
  EMBEDDING_DIMS,
} from '../services/rag/embedding'

test('정규화하면 길이가 1이 된다', () => {
  // 축소 차원은 사전 정규화가 되어 있지 않다. 안 하면 코사인 거리가 어긋난다.
  const v = normalize([3, 4])
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12)
})

test('영벡터는 그대로 둔다', () => {
  assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0])
})

test('해시는 앞뒤 공백을 무시한다', () => {
  assert.equal(computeHash('  같은 글  '), computeHash('같은 글'))
  assert.notEqual(computeHash('가'), computeHash('나'))
})

test('캐시 태스크 표시가 문서와 질의를 가른다', () => {
  assert.equal(cacheTaskOf('RETRIEVAL_DOCUMENT'), 'd')
  assert.equal(cacheTaskOf('RETRIEVAL_QUERY'), 'q')
})

test('캐시에 있는 것은 API를 타지 않는다', async () => {
  const vec = new Array(EMBEDDING_DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))
  let apiCalls = 0

  const originals = { api: embedding.callApi, get: embedding.getCached, put: embedding.putCached }
  embedding.getCached = (async hashes => new Map([[hashes[0], vec]])) as never
  embedding.callApi = (async texts => { apiCalls += 1; return texts.map(() => vec) }) as never
  embedding.putCached = (async () => {}) as never

  try {
    const out = await embedding.embed(['캐시에 있는 글'], 'RETRIEVAL_DOCUMENT')
    assert.equal(apiCalls, 0, '캐시가 맞으면 API를 부르지 않는다')
    assert.deepEqual(out[0], vec)
  } finally {
    embedding.callApi = originals.api
    embedding.getCached = originals.get
    embedding.putCached = originals.put
  }
})

test('캐시에 없는 것만 API로 보내고 순서를 지켜 돌려준다', async () => {
  const hit = new Array(EMBEDDING_DIMS).fill(0.1)
  const miss = new Array(EMBEDDING_DIMS).fill(0.2)
  let sent: string[] = []

  const originals = { api: embedding.callApi, get: embedding.getCached, put: embedding.putCached }
  embedding.getCached = (async () => new Map([[computeHash('있는 것'), hit]])) as never
  embedding.callApi = (async texts => { sent = texts; return texts.map(() => miss) }) as never
  embedding.putCached = (async () => {}) as never

  try {
    const out = await embedding.embed(['있는 것', '없는 것'], 'RETRIEVAL_DOCUMENT')
    assert.deepEqual(sent, ['없는 것'], '캐시에 없는 것만 보낸다')
    assert.deepEqual(out[0], hit)
    assert.deepEqual(out[1], miss)
  } finally {
    embedding.callApi = originals.api
    embedding.getCached = originals.get
    embedding.putCached = originals.put
  }
})

test('API가 실패하면 던지지 않고 null을 채워 준다', async () => {
  // 임베딩이 안 되어도 하이브리드 검색의 키워드 경로는 계속 동작해야 한다.
  const originals = { api: embedding.callApi, get: embedding.getCached, put: embedding.putCached }
  embedding.getCached = (async () => new Map()) as never
  embedding.callApi = (async () => { throw new Error('API가 죽었다') }) as never
  embedding.putCached = (async () => {}) as never

  try {
    const out = await embedding.embed(['무엇이든'], 'RETRIEVAL_QUERY')
    assert.deepEqual(out, [null])
  } finally {
    embedding.callApi = originals.api
    embedding.getCached = originals.get
    embedding.putCached = originals.put
  }
})

test('토큰 추정은 글자 수에 비례한다', () => {
  assert.ok(estimateTokens('가'.repeat(150)) > estimateTokens('가'.repeat(15)))
  assert.ok(estimateTokens('') === 0)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_embedding.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/rag/embedding.ts`:

```ts
import { createHash } from 'crypto'
import { GoogleGenAI } from '@google/genai'
import { dataSource } from '../../database'
import { log } from '../../core/logger'
import store from '../../store'
import aiUsage from '../ai_usage'

// 3072이 원본이지만 pgvector의 HNSW 인덱스는 2000차원이 상한이라 1536으로 뽑는다.
// 768로 줄이면 미세한 구분이 먼저 사라지고 굵은 주제 축만 남아, 무관한 문서끼리도
// 점수가 붙는다.
export const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMS = 1536

// 한 요청에 묶어 보낼 청크 수. embedContent의 contents는 배열을 받고 embeddings를
// 넣은 순서 그대로 돌려준다. 하나씩 치면 6,000청크가 6,000요청이다.
//
// 이 값은 모델마다 다른 상한에 걸릴 수 있다. 400이 나면 줄일 것.
// (2026-09-11 구현 시 실제 호출로 확인한 값: 여기에 적는다)
export const EMBED_BATCH_SIZE = 32

export type TypeEmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

// 문서와 질의는 다른 벡터를 만든다. 섞으면 관련·무관의 점수 간격이 좁아진다.
export const cacheTaskOf = (task: TypeEmbedTask) => (task === 'RETRIEVAL_QUERY' ? 'q' : 'd')

export const computeHash = (text: string) => createHash('sha256').update((text || '').trim()).digest('hex')

// 축소 차원은 사전 정규화가 되어 있지 않다. 안 하면 코사인 거리 연산이 어긋난다.
export const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? v : v.map(x => x / norm)
}

// 임베딩 응답에는 생성 호출과 달리 usageMetadata가 없다. 비용을 세려면 추정해야 한다.
// 한국어는 대략 1.5자에 1토큰이다. 정확한 값이 아니라 자릿수를 맞추는 용도다.
export const estimateTokens = (text: string) => Math.ceil((text || '').length / 1.5)

const vectorLiteral = (v: number[]) => `[${v.join(',')}]`

const embedding = {
  // API를 타는 유일한 지점. 테스트가 갈아끼운다.
  callApi: async (texts: string[], task: TypeEmbedTask): Promise<number[][]> => {
    const genAI = new GoogleGenAI({ apiKey: store.state.serverConfig.GOOGLE_AI_STUDIO })
    const result = await genAI.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: { outputDimensionality: EMBEDDING_DIMS, taskType: task },
    })

    return (result.embeddings || []).map(e => normalize(e.values || []))
  },

  getCached: async (hashes: string[], task: TypeEmbedTask): Promise<Map<string, number[]>> => {
    if (!hashes.length) return new Map()

    const rows = await dataSource.query(
      `SELECT content_hash, embedding::text AS embedding FROM embedding_cache
       WHERE model = $1 AND dims = $2 AND task = $3 AND content_hash = ANY($4)`,
      [EMBEDDING_MODEL, EMBEDDING_DIMS, cacheTaskOf(task), hashes],
    )

    return new Map(rows.map(r => [
      r.content_hash,
      JSON.parse(r.embedding) as number[],
    ]))
  },

  putCached: async (entries: { hash: string, vector: number[] }[], task: TypeEmbedTask) => {
    for (const { hash, vector } of entries) {
      await dataSource.query(
        `INSERT INTO embedding_cache (content_hash, model, dims, task, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (content_hash, model, dims, task) DO NOTHING`,
        [hash, EMBEDDING_MODEL, EMBEDDING_DIMS, cacheTaskOf(task), vectorLiteral(vector)],
      )
    }
  },

  // 캐시를 먼저 보고, 없는 것만 배치로 친다. 입력 순서 그대로 돌려준다.
  // 실패하면 던지지 않고 그 자리에 null을 둔다 - 임베딩이 안 되어도 검색의
  // 키워드 경로는 계속 동작해야 한다.
  embed: async (texts: string[], task: TypeEmbedTask, aiTask: 'embed_index' | 'embed_query' = 'embed_index') => {
    const hashes = texts.map(computeHash)
    const cached = await embedding.getCached(hashes, task).catch(e => {
      log.error('embedding 캐시 조회 실패', e)
      return new Map<string, number[]>()
    })

    const out: (number[] | null)[] = texts.map((_, i) => cached.get(hashes[i]) || null)
    const missing = texts
      .map((text, i) => ({ text, i, hash: hashes[i] }))
      .filter(o => !out[o.i])

    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE)
      const startedAt = Date.now()

      try {
        const vectors = await embedding.callApi(batch.map(o => o.text), task)

        batch.forEach((o, k) => { out[o.i] = vectors[k] || null })
        await embedding.putCached(
          batch.map((o, k) => ({ hash: o.hash, vector: vectors[k] })).filter(o => o.vector),
          task,
        )

        // 행은 요청당 하나다. 청크마다 남기면 호출 수가 실제와 어긋난다.
        void aiUsage.record({
          task: aiTask,
          model: EMBEDDING_MODEL,
          inputTokens: batch.reduce((sum, o) => sum + estimateTokens(o.text), 0),
          latencyMs: Date.now() - startedAt,
        })
      } catch (e) {
        log.error('embedding 호출 실패', e)
        void aiUsage.record({
          task: aiTask,
          model: EMBEDDING_MODEL,
          latencyMs: Date.now() - startedAt,
          ok: false,
          error: (e || {}).message || String(e),
        })
      }
    }

    return out
  },
}

export default embedding
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: 배치 상한을 실제 호출로 확인한다**

이 단계는 **API 키가 필요하고 실제 호출을 한다.** 스크립트를 임시로 만들어 32, 100, 250을 차례로 넣어 본다.

```bash
GOOGLE_AI_STUDIO=<키> npx ts-node -e "
  const e = require('./services/rag/embedding').default
  const n = Number(process.env.N || 32)
  e.callApi(Array.from({length: n}, (_, i) => '테스트 문장 ' + i), 'RETRIEVAL_DOCUMENT')
    .then(v => console.log(n, '성공', v.length, '차원', v[0].length))
    .catch(err => console.log(n, '실패', err.message))
"
```

**확인한 상한을 `EMBED_BATCH_SIZE` 주석에 날짜와 함께 적는다.** 기억이 아니라 측정이 근거여야 한다.

- [ ] **Step 6: 커밋**

```bash
git add services/rag/embedding.ts tests/rag_embedding.test.ts
git commit -m "$(cat <<'EOF'
feat: 캐시와 배치를 쓰는 임베딩 모듈을 만든다

문서와 질의가 같은 캐시를 쓴다. 차원과 taskType이 캐시 키에 함께 들어가지
않으면 설정을 바꿔도 옛 벡터가 돌아온다. 실패는 던지지 않고 null이다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 인덱서

**Files:**
- Create: `services/rag/indexer.ts`, `tests/rag_indexer.test.ts`
- Modify: `services/cron.ts`

**Interfaces:**
- Consumes: `chunkText` (Task 2), `embedding.embed`, `computeHash` (Task 4), `core/cache`의 `hSetNX`/`hGetAll`/`hDel`
- Produces:
  - `INDEXED_BOARD_IDS = [1, 3, 4]`
  - `indexer.enqueue(postId: number): Promise<void>`
  - `indexer.sweep(limit?: number): Promise<number>` — 인덱싱이 필요한 글을 잡으로 만든다
  - `indexer.drain(limit?: number): Promise<number>` — 처리한 잡 수
  - `indexer.removeChunks(postId: number): Promise<void>`
  - `indexer.withLock<T>(fn: () => Promise<T>): Promise<T | null>` — 이미 돌고 있으면 null

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_indexer.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import indexer from '../services/rag/indexer'
import useCache from '../core/cache'

const cache = useCache()
const LOCK_KEY = 'rag:locks'

const unlocked = async () => { await cache.hDel(LOCK_KEY, 'drain') }

test('배수는 한 번에 하나만 돈다', async () => {
  await unlocked()

  let running = 0
  let maxConcurrent = 0
  const body = async () => {
    running += 1
    maxConcurrent = Math.max(maxConcurrent, running)
    await new Promise(r => setTimeout(r, 20))
    running -= 1
    return 'done'
  }

  const [a, b] = await Promise.all([indexer.withLock(body), indexer.withLock(body)])

  // 둘이 동시에 들어오면 하나는 잠금을 못 얻고 null로 빠진다. 안 막으면 같은 잡을
  // 둘이 잡아 임베딩 비용이 두 배가 된다.
  assert.equal(maxConcurrent, 1)
  assert.equal([a, b].filter(o => o === 'done').length, 1)
  assert.equal([a, b].filter(o => o === null).length, 1)
})

test('5분 지난 잠금은 죽은 것으로 보고 뺏는다', async () => {
  await unlocked()
  // 해시 필드에는 개별 만료가 없다. 배수 도중 프로세스가 죽으면 잠금이 영원히 남는다.
  const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString()
  await cache.hSet(LOCK_KEY, 'drain', sixMinutesAgo)

  const result = await indexer.withLock(async () => 'done')

  assert.equal(result, 'done')
  await unlocked()
})

test('잠금은 본문이 던져도 풀린다', async () => {
  await unlocked()

  await assert.rejects(() => indexer.withLock(async () => { throw new Error('터졌다') }))
  // 안 풀리면 다음 배수가 영원히 못 돈다.
  assert.equal(await indexer.withLock(async () => 'done'), 'done')
  await unlocked()
})

test('글이 짧아지면 남는 꼬리 청크를 지운다', async () => {
  const deleted: unknown[] = []
  const originals = { chunks: indexer.replaceChunks }
  indexer.replaceChunks = (async (postId, boardId, rows) => {
    deleted.push({ postId, keep: rows.length })
  }) as never

  try {
    await indexer.replaceChunks(7, 1, [{ content: 'a', hash: 'h', vector: null }])
  } finally {
    indexer.replaceChunks = originals.chunks
  }

  assert.equal(deleted[0]['keep'], 1)
})

test('같은 잡을 두 번 처리해도 청크가 중복되지 않는다', async () => {
  // (post_id, chunk_index) 유니크가 보장하지만, upsert 구문이 맞는지 눈으로 본다.
  const sql: string[] = []
  const original = indexer.query
  indexer.query = (async (text: string) => { sql.push(text); return [] }) as never

  try {
    await indexer.replaceChunks(7, 1, [{ content: 'a', hash: 'h', vector: [0.1] }])
  } finally {
    indexer.query = original
  }

  assert.ok(sql.some(s => /ON CONFLICT \(post_id, chunk_index\) DO UPDATE/.test(s)))
  assert.ok(sql.some(s => /chunk_index >=/.test(s)), '남는 꼬리를 지우는 문장이 있어야 한다')
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_indexer.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/rag/indexer.ts`:

```ts
import { dataSource } from '../../database'
import { log } from '../../core/logger'
import useCache from '../../core/cache'
import { chunkText } from './chunker'
import embedding, { computeHash, EMBEDDING_MODEL } from './embedding'

const cache = useCache()

// 인덱싱 대상 보드. 자유게시판(1), 비트코인 블로그(3), 코인섹트 블로그(4).
export const INDEXED_BOARD_IDS = [1, 3, 4]

const LOCK_KEY = 'rag:locks'
const LOCK_FIELD = 'drain'
// 해시 필드에는 개별 만료가 없다. 값에 시작 시각을 적어두고 이만큼 지난 잠금은
// 죽은 프로세스가 남긴 것으로 보고 뺏는다. desktop_jobs.ts가 잡을 잡는 방식과 같다.
const LOCK_STALE_MS = 1000 * 60 * 5

const MAX_ATTEMPTS = 5
const vectorLiteral = (v: number[]) => `[${v.join(',')}]`

const indexer = {
  // raw SQL을 타는 유일한 지점. 테스트가 갈아끼운다.
  query: (text: string, params?: unknown[]) => dataSource.query(text, params),

  // 이미 돌고 있으면 null을 준다. 던지지 않는다.
  withLock: async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const now = Date.now()
    let got = await cache.hSetNX(LOCK_KEY, LOCK_FIELD, new Date(now).toISOString())

    if (!got) {
      const held = (await cache.hGetAll(LOCK_KEY))[LOCK_FIELD]
      const startedAt = held ? Date.parse(String(held)) : 0
      if (!startedAt || now - startedAt > LOCK_STALE_MS) {
        await cache.hSet(LOCK_KEY, LOCK_FIELD, new Date(now).toISOString())
        got = true
      }
    }

    if (!got) return null

    try {
      return await fn()
    } finally {
      // 안 풀면 다음 배수가 영원히 못 돈다.
      await cache.hDel(LOCK_KEY, LOCK_FIELD)
    }
  },

  // 지연을 줄이는 최적화다. 빠뜨려도 훑기가 잡으므로 결과는 달라지지 않는다.
  enqueue: async (postId: number) => {
    try {
      await indexer.query(
        `INSERT INTO embedding_jobs (post_id, status) VALUES ($1, 'pending')
         ON CONFLICT (post_id) DO UPDATE SET status = 'pending', attempts = 0, updated_at = now()`,
        [postId],
      )
    } catch (e) {
      log.error('indexer.enqueue 실패', e)
    }
  },

  // 인덱싱이 필요한 글을 잡으로 만든다. 정합성의 근거는 쓰기 경로가 아니라 여기다.
  // posts.updated_at은 @UpdateDateColumn이라 어느 경로로 고쳐도 TypeORM이 올려준다.
  sweep: async (limit = 500) => {
    const rows = await indexer.query(
      `INSERT INTO embedding_jobs (post_id, status)
       SELECT p.id, 'pending' FROM posts p
       LEFT JOIN embedding_jobs j ON j.post_id = p.id
       WHERE p.deleted_at IS NULL
         AND p.board_id = ANY($1)
         AND (j.id IS NULL OR j.indexed_at IS NULL OR p.updated_at > j.indexed_at)
       LIMIT $2
       ON CONFLICT (post_id) DO UPDATE SET status = 'pending', attempts = 0, updated_at = now()
       RETURNING post_id`,
      [INDEXED_BOARD_IDS, limit],
    )

    // 지워진 글의 청크를 함께 걷어낸다. 삭제 경로가 이미 지우지만 마지막 방어선이다.
    await indexer.query(
      `DELETE FROM post_chunks c WHERE NOT EXISTS (
         SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.deleted_at IS NULL
       )`,
    )

    return rows.length
  },

  removeChunks: async (postId: number) => {
    try {
      await indexer.query('DELETE FROM post_chunks WHERE post_id = $1', [postId])
      await indexer.query('DELETE FROM embedding_jobs WHERE post_id = $1', [postId])
    } catch (e) {
      log.error('indexer.removeChunks 실패', e)
    }
  },

  // 청크를 넣고 남는 꼬리를 지운다. 글이 짧아졌을 때 옛 청크가 남으면 지워진
  // 내용이 검색에 계속 걸린다.
  replaceChunks: async (
    postId: number,
    boardId: number,
    rows: { content: string, hash: string, vector: number[] | null }[],
  ) => {
    for (let i = 0; i < rows.length; i += 1) {
      const { content, hash, vector } = rows[i]
      await indexer.query(
        `INSERT INTO post_chunks (post_id, board_id, chunk_index, content, content_hash, model, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
         ON CONFLICT (post_id, chunk_index) DO UPDATE
         SET board_id = $2, content = $4, content_hash = $5, model = $6, embedding = $7::vector, updated_at = now()`,
        [postId, boardId, i, content, hash, EMBEDDING_MODEL, vector ? vectorLiteral(vector) : null],
      )
    }

    await indexer.query('DELETE FROM post_chunks WHERE post_id = $1 AND chunk_index >= $2', [postId, rows.length])
  },

  // 잡 하나를 처리한다.
  runJob: async (job: { id: number, post_id: number, attempts: number }) => {
    const [post] = await indexer.query(
      'SELECT id, board_id, title, content FROM posts WHERE id = $1 AND deleted_at IS NULL',
      [job.post_id],
    )

    if (!post) {
      await indexer.removeChunks(job.post_id)
      return
    }

    // 제목을 본문 앞에 붙여 임베딩한다. 자유게시판 글은 짧아 본문만으로는 무엇에
    // 관한 글인지 모르는 경우가 많고, 제목이 그 글에서 가장 압축된 주제 신호다.
    const source = `${post.title || ''}\n\n${post.content || ''}`
    const chunks = chunkText(source)
    const vectors = await embedding.embed(chunks, 'RETRIEVAL_DOCUMENT', 'embed_index')

    await indexer.replaceChunks(post.id, post.board_id, chunks.map((content, i) => ({
      content,
      hash: computeHash(content),
      vector: vectors[i],
    })))

    // 내용이 안 바뀌어 임베딩을 한 번도 치지 않았어도 indexed_at은 갱신한다.
    // 안 그러면 훑기가 같은 글을 영원히 다시 집는다.
    await indexer.query(
      `UPDATE embedding_jobs SET status = 'done', content_hash = $2, indexed_at = now(),
       last_error = NULL, updated_at = now() WHERE id = $1`,
      [job.id, computeHash(source)],
    )
  },

  drain: async (limit = 20) => {
    const ran = await indexer.withLock(async () => {
      const jobs = await indexer.query(
        `SELECT id, post_id, attempts FROM embedding_jobs
         WHERE status = 'pending' AND attempts < $2
         ORDER BY created_at ASC LIMIT $1`,
        [limit, MAX_ATTEMPTS],
      )

      for (const job of jobs) {
        try {
          await indexer.runJob(job)
        } catch (e) {
          const attempts = job.attempts + 1
          // 조용히 무한 재시도하면 API 비용만 태운다.
          await indexer.query(
            `UPDATE embedding_jobs SET attempts = $2, last_error = $3,
             status = $4, updated_at = now() WHERE id = $1`,
            [job.id, attempts, (e || {}).message || String(e), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'],
          )
          log.error(`indexer: 잡 ${job.id}(post ${job.post_id}) 실패`, e)
        }
      }

      return jobs.length
    })

    return ran || 0
  },
}

export default indexer
```

- [ ] **Step 4: cron에 등록한다**

`services/cron.ts`:

```ts
    cron.addJob({
      id: 'indexPosts',
      // 훑기가 정합성의 근거이고, 배수가 그것을 소화한다. 글을 쓰면 그 자리에서도
      // 깨우므로 이 주기는 놓친 것을 줍는 그물이다.
      runnable: async () => {
        await ragIndexer.sweep()
        await ragIndexer.drain()
      },
      interval: 1000 * 60 * 5,
    })
```

`import ragIndexer from './rag/indexer'`를 더한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add services/rag/indexer.ts services/cron.ts tests/rag_indexer.test.ts
git commit -m "$(cat <<'EOF'
feat: 글을 청크로 인덱싱하는 인덱서를 만든다

무엇을 인덱싱할지는 쓰기 경로가 아니라 posts.updated_at 훑기로 정한다.
배수는 hSetNX 잠금으로 한 번에 하나만 돈다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 쓰기 경로에 등록과 삭제를 붙인다

**Files:**
- Modify: `controllers/post_controller.ts`

**Interfaces:**
- Consumes: `indexer.enqueue`, `indexer.removeChunks`, `indexer.drain`

- [ ] **Step 1: 생성과 수정에 등록을 붙인다**

`post_controller.create`의 insert 뒤:

```ts
      const inserted = await orm.querySetter(c, Post).insert().into(Post).values(payload).execute()
      c.res.success()

      // 등록하고 그 자리에서 배수를 깨운다. 기다리지 않는다 - 글쓰기가 임베딩을
      // 기다릴 이유가 없고, 실패해도 훑기가 5분 안에 잡는다.
      const postId = ((inserted.identifiers || [])[0] || {}).id
      if (postId) {
        void ragIndexer.enqueue(postId).then(() => ragIndexer.drain())
      }
```

`post_controller.update`의 `Post.save(target)` 뒤:

```ts
      await Post.save(target)
      c.res.success()
      void ragIndexer.enqueue(target.id).then(() => ragIndexer.drain())
```

- [ ] **Step 2: 삭제에 청크 정리를 붙인다**

`post_controller.delete`의 `softRemove` 뒤:

```ts
      await postRepository.softRemove(target)
      // 지워진 글이 검색에 남아 있는 시간을 만들면 안 된다. 눌러보면 없는 글로 간다.
      void ragIndexer.removeChunks(target.id)
      c.res.success()
```

`import ragIndexer from '../services/rag/indexer'`를 상단에 더한다.

- [ ] **Step 3: 어드민 삭제에도 붙인다**

`controllers/admin_controller.ts`의 `routesPost`에 `delete`를 덮어쓴다.

```ts
// 어드민 삭제도 청크를 걷어야 한다. 제네릭 useCRUD는 글을 모르므로 여기서 덮는다.
const genericDelete = routesPost.delete
routesPost.delete = async (c: IContext) => {
  const id = Number(c.req.params['id'])
  await genericDelete(c)
  if (id) void ragIndexer.removeChunks(id)
}
```

- [ ] **Step 4: 빌드를 확인한다**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add controllers/post_controller.ts controllers/admin_controller.ts
git commit -m "$(cat <<'EOF'
feat: 글을 쓰면 인덱싱을 그 자리에서 깨우고 지우면 청크를 걷는다

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 키워드 검색

**Files:**
- Create: `services/rag/keyword.ts`, `tests/rag_keyword.test.ts`

**Interfaces:**
- Produces:
  - `buildPatterns(q: string): string[]`
  - `IKeywordHit = { postId: number, boardId: number }`
  - `keyword.search(q: string, boardId: number | null, limit: number): Promise<IKeywordHit[]>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_keyword.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPatterns } from '../services/rag/keyword'

test('공백으로 자르고 부분일치 패턴을 만든다', () => {
  // 형태소 분석 없이 자른다. 한국어는 조사가 붙어 "워크숍을"과 "워크숍이"가 다른
  // 토큰이 되지만, 부분일치라 어간이 남아 있으면 걸린다.
  assert.deepEqual(buildPatterns('비트코인 반감기'), ['%비트코인%', '%반감기%'])
})

test('한 글자 토큰은 버린다', () => {
  // 조사와 관형사가 잡음만 만든다.
  assert.deepEqual(buildPatterns('그 비트코인'), ['%비트코인%'])
})

test('같은 토큰을 두 번 넣지 않는다', () => {
  assert.deepEqual(buildPatterns('btc BTC btc'), ['%btc%'])
})

test('토큰 수에 상한이 있다', () => {
  const many = Array.from({ length: 20 }, (_, i) => `토큰${i}`).join(' ')
  assert.equal(buildPatterns(many).length, 8)
})

test('LIKE 메타문자를 리터럴로 만든다', () => {
  // 이스케이프하지 않으면 조건이 임의로 넓어진다. services/post.ts의 기존
  // keyword 분기가 같은 처리를 한다.
  assert.deepEqual(buildPatterns('100%'), ['%100\\%%'])
  assert.deepEqual(buildPatterns('a_b'), ['%a\\_b%'])
})

test('빈 질의는 패턴이 없다', () => {
  assert.deepEqual(buildPatterns('   '), [])
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_keyword.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/rag/keyword.ts`:

```ts
import { dataSource } from '../../database'

// 한 질의에서 뽑아 쓸 최대 토큰 수. 넘기면 SQL의 OR 가지가 무의미하게 늘어난다.
const MAX_TOKENS = 8
// 이보다 짧은 토큰은 부분일치에서 잡음만 만든다(조사, 관형사 등).
const MIN_TOKEN_LENGTH = 2

// 값에 든 %와 _를 리터럴로 만든다. 이스케이프하지 않으면 조건이 임의로 넓어진다.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`)

export const buildPatterns = (q: string): string[] => {
  const seen = new Set<string>()
  const patterns: string[] = []

  for (const raw of (q || '').split(/\s+/)) {
    const token = raw.trim()
    if (token.length < MIN_TOKEN_LENGTH) continue

    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    patterns.push(`%${escapeLike(token)}%`)
    if (patterns.length >= MAX_TOKENS) break
  }

  return patterns
}

export interface IKeywordHit {
  postId: number
  boardId: number
}

const keyword = {
  // post_chunks가 아니라 posts 원본을 본다. 아직 인덱싱되지 않은 글(방금 쓴 글,
  // 임베딩 실패분)은 청크가 없어 벡터 검색에 절대 잡히지 않는데, 이 경로는
  // 그것들을 첫 검색부터 찾아낸다.
  search: async (q: string, boardId: number | null, limit: number): Promise<IKeywordHit[]> => {
    const patterns = buildPatterns(q)
    if (!patterns.length) return []

    const clauses = patterns
      .map((_, i) => `(p.title ILIKE $${i + 1} ESCAPE '\\' OR coalesce(p.content, '') ILIKE $${i + 1} ESCAPE '\\')`)
      .join(' OR ')

    const params: unknown[] = [...patterns]
    let boardClause = 'p.board_id = ANY($' + (params.length + 1) + ')'
    params.push(boardId ? [boardId] : [1, 3, 4])
    params.push(limit)

    const rows = await dataSource.query(
      `SELECT p.id AS post_id, p.board_id FROM posts p
       WHERE p.deleted_at IS NULL AND ${boardClause} AND (${clauses})
       ORDER BY p.id DESC LIMIT $${params.length}`,
      params,
    )

    return rows.map(r => ({ postId: Number(r.post_id), boardId: Number(r.board_id) }))
  },
}

export default keyword
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add services/rag/keyword.ts tests/rag_keyword.test.ts
git commit -m "$(cat <<'EOF'
feat: trigram 부분일치 키워드 검색을 만든다

청크가 아니라 posts 원본을 본다. 아직 인덱싱되지 않은 글을 첫 검색부터 찾는다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 하이브리드 검색

**Files:**
- Create: `services/rag/search.ts`, `tests/rag_search.test.ts`

**Interfaces:**
- Consumes: `embedding.embed`, `fuseRRF`, `keyword.search`
- Produces:
  - `MIN_SCORE` (초기 0.71, Task 10에서 실측으로 확정)
  - `IRetrieved = { postId, boardId, content, score: number | null, matchType: 'vector' | 'keyword' | 'both' }`
  - `search.retrieve({ q, boardId, limit }): Promise<IRetrieved[]>`
  - `search.vectorSearch(vector, boardId, minScore, limit)` — SQL을 타는 지점

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rag_search.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import search from '../services/rag/search'
import embedding from '../services/rag/embedding'
import keyword from '../services/rag/keyword'

const withStubs = async (
  stubs: { vector?: unknown[], keyword?: unknown[], embed?: number[] | null },
  fn: () => Promise<unknown>,
) => {
  const originals = { embed: embedding.embed, vec: search.vectorSearch, kw: keyword.search }
  embedding.embed = (async () => [stubs.embed === undefined ? [0.1] : stubs.embed]) as never
  search.vectorSearch = (async () => (stubs.vector || [])) as never
  keyword.search = (async () => (stubs.keyword || [])) as never

  try {
    return await fn()
  } finally {
    embedding.embed = originals.embed
    search.vectorSearch = originals.vec
    keyword.search = originals.kw
  }
}

test('한 글의 청크가 여럿 걸려도 결과는 한 줄이다', async () => {
  // 벡터 결과는 청크 단위다. 접지 않고 융합에 넘기면 같은 리스트에서 점수가 여러
  // 번 더해져, 조각이 많은 긴 글이 단지 조각 수 때문에 상위를 차지한다.
  const result = await withStubs({
    vector: [
      { postId: 7, boardId: 1, content: '가장 비슷한 조각', score: 0.85 },
      { postId: 7, boardId: 1, content: '덜 비슷한 조각', score: 0.80 },
      { postId: 9, boardId: 1, content: '다른 글', score: 0.83 },
    ],
  }, () => search.retrieve({ q: '질문', boardId: 1, limit: 10 })) as never[]

  assert.equal(result.filter(o => o['postId'] === 7).length, 1)
  assert.equal(result.find(o => o['postId'] === 7)['content'], '가장 비슷한 조각')
})

test('양쪽에 걸린 글은 both로 표시된다', async () => {
  const result = await withStubs({
    vector: [{ postId: 7, boardId: 1, content: '조각', score: 0.85 }],
    keyword: [{ postId: 7, boardId: 1 }],
  }, () => search.retrieve({ q: '질문', boardId: 1, limit: 10 })) as never[]

  assert.equal(result[0]['matchType'], 'both')
  assert.equal(result[0]['score'], 0.85)
})

test('키워드로만 걸린 글은 점수가 null이다', async () => {
  // RRF 점수를 여기 넣으면 안 된다. 화면이 백분율로 보여주는 코사인 유사도 자리다.
  const result = await withStubs({
    keyword: [{ postId: 3, boardId: 1 }],
  }, () => search.retrieve({ q: '질문', boardId: 1, limit: 10 })) as never[]

  assert.equal(result[0]['matchType'], 'keyword')
  assert.equal(result[0]['score'], null)
})

test('임베딩이 실패해도 키워드 결과는 나온다', async () => {
  // 한도나 장애로 벡터 절반을 포기해도 검색이 통째로 죽으면 안 된다.
  const result = await withStubs({
    embed: null,
    keyword: [{ postId: 3, boardId: 1 }],
  }, () => search.retrieve({ q: '질문', boardId: 1, limit: 10 })) as never[]

  assert.equal(result.length, 1)
  assert.equal(result[0]['matchType'], 'keyword')
})

test('빈 질의는 아무것도 찾지 않는다', async () => {
  const result = await search.retrieve({ q: '   ', boardId: 1, limit: 10 })
  assert.deepEqual(result, [])
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rag_search.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/rag/search.ts`:

```ts
import { dataSource } from '../../database'
import embedding from './embedding'
import keyword, { IKeywordHit } from './keyword'
import { fuseRRF } from './fusion'
import { INDEXED_BOARD_IDS } from './indexer'

// 결과로 인정할 최소 유사도.
//
// 임베딩 공간은 비등방적이라 코사인 유사도가 0 근처로 내려가지 않는다. 컷오프가
// 없으면 검색은 언제나 "가장 덜 먼" K개를 돌려주고, 화면은 그걸 그럴듯한 숫자로
// 보여준다 - 엉뚱한 결과가 확신에 차서 뜨는 셈이다.
//
// 값은 감이 아니라 실측으로 정한다. tools/calibrate_search.ts로 재고 아래 기록을
// 갱신할 것. 모델이나 차원이 바뀌면 점수 분포가 통째로 이동한다.
//
// (백필 뒤 실측값을 여기에 날짜와 함께 적는다. 그 전까지는 scheduly의 측정에서
//  빌려온 잠정값이다 - 그쪽 코퍼스는 업무 노트라 우리와 분포가 다르다.)
export const MIN_SCORE = 0.71

export interface IRetrieved {
  postId: number
  boardId: number
  content: string
  // 벡터 매칭이 있을 때만 코사인 유사도(0~1). 키워드 전용이면 null이다.
  score: number | null
  matchType: 'vector' | 'keyword' | 'both'
}

interface IVectorHit {
  postId: number
  boardId: number
  content: string
  score: number
}

const search = {
  // SQL을 타는 지점. 테스트가 갈아끼운다.
  vectorSearch: async (
    vector: number[],
    boardId: number | null,
    minScore: number,
    limit: number,
  ): Promise<IVectorHit[]> => {
    const rows = await dataSource.query(
      `SELECT c.post_id, c.board_id, c.content, (c.embedding <=> $1::vector) AS distance
       FROM post_chunks c
       WHERE c.embedding IS NOT NULL
         AND c.board_id = ANY($2)
         -- 살아 있는 글만 돌려준다. 삭제 경로와 훑기가 청크를 걷지만, 그 사이의
         -- 짧은 틈 때문에 "눌러보면 없는 글"이 뜨면 안 된다. 마지막 방어선이다.
         AND EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.deleted_at IS NULL)
         AND (c.embedding <=> $1::vector) <= $3
       ORDER BY (c.embedding <=> $1::vector) ASC
       LIMIT $4`,
      [`[${vector.join(',')}]`, boardId ? [boardId] : INDEXED_BOARD_IDS, 1 - minScore, limit],
    )

    return rows.map(r => ({
      postId: Number(r.post_id),
      boardId: Number(r.board_id),
      content: r.content,
      score: Math.max(0, 1 - Number(r.distance)),
    }))
  },

  retrieve: async ({ q, boardId, limit = 20, minScore = MIN_SCORE }: {
    q: string,
    boardId?: number | null,
    limit?: number,
    minScore?: number,
  }): Promise<IRetrieved[]> => {
    const trimmed = (q || '').trim()
    if (!trimmed) return []

    // 융합은 순위만 쓰므로 후보가 얕으면 합칠 것이 없다. 넉넉히 뽑아 놓고 자른다.
    const depth = Math.max(limit * 3, 30)

    // 키워드 검색은 임베딩을 기다릴 이유가 없다. 둘을 병렬로 돌려 지연을 겹친다.
    const [vectorHits, keywordHits] = await Promise.all([
      (async (): Promise<IVectorHit[]> => {
        const [vector] = await embedding.embed([trimmed], 'RETRIEVAL_QUERY', 'embed_query')
        if (!vector || !vector.length) return []
        return search.vectorSearch(vector, boardId || null, minScore, depth)
      })(),
      keyword.search(trimmed, boardId || null, depth),
    ])

    // 융합 전에 글 단위로 접는다. RRF는 리스트당 한 항목이 한 번 등장한다고
    // 전제한다. 가장 앞선 청크(=가장 유사한 청크)만 남겨 그 전제를 지킨다.
    const bestPerPost: IVectorHit[] = []
    const seen = new Set<number>()
    for (const hit of vectorHits) {
      if (seen.has(hit.postId)) continue
      seen.add(hit.postId)
      bestPerPost.push(hit)
    }

    // 벡터 결과를 첫 리스트로 넘긴다 - 동점일 때 본문과 코사인 점수를 함께 가진
    // 쪽이 살아남게 하려는 것이다(fuseRRF는 최초 등장 객체를 유지한다).
    const fused = fuseRRF<IVectorHit | IKeywordHit>(
      [bestPerPost, keywordHits],
      hit => String(hit.postId),
    )

    return fused.slice(0, limit).map(({ item, sources }) => {
      const inVector = sources.includes(0)
      const inKeyword = sources.includes(1)

      return {
        postId: item.postId,
        boardId: item.boardId,
        content: inVector ? (item as IVectorHit).content : '',
        // RRF 점수를 여기 넣지 마라 - 화면이 백분율로 표시하는 코사인 유사도 자리다.
        score: inVector ? (item as IVectorHit).score : null,
        matchType: inVector && inKeyword ? 'both' : inVector ? 'vector' : 'keyword',
      }
    })
  },
}

export default search
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add services/rag/search.ts tests/rag_search.test.ts
git commit -m "$(cat <<'EOF'
feat: 벡터와 키워드를 RRF로 합치는 하이브리드 검색을 만든다

융합 전에 글 단위로 접는다. 안 접으면 조각이 많은 긴 글이 조각 수만으로
상위를 차지한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 속도 제한과 검색 엔드포인트

**Files:**
- Create: `core/rate_limit.ts`, `tests/rate_limit.test.ts`
- Modify: `services/post.ts`, `controllers/post_controller.ts`, `routes.ts`

**Interfaces:**
- Consumes: `search.retrieve`, `core/cache`
- Produces:
  - `rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>` — 통과면 true
  - `postService.search(c)` → `{ data, total }`
  - `GET /posts/search?q=&boardId=&limit=`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/rate_limit.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateLimit } from '../core/rate_limit'

test('한도까지는 통과하고 그 뒤는 막는다', async () => {
  const key = `test:${Date.now()}`

  assert.equal(await rateLimit(key, 2, 60), true)
  assert.equal(await rateLimit(key, 2, 60), true)
  assert.equal(await rateLimit(key, 2, 60), false)
})

test('키가 다르면 서로 영향을 주지 않는다', async () => {
  const a = `test:a:${Date.now()}`
  const b = `test:b:${Date.now()}`

  assert.equal(await rateLimit(a, 1, 60), true)
  assert.equal(await rateLimit(a, 1, 60), false)
  assert.equal(await rateLimit(b, 1, 60), true)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/rate_limit.test.ts`
Expected: FAIL.

- [ ] **Step 3: 속도 제한을 구현한다**

`core/rate_limit.ts`:

```ts
import useCache from './cache'
import { log } from './logger'

const cache = useCache()

// 창 단위 카운터. 창이 바뀌면 키가 바뀌어 자연히 0에서 다시 센다.
//
// 정확한 슬라이딩 윈도가 아니다. 창 경계에서 한도의 두 배까지 통과할 수 있지만,
// 이 엔드포인트가 막으려는 것은 정밀한 형평이 아니라 비용 폭주다.
//
// 캐시가 죽으면 통과시킨다. 속도 제한 때문에 검색이 통째로 죽는 것보다 낫다.
export const rateLimit = async (key: string, limit: number, windowSeconds: number): Promise<boolean> => {
  try {
    const window = Math.floor(Date.now() / 1000 / windowSeconds)
    const cacheKey = `ratelimit:${key}:${window}`

    const current = Number(await cache.get(cacheKey)) || 0
    if (current >= limit) return false

    await cache.set(cacheKey, current + 1, windowSeconds * 2)
    return true
  } catch (e) {
    log.error('rateLimit 실패. 통과시킨다.', e)
    return true
  }
}
```

- [ ] **Step 4: 검색 서비스와 컨트롤러를 더한다**

`services/post.ts`:

```ts
  // 하이브리드 검색. 기존 /posts?keyword= 는 손대지 않는다 - 어드민과 목록이
  // 같이 쓰고 limit/offset 페이지네이션을 전제로 돌기 때문이다.
  search: async (c: IContext) => {
    const q = (c.req.query['q'] || '').trim()
    if (!q) return Promise.reject({ message: 'q is missing', status: 400 })
    if (q.length > 200) return Promise.reject({ message: 'q is too long', status: 400 })

    const boardId = c.req.query['boardId'] ? Number(c.req.query['boardId']) : null
    const limit = Math.min(Number(c.req.query['limit']) || 20, 20)

    const retrieved = await ragSearch.retrieve({ q, boardId, limit })
    if (!retrieved.length) return { data: [], total: 0 }

    const posts = await c.orm.getRepository(Post).createQueryBuilder('Post')
      .leftJoinAndSelect('Post.user', 'user')
      .leftJoinAndSelect('user.profile', 'profile')
      .leftJoinAndSelect('Post.board', 'board')
      .where('Post.id IN (:...ids)', { ids: retrieved.map(o => o.postId) })
      .getMany()

    posts.forEach((post: Post) => post.mutatePostToBeSecure(c.req.ip))

    // 회수 순서가 곧 랭킹이다. DB가 돌려준 순서가 아니라 이 순서를 지켜야 한다.
    const byId = new Map(posts.map(p => [p.id, p]))
    const data = retrieved
      .map(hit => {
        const post = byId.get(hit.postId)
        return post && { ...post, score: hit.score, matchType: hit.matchType }
      })
      .filter(Boolean)

    return { data, total: data.length }
  },
```

`controllers/post_controller.ts`:

```ts
  search: async (c: IContext) => {
    // 인증이 없는 공개 경로다. 질의 임베딩이 IP당 비용을 만든다.
    if (!await rateLimit(`search:${c.req.ip}`, 30, 60)) {
      return c.res.failed({ message: 'TOO_MANY_REQUESTS' }, 429)
    }

    try {
      c.res.asJSON(await postService.search(c))
    } catch (e) {
      c.res.failed(e)
    }
  },
```

- [ ] **Step 5: 라우트를 등록한다**

`routes.ts`. **`/posts/:sharingKey`보다 앞에 둔다.** 뒤에 두면 `search`가 sharingKey로 잡힌다. `with_llm`이 이미 같은 이유로 앞에 있다.

```ts
    router.get('/posts/with_llm', ctrls.post.allWithLLM)
    router.get('/posts/search', ctrls.post.search)
    router.get('/posts', ctrls.post.all)
    router.get('/posts/:sharingKey', ctrls.post.detail)
```

- [ ] **Step 6: 통과를 확인한다**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add core/rate_limit.ts tests/rate_limit.test.ts services/post.ts controllers/post_controller.ts routes.ts
git commit -m "$(cat <<'EOF'
feat: 하이브리드 검색 엔드포인트를 열고 IP당 속도 제한을 건다

/posts/search는 /posts/:sharingKey보다 앞에 등록해야 한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 백필과 컷오프 보정

**Files:**
- Create: `tools/backfill_post_embeddings.ts`, `tools/calibrate_search.ts`
- Modify: `services/rag/search.ts` (`MIN_SCORE` 확정), `docs/superpowers/specs/2026-09-11-ai-usage-and-rag-design.md` (실측 기록)

**Interfaces:**
- Consumes: `indexer.sweep`, `indexer.drain`, `search.retrieve`

- [ ] **Step 1: 백필 도구를 쓴다**

`tools/backfill_post_embeddings.ts`:

```ts
// 기존 글을 전부 인덱싱한다. cron에 맡기면 5분에 20건이라 1,713건에 일곱 시간이
// 걸리는데, 그건 API가 느려서가 아니라 우리가 정한 페이싱 때문이다. 직접 돈다.
//
//   GOOGLE_AI_STUDIO=<키> npx ts-node tools/backfill_post_embeddings.ts
//
// 같은 잠금을 쓰므로 cron이나 글쓰기가 끼어들어 같은 잡을 두 번 처리하지 않는다.
// 중간에 죽어도 잡이 pending으로 남아 이어서 돈다.
import { dataSource } from '../database'
import indexer from '../services/rag/indexer'

const run = async () => {
  await dataSource.initialize()

  const startedAt = Date.now()
  const queued = await indexer.sweep(100000)
  console.log(`인덱싱 대상 ${queued}건`)

  let done = 0
  for (;;) {
    const processed = await indexer.drain(50)
    if (!processed) break

    done += processed
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    console.log(`${done}/${queued} — ${elapsed}초`)
  }

  const [{ count }] = await dataSource.query('SELECT count(*) FROM post_chunks WHERE embedding IS NOT NULL')
  console.log(`끝. 청크 ${count}개, ${Math.round((Date.now() - startedAt) / 1000)}초`)
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: 백필을 돌리고 시간을 잰다**

프로덕션 DB에 Task 11의 스키마를 먼저 올린 뒤 서버 위에서 돌린다.

Expected: 청크 수가 5,000~6,500 사이, 걸린 시간이 출력된다.

**출력된 청크 수와 소요 시간을 스펙 §5.4에 적는다.** 추정이 아니라 실측이 근거여야 한다.

- [ ] **Step 3: 보정 도구를 쓴다**

`tools/calibrate_search.ts`:

```ts
// 유사도 컷오프를 실측으로 정한다.
//
//   GOOGLE_AI_STUDIO=<키> npx ts-node tools/calibrate_search.ts
//
// 무관한 질의의 최고점과 관련 있는 질의의 최저점 사이가 벌어져 있어야 컷오프를
// 그을 자리가 있다. 겹치면 이 코퍼스에서는 벡터 단독으로 가를 수 없다는 뜻이고,
// 그때는 컷오프를 낮추고 키워드 경로에 더 기대야 한다.
import { dataSource } from '../database'
import search from '../services/rag/search'

// 코퍼스에 답이 있을 질의와 없을 질의. 실제 글을 보고 고쳐 쓸 것.
const RELEVANT = [
  '비트코인 반감기가 뭐야',
  '채굴 난이도는 어떻게 정해져',
  '콜드월렛 추천',
  '김치프리미엄이 왜 생겨',
  '레버리지 청산 당했다',
  '반감기 이후 가격',
]
const IRRELEVANT = [
  '오늘 점심 메뉴 추천',
  '자동차 보험 갱신 방법',
  '초등학교 입학 준비물',
  '무릎 통증 스트레칭',
  '엑셀 피벗테이블 만들기',
  '제주도 3박 4일 일정',
]

const topScore = async (q: string) => {
  // 컷오프를 0으로 두고 뽑아야 분포 전체가 보인다.
  const hits = await search.retrieve({ q, limit: 5, minScore: 0 })
  const scored = hits.filter(h => h.score !== null)
  return scored.length ? Math.max(...scored.map(h => h.score)) : 0
}

const run = async () => {
  await dataSource.initialize()

  const relevant = []
  for (const q of RELEVANT) relevant.push({ q, score: await topScore(q) })
  const irrelevant = []
  for (const q of IRRELEVANT) irrelevant.push({ q, score: await topScore(q) })

  const show = (label: string, rows: { q: string, score: number }[]) => {
    console.log(`\n[${label}]`)
    rows.forEach(r => console.log(`  ${(r.score * 100).toFixed(1)}%  ${r.q}`))
  }

  show('관련 있음', relevant)
  show('무관함', irrelevant)

  const relevantMin = Math.min(...relevant.map(r => r.score))
  const irrelevantMax = Math.max(...irrelevant.map(r => r.score))

  console.log(`\n관련 최저 ${(relevantMin * 100).toFixed(1)}% / 무관 최고 ${(irrelevantMax * 100).toFixed(1)}%`)
  if (relevantMin <= irrelevantMax) {
    console.log('두 분포가 겹친다. 벡터 단독으로 가를 수 없다 - 컷오프를 낮추고 키워드에 기댈 것.')
  } else {
    console.log(`제안 컷오프: ${(((relevantMin + irrelevantMax) / 2)).toFixed(3)}`)
  }
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 4: 보정을 돌리고 `MIN_SCORE`를 확정한다**

Run: 서버 위에서 `GOOGLE_AI_STUDIO=<키> npx ts-node tools/calibrate_search.ts`

`services/rag/search.ts`의 `MIN_SCORE`를 제안값으로 바꾸고, **측정한 두 분포의 수치와 날짜를 주석에 적는다.**

- [ ] **Step 5: 커밋**

```bash
git add tools/backfill_post_embeddings.ts tools/calibrate_search.ts services/rag/search.ts docs/superpowers/specs/
git commit -m "$(cat <<'EOF'
feat: 백필과 컷오프 보정 도구를 만들고 실측값을 적는다

컷오프는 감이 아니라 두 분포의 간격으로 정한다. 측정 기록을 주석에 남긴다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `with_llm`을 회수 기반으로 다시 쓴다

**Files:**
- Modify: `services/post.ts` (`allWithLLM`), `controllers/post_controller.ts`
- Test: `tests/post_with_llm.test.ts` (생성)

**Interfaces:**
- Consumes: `search.retrieve`, `aiUsage.daily`
- Produces: `allWithLLM` 응답 모양은 그대로 `{ data, total, answer: { kr, en } }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/post_with_llm.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnswerPrompt, DAILY_COST_CAP_MICROS } from '../services/post'

test('프롬프트에 회수된 조각만 들어간다', () => {
  const prompt = buildAnswerPrompt('반감기가 뭐야', [
    { postId: 1, boardId: 3, content: '반감기는 보상이 절반이 되는 것이다', score: 0.8, matchType: 'vector' },
  ])

  assert.match(prompt, /반감기가 뭐야/)
  assert.match(prompt, /보상이 절반/)
  // 글 전문을 넣던 옛 구조로 돌아가면 안 된다. 조각만 들어간다.
  assert.ok(prompt.length < 2000)
})

test('회수가 비면 프롬프트를 만들지 않는다', () => {
  // 근거 없이 답하게 두면 그럴듯한 거짓말이 나온다.
  assert.equal(buildAnswerPrompt('아무거나', []), null)
})

test('일일 상한이 상수로 정의되어 있다', () => {
  assert.ok(DAILY_COST_CAP_MICROS > 0)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/post_with_llm.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

`services/post.ts`의 `allWithLLM`을 통째로 갈아엎는다.

```ts
// 하루 전체 AI 비용의 상한(USD micros). 닿으면 답변만 끈다 - 검색은 캐시와
// 키워드 경로로 임베딩 없이도 동작하므로 계속 살려 둔다. 한도 때문에 검색이
// 통째로 죽는 것보다 결과가 줄어드는 편이 낫다.
//
// 개인 한도가 없는 공개 서비스에서 전역 상한은 마지막 방어선이다. 사람이
// 깨어나기 전에 서비스가 스스로 멈춰야 한다.
export const DAILY_COST_CAP_MICROS = Number(process.env.AI_DAILY_COST_CAP_MICROS) || 2_000_000 // $2

// 회수된 조각으로 답변 프롬프트를 만든다. 회수가 비면 null - 근거 없이 답하게
// 두면 그럴듯한 거짓말이 나온다.
export const buildAnswerPrompt = (q: string, retrieved: IRetrieved[]): string | null => {
  const usable = retrieved.filter(o => o.content)
  if (!usable.length) return null

  return `
Answer the user's question using ONLY the excerpts below. They come from posts on a bitcoin site.
If the excerpts do not contain the answer, say so instead of guessing.

Question: "${q}"

Excerpts:
${usable.map((o, i) => `[${i + 1}] ${o.content}`).join('\n\n')}

The result JSON should be a form of { "kr": String, "en": String }
  `.trim()
}
```

`allWithLLM` 본문:

```ts
  allWithLLM: async (c: IContext) => {
    const boardId = c.req.query['boardId']
    const q = (c.req.query['question'] || '').trim()
    if (!boardId || !q) return Promise.reject({ message: 'boardId or question is missing', status: 400 })
    if (q.length > 200) return Promise.reject({ message: 'question is too long', status: 400 })

    log.info(`allWithLLM: query "${q}" (IP: ${c.req.ip})`)

    try {
      // 회수는 검색과 같은 계층을 쓴다. 옛 구조는 보드의 전 글 제목을 프롬프트에
      // 넣어 고르게 했다 - 글이 늘면 입력이 선형으로 늘고, 제목만 보므로 본문에만
      // 있는 내용은 끝내 찾지 못했다.
      const retrieved = await ragSearch.retrieve({ q, boardId: Number(boardId), limit: 6 })

      const posts = retrieved.length ? await c.orm.getRepository(Post).createQueryBuilder('Post')
        .leftJoinAndSelect('Post.user', 'user')
        .leftJoinAndSelect('user.profile', 'profile')
        .leftJoinAndSelect('Post.board', 'board')
        .where('Post.id IN (:...ids)', { ids: retrieved.map(o => o.postId) })
        .getMany() : []

      posts.forEach((post: Post) => post.mutatePostToBeSecure(c.req.ip))

      const prompt = buildAnswerPrompt(q, retrieved)
      if (!prompt) return { data: [], total: 0, answer: null }

      // 오늘 비용이 상한에 닿았으면 근거 글만 주고 답변은 생략한다.
      const today = await aiUsage.daily(aiUsage.utcDay(), aiUsage.utcDay())
      if (today.totalCostMicros >= DAILY_COST_CAP_MICROS) {
        log.error(`allWithLLM: 일일 비용 상한 도달(${today.totalCostMicros}). 답변을 생략한다.`)
        return { data: posts, total: posts.length, answer: null }
      }

      const genAI = new GoogleGenAI({ apiKey: store.state.serverConfig.GOOGLE_AI_STUDIO })
      const startedAt = Date.now()
      const result = await genAI.models.generateContent({
        model: ANSWER_MODEL,
        contents: [{ text: prompt }],
        config: { responseMimeType: 'application/json' },
      })

      void aiUsage.record({
        task: 'post_answer',
        model: ANSWER_MODEL,
        usageMetadata: result.usageMetadata,
        latencyMs: Date.now() - startedAt,
        requester: c.req.ip,
      })

      // 응답 모양은 그대로다. ModalBitcoinGPT는 수정이 없다.
      return { data: posts, total: posts.length, answer: JSON.parse(result.text) }
    } catch (e) {
      log.error('allWithLLM:', e)
      return Promise.reject(e)
    }
  },
```

- [ ] **Step 4: 컨트롤러에 속도 제한을 건다**

`post_controller.allWithLLM` 첫 줄:

```ts
    // 답변은 검색보다 훨씬 비싸다. 한도도 그만큼 좁게 잡는다.
    if (!await rateLimit(`with_llm:${c.req.ip}`, 5, 60)) {
      return c.res.failed({ message: 'TOO_MANY_REQUESTS' }, 429)
    }
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add services/post.ts controllers/post_controller.ts tests/post_with_llm.test.ts
git commit -m "$(cat <<'EOF'
feat: with_llm을 회수 기반으로 다시 쓴다

보드의 전 제목을 넣어 고르게 하던 호출을 없앤다. 호출 2회가 1회가 되고
글이 늘어도 입력이 늘지 않는다. 응답 모양은 그대로라 프론트는 수정이 없다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: 프로덕션 적용과 확인

**Files:** 없음 (운영 작업)

- [ ] **Step 1: 스키마를 올린다**

```bash
scp -i ~/.ssh/kispi-seoul.pem tools/sql/002_rag.sql ubuntu@webserver.coinsect.io:~/
ssh -i ~/.ssh/kispi-seoul.pem ubuntu@webserver.coinsect.io \
  "sudo -u postgres psql -d coinsect -f ~/002_rag.sql"
```

Expected: `CREATE EXTENSION` 둘, `CREATE TABLE` 셋, 인덱스들. **`vector` 확장 생성이 실패하면 멈춘다** — `sudo apt install postgresql-16-pgvector`가 필요한 상태다.

- [ ] **Step 2: 배포하고 백필을 돌린다**

Task 10 Step 2의 절차를 따른다. 출력된 청크 수와 소요 시간을 스펙에 적는다.

- [ ] **Step 3: 컷오프를 보정한다**

Task 10 Step 4의 절차를 따르고 재배포한다.

- [ ] **Step 4: 검색이 실제로 동작하는지 본다**

```bash
curl -s 'https://api.coinsect.io/posts/search?q=반감기&boardId=1&limit=5' | head -c 800
```

Expected: `data`에 글이 있고, `matchType`이 `vector` 또는 `both`인 결과가 섞여 있다. **전부 `keyword`면 벡터 경로가 죽은 것이다** — 청크의 `embedding`이 전부 null이거나 컷오프가 너무 높다.

- [ ] **Step 5: 비용이 실제로 기록되는지 본다**

```bash
ssh -i ~/.ssh/kispi-seoul.pem ubuntu@webserver.coinsect.io \
  "sudo -u postgres psql -d coinsect -c \"select task, count(*), sum(cost_micros) from ai_usage group by 1\""
```

Expected: `embed_index`, `embed_query`, `post_answer` 행이 보인다.

- [ ] **Step 6: 메모리를 확인한다**

상자가 2 vCPU / 3.8GB에 이미 스왑을 쓰고 있다. HNSW 인덱스가 올라간 뒤를 본다.

```bash
ssh -i ~/.ssh/kispi-seoul.pem ubuntu@webserver.coinsect.io "free -m && \
  sudo -u postgres psql -d coinsect -c \"select pg_size_pretty(pg_total_relation_size('post_chunks'))\""
```

Expected: `post_chunks`가 100MB 안쪽. 크게 벗어나면 스펙의 추정이 틀린 것이므로 기록하고 차원이나 청크 크기를 재검토한다.

---

## Self-Review

**스펙 대응:** §5.1 → Task 1. §5.2 → Task 4. §5.3 → Task 2. §5.4 → Task 5, 6, 10. §5.5 → Task 3, 7, 8, 9, 10. §5.6 → Task 11. §5.7 → Task 4(캐시), 9(속도 제한), 11(전역 상한). §7 테스트 → 각 태스크. §8 실패 모드 → Task 5(재시도 상한), Task 4(임베딩 실패 시 null), Task 8(살아있는 글 확인).

**타입 일관성:** `IRetrieved`는 Task 8이 정의하고 Task 11이 쓴다. `IKeywordHit`은 Task 7이 정의하고 Task 8이 쓴다. `INDEXED_BOARD_IDS`는 Task 5가 정의하고 Task 8이 쓴다. `aiUsage.record`와 `aiUsage.daily`, `aiUsage.utcDay`는 A 계획이 정의한다.

**미완:** `EMBED_BATCH_SIZE`(Task 4 Step 5)와 `MIN_SCORE`(Task 10 Step 4)는 실측 뒤에 확정되는 값이다. 계획에 넣은 초기값은 잠정이며, 측정 없이 그대로 두면 안 된다.
