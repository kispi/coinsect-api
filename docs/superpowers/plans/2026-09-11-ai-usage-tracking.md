# AI 사용량 계측 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 서버가 부르는 모든 AI 호출을 표에 남겨, "이번 달에 어느 기능이 얼마 썼나"에 답할 수 있게 한다.

**Architecture:** 호출 한 건이 `ai_usage` 한 행이 된다. 야간 cron이 전날치를 `ai_usage_daily`로 접고 90일 지난 원본을 지운다. 기록은 절대 던지지 않고 절대 기다리지 않는다 — 계측이 본래 동작을 막으면 안 된다.

**Tech Stack:** TypeScript, Fastify, TypeORM 0.3, PostgreSQL 16, `@google/genai` 2.16

**Spec:** `docs/superpowers/specs/2026-09-11-ai-usage-and-rag-design.md` (§4)

## Global Constraints

- 주석과 커밋 메시지는 **한국어**로 쓴다. 기존 코드의 주석 밀도와 어조를 따른다.
- 테스트는 `node:test` + `node:assert/strict`다. **DB를 띄우지 않는다.** DB를 타는 함수는 모듈 속성으로 노출해 테스트가 갈아끼운다(`tests/real_time_position.test.ts`의 `autoParse` 교체 방식과 같다).
- 실행: `npm test`. 한 파일만 돌리려면 `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/<name>.test.ts`.
- 비용 단위는 **USD의 100만분의 1(micros) 정수**다. 원화로 저장하지 않는다.
- 스키마는 `tools/sql/`의 번호 붙은 `.sql`로 관리한다. **마이그레이션 프레임워크를 도입하지 않는다.** 모든 문장에 `IF NOT EXISTS`를 붙여 두 번 돌려도 안전하게 한다.
- 모델 이름에 `-latest` 같은 떠다니는 별칭을 쓰지 않는다.
- 커밋 메시지 말미에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`를 붙인다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `services/content/model_usage.ts` (수정) | 단가표와 비용 환산. 임베딩 모델 추가, 미상 모델 처리 변경 |
| `entities/ai_usage.ts` (생성) | `ai_usage` 엔티티 |
| `entities/ai_usage_daily.ts` (생성) | `ai_usage_daily` 엔티티 |
| `tools/sql/001_ai_usage.sql` (생성) | 두 표와 인덱스 |
| `services/ai_usage.ts` (생성) | 기록, 집계, 정리, 조회. 이 기능의 유일한 입구 |
| `services/content/real_time_position.ts` (수정) | 판독 호출에 계측을 붙인다 |
| `services/post.ts` (수정) | 답변 호출에 계측을 붙이고 모델을 고정한다 |
| `services/cron.ts` (수정) | 야간 집계와 정리를 등록한다 |
| `controllers/admin_controller.ts` (수정) | 조회 컨트롤러 |
| `routes.ts` (수정) | 조회 라우트 |
| `tests/model_usage.test.ts` (수정) | 미상 모델 단가 |
| `tests/ai_usage.test.ts` (생성) | 기록·집계·정리 |

---

### Task 1: 단가표를 고친다

미상 모델의 단가를 0이 아니라 표에서 가장 비싼 값으로 친다. 과대평가는 알림을 부르지만 과소평가는 청구서를 부른다.

**Files:**
- Modify: `services/content/model_usage.ts`
- Test: `tests/model_usage.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `costOf(model, inputTokens, outputTokens, thinkingTokens): number` (시그니처 불변), `MODEL_PRICING`에 `'gemini-embedding-001'` 추가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/model_usage.test.ts` 끝에 붙인다.

```ts
test('표에 없는 모델은 0이 아니라 가장 비싼 단가로 친다', () => {
  // 모르는 것을 0으로 치면 새 모델을 붙인 날 비용이 조용히 사라진다.
  const unknown = costOf('gemini-99-ultra', 1_000_000, 0, 0)
  const priciest = Math.max(...Object.values(MODEL_PRICING).map(p => p.input))

  assert.equal(unknown, priciest)
  assert.ok(unknown > 0)
})

test('임베딩 모델은 출력 단가가 0이라 입력만 센다', () => {
  const only = costOf('gemini-embedding-001', 1_000_000, 0, 0)
  assert.equal(only, 0.15)
  // 출력 토큰을 넣어도 값이 늘지 않는다.
  assert.equal(costOf('gemini-embedding-001', 1_000_000, 500_000, 0), 0.15)
})
```

`MODEL_PRICING` import를 파일 상단에 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/model_usage.test.ts`
Expected: FAIL — 미상 모델이 0을 돌려준다.

- [ ] **Step 3: 구현한다**

`MODEL_PRICING`에 더한다.

```ts
  // 임베딩은 출력 토큰이 없다. 출력 단가를 0으로 두면 곱셈 하나로 같은 경로를 쓴다.
  // 2026-09-11 ai.google.dev/gemini-api/docs/pricing 기준 $0.15 / 1M input.
  'gemini-embedding-001': { input: 0.15, output: 0 },
```

`costOf`를 고친다.

```ts
// 모르는 모델의 단가. 0이 아니라 표에서 가장 비싼 값을 쓴다.
// 모르는 것을 0으로 치면 비용 계측이 조용히 무력해진다 - 새 모델을 붙인 날
// 그 호출은 공짜로 기록되고, 청구서를 받고서야 안다.
// 과대평가는 알림을 부르지만 과소평가는 청구서를 부른다.
const priciest = () => Object.values(MODEL_PRICING)
  .reduce((a, b) => (a.input + a.output > b.input + b.output ? a : b))

export const costOf = (model: string, inputTokens: number, outputTokens: number, thinkingTokens: number) => {
  const price = MODEL_PRICING[model]
  if (!price) log.error(`model_usage: 단가표에 없는 모델 '${model}'. 가장 비싼 단가로 계산한다.`)

  const p = price || priciest()

  return (inputTokens / 1e6) * p.input + ((outputTokens + thinkingTokens) / 1e6) * p.output
}
```

`import { log } from '../../core/logger'`를 상단에 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS. 기존 `model_usage.test.ts`와 `real_time_position.test.ts`도 함께 통과해야 한다.

- [ ] **Step 5: 커밋**

```bash
git add services/content/model_usage.ts tests/model_usage.test.ts
git commit -m "$(cat <<'EOF'
fix: 단가표에 없는 모델을 공짜로 세지 않는다

0으로 치면 새 모델을 붙인 날 비용이 조용히 사라진다. 가장 비싼 단가로
계산하고 로그를 남긴다. 임베딩 모델 단가도 함께 넣는다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 표 둘을 만든다

**Files:**
- Create: `entities/ai_usage.ts`, `entities/ai_usage_daily.ts`, `tools/sql/001_ai_usage.sql`

**Interfaces:**
- Produces: 엔티티 `AiUsage`, `AiUsageDaily`. 태스크 타입 `TypeAiTask = 'position_read' | 'post_answer' | 'embed_index' | 'embed_query'`

- [ ] **Step 1: 엔티티를 쓴다**

`entities/ai_usage.ts`:

```ts
import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

// AI 호출 한 건이 한 행이다. 90일 뒤에 지운다 - 되짚을 일이 없는 데이터를
// 영원히 들고 있을 이유가 없고, 그 이전 기간은 ai_usage_daily가 답한다.
export type TypeAiTask = 'position_read' | 'post_answer' | 'embed_index' | 'embed_query'

@Entity({ name: 'ai_usage' })
@Index(['task', 'createdAt'])
export class AiUsage extends BaseModel {
  @Column({ length: 32 })
  task: TypeAiTask

  @Column({ length: 64 })
  model: string

  @Column({ default: 0 })
  inputTokens: number

  @Column({ default: 0 })
  outputTokens: number

  @Column({ default: 0 })
  thinkingTokens: number

  // USD의 100만분의 1, 정수. 부동소수를 누적하면 오차가 쌓이고, 원화로 적으면
  // 환율이 움직인 뒤 과거 기록이 조용히 틀린 값이 된다.
  @Column({ default: 0 })
  costMicros: number

  @Column({ default: 0 })
  latencyMs: number

  // 토큰이 0인 실패 호출도 행을 남긴다. 어느 날 실패가 치솟는 것이 이상 징후인데,
  // 행이 없으면 그게 보이지 않는다.
  @Column({ default: true })
  ok: boolean

  @Column({ type: 'text', nullable: true })
  error: string

  @Column({ length: 32, nullable: true })
  refType: string

  @Column({ length: 64, nullable: true })
  refId: string

  @Column({ length: 64, nullable: true })
  requester: string
}
```

`entities/ai_usage_daily.ts`:

```ts
import { Entity, Column, PrimaryColumn } from 'typeorm'

// 날짜·모델·태스크당 한 행. 영구 보관한다. 하루 몇 행이라 1년에 수천 행이다.
//
// 모델이 키에 들어가는 이유: 단가표가 틀렸던 것이 나중에 드러나도 모델별 토큰이
// 남아 있으면 다시 계산할 수 있다. 한 칸에 합치면 되돌릴 수 없는 숫자가 된다.
@Entity({ name: 'ai_usage_daily' })
export class AiUsageDaily {
  // UTC 'YYYY-MM-DD'. 서버 로케일에 흔들리면 안 되므로 UTC로 못 박는다.
  @PrimaryColumn({ length: 10 })
  day: string

  @PrimaryColumn({ length: 64 })
  model: string

  @PrimaryColumn({ length: 32 })
  task: string

  @Column({ default: 0 })
  requests: number

  // 서비스 전체 합이라 integer의 상한($2,147)에 언젠가 닿는다.
  @Column({ type: 'bigint', default: 0 })
  tokensIn: number

  @Column({ type: 'bigint', default: 0 })
  tokensOut: number

  @Column({ type: 'bigint', default: 0 })
  tokensThinking: number

  @Column({ type: 'bigint', default: 0 })
  costMicros: number
}
```

- [ ] **Step 2: SQL을 쓴다**

`tools/sql/001_ai_usage.sql`. 엔티티와 손으로 맞춘 스냅샷이다. 두 번 돌려도 안전해야 한다.

```sql
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
  tokens_in       bigint NOT NULL DEFAULT 0,
  tokens_out      bigint NOT NULL DEFAULT 0,
  tokens_thinking bigint NOT NULL DEFAULT 0,
  cost_micros     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, task)
);
```

- [ ] **Step 3: 컴파일을 확인한다**

Run: `npm run build`
Expected: 타입 오류 없이 끝난다. 엔티티는 `ormconfig`의 `entities` 글롭이 자동으로 집는다.

- [ ] **Step 4: 커밋**

```bash
git add entities/ai_usage.ts entities/ai_usage_daily.ts tools/sql/001_ai_usage.sql
git commit -m "$(cat <<'EOF'
feat: AI 사용량 표 둘을 만든다

ai_usage는 호출 한 건이 한 행이고 90일 보관한다. ai_usage_daily는
날짜·모델·태스크당 한 행이고 영구 보관한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 기록 모듈

**Files:**
- Create: `services/ai_usage.ts`, `tests/ai_usage.test.ts`

**Interfaces:**
- Consumes: `costOf` (Task 1), `AiUsage` (Task 2)
- Produces:
  - `aiUsage.record(o: IRecordInput): Promise<void>` — 던지지 않는다
  - `IRecordInput = { task, model, usageMetadata?, inputTokens?, outputTokens?, thinkingTokens?, latencyMs?, ok?, error?, ref?: { type, id }, requester? }`
  - `aiUsage.insert(row)` — DB를 타는 유일한 지점. 테스트가 갈아끼운다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/ai_usage.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import aiUsage from '../services/ai_usage'

// DB를 타는 지점을 갈아끼워 무엇이 적히려 했는지만 본다.
// (tests/real_time_position.test.ts가 autoParse를 갈아끼우는 방식과 같다)
const captured = async (fn: () => Promise<unknown>) => {
  const rows = []
  const original = aiUsage.insert
  aiUsage.insert = (async row => { rows.push(row) }) as never
  try {
    await fn()
  } finally {
    aiUsage.insert = original
  }
  return rows
}

test('SDK의 usageMetadata에서 토큰을 뽑아 비용까지 적는다', async () => {
  const rows = await captured(() => aiUsage.record({
    task: 'position_read',
    model: 'gemini-3.8-flash',
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 400 },
    latencyMs: 1234,
    ref: { type: 'streamer', id: 'p1' },
  }))

  assert.equal(rows.length, 1)
  assert.equal(rows[0].inputTokens, 1000)
  assert.equal(rows[0].outputTokens, 200)
  // thinking은 candidates에 포함되지 않고 따로 오지만 과금은 출력 단가다.
  assert.equal(rows[0].thinkingTokens, 400)
  // (1000/1e6)*0.75 + (600/1e6)*3.75 = 0.00075 + 0.00225 = 0.003 USD = 3000 micros
  assert.equal(rows[0].costMicros, 3000)
  assert.equal(rows[0].refType, 'streamer')
  assert.equal(rows[0].refId, 'p1')
  assert.equal(rows[0].ok, true)
})

test('실패한 호출도 행을 남긴다', async () => {
  const rows = await captured(() => aiUsage.record({
    task: 'post_answer',
    model: 'gemini-3.8-flash',
    ok: false,
    error: 'deadline exceeded',
  }))

  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, false)
  assert.equal(rows[0].inputTokens, 0)
  assert.match(rows[0].error, /deadline/)
})

test('기록이 실패해도 부르는 쪽으로 예외가 새지 않는다', async () => {
  const original = aiUsage.insert
  aiUsage.insert = (async () => { throw new Error('DB가 죽었다') }) as never
  try {
    // 계측이 본래 동작을 막으면 안 된다. 던지면 이 테스트가 깨진다.
    await aiUsage.record({ task: 'embed_query', model: 'gemini-embedding-001', inputTokens: 20 })
  } finally {
    aiUsage.insert = original
  }
})

test('토큰을 직접 넘기면 usageMetadata 없이도 적는다', async () => {
  // 임베딩 응답에는 usageMetadata가 없다. 글자 수에서 추정한 값이 직접 온다.
  const rows = await captured(() => aiUsage.record({
    task: 'embed_index',
    model: 'gemini-embedding-001',
    inputTokens: 2_000_000,
  }))

  assert.equal(rows[0].inputTokens, 2_000_000)
  // (2e6/1e6)*0.15 = 0.3 USD = 300000 micros
  assert.equal(rows[0].costMicros, 300_000)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/ai_usage.test.ts`
Expected: FAIL — `services/ai_usage`가 없다.

- [ ] **Step 3: 구현한다**

`services/ai_usage.ts`:

```ts
import { AiUsage, TypeAiTask } from '../entities/ai_usage'
import { costOf } from './content/model_usage'
import { dataSource } from '../database'
import { log } from '../core/logger'

export type IRecordInput = {
  task: TypeAiTask,
  model: string,
  // 생성 호출은 SDK가 이걸 준다. 임베딩 호출은 주지 않으므로 아래 토큰을 직접 넘긴다.
  usageMetadata?: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number },
  inputTokens?: number,
  outputTokens?: number,
  thinkingTokens?: number,
  latencyMs?: number,
  ok?: boolean,
  error?: string,
  ref?: { type: string, id: string | number },
  requester?: string,
}

// USD를 micros로. 소수를 그대로 쌓으면 오차가 누적되므로 적는 순간 정수로 만든다.
const toMicros = (usd: number) => Math.round(usd * 1e6)

const aiUsage = {
  // DB를 타는 유일한 지점. 테스트가 이걸 갈아끼운다.
  insert: async (row: Partial<AiUsage>) => {
    await dataSource.getRepository(AiUsage).insert(row)
  },
  // 절대 던지지 않고, 부르는 쪽은 기다리지 않아도 된다.
  // 계측이 본래 동작을 막거나 늦추면 안 된다.
  record: async (o: IRecordInput) => {
    try {
      const m = o.usageMetadata || {}
      const inputTokens = o.inputTokens ?? m.promptTokenCount ?? 0
      const outputTokens = o.outputTokens ?? m.candidatesTokenCount ?? 0
      const thinkingTokens = o.thinkingTokens ?? m.thoughtsTokenCount ?? 0

      await aiUsage.insert({
        task: o.task,
        model: o.model,
        inputTokens,
        outputTokens,
        thinkingTokens,
        costMicros: toMicros(costOf(o.model, inputTokens, outputTokens, thinkingTokens)),
        latencyMs: o.latencyMs || 0,
        ok: o.ok !== false,
        error: o.error || null,
        refType: (o.ref || {} as never).type || null,
        refId: o.ref ? String(o.ref.id) : null,
        requester: o.requester || null,
      })
    } catch (e) {
      log.error('aiUsage.record 실패', e)
    }
  },
}

export default aiUsage
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add services/ai_usage.ts tests/ai_usage.test.ts
git commit -m "$(cat <<'EOF'
feat: AI 호출을 한 건씩 적는 기록 모듈을 만든다

던지지 않고 기다리게 하지 않는다. 계측이 본래 동작을 막으면 안 된다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 기존 두 호출에 붙인다

**Files:**
- Modify: `services/content/real_time_position.ts` (`autoParse`)
- Modify: `services/post.ts` (`allWithLLM`)

**Interfaces:**
- Consumes: `aiUsage.record` (Task 3)
- Produces: 없음. 기존 반환값은 그대로다.

- [ ] **Step 1: 판독에 붙인다**

`real_time_position.ts`의 `autoParse`에서 `generateContent` 앞뒤를 잰다.

```ts
    const startedAt = Date.now()
    const result = await genAI.models.generateContent({ /* 기존 그대로 */ })

    // 계측. 프레임을 여러 장 보면 호출도 여러 번이므로 행도 여러 개 남는다.
    // 기다리지 않는다 - 판독 응답이 계측 때문에 늦어지면 안 된다.
    void aiUsage.record({
      task: 'position_read',
      model: POSITION_MODEL,
      usageMetadata: result.usageMetadata,
      latencyMs: Date.now() - startedAt,
      requester: 'desktop',
    })
```

`import aiUsage from '../ai_usage'`를 상단에 더한다.

- [ ] **Step 2: 답변에 붙이고 모델을 고정한다**

`services/post.ts`의 `allWithLLM`에서 모델 상수를 올린다.

```ts
// 떠다니는 별칭(gemini-flash-latest)을 쓰지 않는다. 구글이 별칭을 다음 티어로
// 옮기면 배포도 하지 않았는데 단가와 응답 성향이 함께 바뀌고, 단가표에 그 이름이
// 없어 비용이 미상으로 기록된다. 판독 쪽이 같은 이유로 이미 고정돼 있다.
//
// 이 모델은 2027-01-01에 $1.50 / $7.50으로 두 배가 된다. 그날이 오면
// model_usage.ts의 MODEL_PRICING을 함께 고쳐야 한다 - 표를 안 고치면 기록된
// 원가만 절반으로 남고 청구서는 두 배로 온다.
const ANSWER_MODEL = 'gemini-3.8-flash'
```

`generate`를 고친다.

```ts
      const generate = async (parts: Array<{ text: string }>) => {
        const startedAt = Date.now()
        try {
          const result = await genAI.models.generateContent({
            model: ANSWER_MODEL,
            contents: parts,
            config: { responseMimeType: 'application/json' },
          })
          void aiUsage.record({
            task: 'post_answer',
            model: ANSWER_MODEL,
            usageMetadata: result.usageMetadata,
            latencyMs: Date.now() - startedAt,
            requester: c.req.ip,
          })
          return result
        } catch (e) {
          // 실패한 호출도 남긴다. 실패가 치솟는 것이 이상 징후인데 행이 없으면 안 보인다.
          void aiUsage.record({
            task: 'post_answer',
            model: ANSWER_MODEL,
            latencyMs: Date.now() - startedAt,
            ok: false,
            error: (e || {}).message || String(e),
            requester: c.req.ip,
          })
          throw e
        }
      }
```

`import aiUsage from './ai_usage'`를 상단에 더한다.

- [ ] **Step 3: 기존 테스트가 깨지지 않는지 확인한다**

Run: `npm test`
Expected: PASS. `real_time_position.test.ts`는 `autoParse`를 통째로 갈아끼우므로 계측 경로를 타지 않는다.

- [ ] **Step 4: 빌드를 확인한다**

Run: `npm run build`
Expected: 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add services/content/real_time_position.ts services/post.ts
git commit -m "$(cat <<'EOF'
feat: 판독과 답변 호출에 계측을 붙인다

allWithLLM이 쓰던 gemini-flash-latest를 gemini-3.8-flash로 고정한다.
별칭은 배포 없이 단가가 바뀌고 단가표에도 걸리지 않는다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 야간 집계와 정리

**Files:**
- Modify: `services/ai_usage.ts`
- Modify: `services/cron.ts`
- Test: `tests/ai_usage.test.ts`

**Interfaces:**
- Consumes: `aiUsage.insert` 패턴
- Produces:
  - `aiUsage.rollup(day?: string): Promise<number>` — 집계한 행 수를 돌려준다
  - `aiUsage.prune(days?: number): Promise<number>` — 지운 행 수를 돌려준다
  - `aiUsage.aggregate(day)` — DB를 타는 지점. 테스트가 갈아끼운다
  - `aiUsage.utcDay(offsetDays?: number): string` — UTC 'YYYY-MM-DD'

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
test('집계는 같은 날을 두 번 돌려도 값이 두 배가 되지 않는다', async () => {
  // cron은 프로세스 시작 시각 기준이라 재배포가 잦으면 같은 날을 여러 번 집계한다.
  // 더하지 않고 덮어써야 하는 이유다.
  const upserted = []
  const originalAgg = aiUsage.aggregate
  const originalUpsert = aiUsage.upsertDaily
  aiUsage.aggregate = (async () => ([
    { day: '2026-09-10', model: 'gemini-3.8-flash', task: 'position_read', requests: 12, tokensIn: 100, tokensOut: 20, tokensThinking: 5, costMicros: 3000 },
  ])) as never
  aiUsage.upsertDaily = (async rows => { upserted.push(...rows) }) as never

  try {
    await aiUsage.rollup('2026-09-10')
    await aiUsage.rollup('2026-09-10')
  } finally {
    aiUsage.aggregate = originalAgg
    aiUsage.upsertDaily = originalUpsert
  }

  // 두 번 올라갔지만 값은 같다. 합산이 아니라 덮어쓰기여야 한다.
  assert.equal(upserted.length, 2)
  assert.deepEqual(upserted[0], upserted[1])
  assert.equal(upserted[0].requests, 12)
})

test('utcDay는 서버 로케일과 무관하게 UTC 날짜를 준다', () => {
  assert.match(aiUsage.utcDay(), /^\d{4}-\d{2}-\d{2}$/)
  const today = new Date(aiUsage.utcDay())
  const yesterday = new Date(aiUsage.utcDay(-1))
  assert.equal((today.getTime() - yesterday.getTime()) / (1000 * 60 * 60 * 24), 1)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test tests/ai_usage.test.ts`
Expected: FAIL — `rollup`이 없다.

- [ ] **Step 3: 구현한다**

`services/ai_usage.ts`에 더한다.

```ts
  // UTC 'YYYY-MM-DD'. 서버 로케일에 흔들리면 집계 경계가 날마다 달라진다.
  utcDay: (offsetDays = 0) => {
    const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    return d.toISOString().slice(0, 10)
  },

  // 하루치 원본을 (모델, 태스크)로 접는다. DB를 타는 지점.
  aggregate: async (day: string) => {
    const rows = await dataSource.getRepository(AiUsage)
      .createQueryBuilder('u')
      .select('u.model', 'model')
      .addSelect('u.task', 'task')
      .addSelect('count(*)', 'requests')
      .addSelect('sum(u.input_tokens)', 'tokensIn')
      .addSelect('sum(u.output_tokens)', 'tokensOut')
      .addSelect('sum(u.thinking_tokens)', 'tokensThinking')
      .addSelect('sum(u.cost_micros)', 'costMicros')
      .where(`u.created_at >= :day::date AND u.created_at < (:day::date + interval '1 day')`, { day })
      .groupBy('u.model')
      .addGroupBy('u.task')
      .getRawMany()

    return rows.map(r => ({
      day,
      model: r.model,
      task: r.task,
      requests: Number(r.requests),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      tokensThinking: Number(r.tokensThinking),
      costMicros: Number(r.costMicros),
    }))
  },

  // 덮어쓴다. 더하지 않는다 - 같은 날을 두 번 집계해도 값이 두 배가 되면 안 된다.
  upsertDaily: async (rows: Partial<AiUsageDaily>[]) => {
    if (!rows.length) return
    await dataSource.getRepository(AiUsageDaily)
      .upsert(rows, { conflictPaths: ['day', 'model', 'task'], skipUpdateIfNoValuesChanged: false })
  },

  rollup: async (day?: string) => {
    const target = day || aiUsage.utcDay(-1)
    try {
      const rows = await aiUsage.aggregate(target)
      await aiUsage.upsertDaily(rows)
      log.info(`aiUsage.rollup: ${target} — ${rows.length}행`)
      return rows.length
    } catch (e) {
      log.error('aiUsage.rollup 실패', e)
      return 0
    }
  },

  // 90일 지난 원본을 지운다. 그 이전 기간은 daily가 답한다.
  prune: async (days = 90) => {
    try {
      const result = await dataSource.getRepository(AiUsage)
        .createQueryBuilder()
        .delete()
        .where(`created_at < now() - (:days || ' days')::interval`, { days })
        .execute()
      return result.affected || 0
    } catch (e) {
      log.error('aiUsage.prune 실패', e)
      return 0
    }
  },
```

`AiUsageDaily` import를 더한다.

- [ ] **Step 4: cron에 등록한다**

`services/cron.ts`의 `run()` 안에 더한다.

```ts
    cron.addJob({
      id: 'rollupAiUsage',
      // 어제치를 접고 90일 지난 원본을 지운다. 집계는 덮어쓰기라 여러 번 돌아도 안전하다.
      runnable: async () => {
        await aiUsage.rollup()
        await aiUsage.prune()
      },
      interval: 1000 * 60 * 60 * 24,
    })
```

`import aiUsage from './ai_usage'`를 더한다.

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test && npm run build`
Expected: PASS, 빌드 오류 없음.

- [ ] **Step 6: 커밋**

```bash
git add services/ai_usage.ts services/cron.ts tests/ai_usage.test.ts
git commit -m "$(cat <<'EOF'
feat: 사용량을 야간에 접고 90일 지난 원본을 지운다

집계는 합산이 아니라 덮어쓰기다. cron은 프로세스 시작 시각 기준이라
재배포가 잦으면 같은 날을 여러 번 집계한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 조회 엔드포인트

**Files:**
- Modify: `services/ai_usage.ts`, `controllers/admin_controller.ts`, `routes.ts`

**Interfaces:**
- Consumes: `AiUsageDaily`
- Produces: `GET /admin/ai_usage?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ data, total, totalCostMicros }`

- [ ] **Step 1: 조회 함수를 더한다**

`services/ai_usage.ts`:

```ts
  // 기간의 daily 행. 기본은 최근 30일이다.
  daily: async (from?: string, to?: string) => {
    const start = from || aiUsage.utcDay(-30)
    const end = to || aiUsage.utcDay()

    const data = await dataSource.getRepository(AiUsageDaily)
      .createQueryBuilder('d')
      .where('d.day >= :start AND d.day <= :end', { start, end })
      .orderBy('d.day', 'DESC')
      .addOrderBy('d.cost_micros', 'DESC')
      .getMany()

    return {
      data,
      total: data.length,
      totalCostMicros: data.reduce((sum, o) => sum + Number(o.costMicros), 0),
    }
  },
```

- [ ] **Step 2: 컨트롤러를 더한다**

`controllers/admin_controller.ts`:

```ts
  aiUsage: {
    all: async (c: IContext) => {
      try {
        c.res.asJSON(await aiUsageService.daily(c.req.query['from'], c.req.query['to']))
      } catch (e) {
        c.res.failed(e)
      }
    },
  },
```

`import aiUsageService from '../services/ai_usage'`를 더한다.

- [ ] **Step 3: 라우트를 등록한다**

`routes.ts`의 `admin()` 안, `/admin/crons` 줄 아래에 더한다.

```ts
    router.get('/admin/ai_usage', ctrls.admin.aiUsage.all, middlewares.auth.admin.super)
```

- [ ] **Step 4: 빌드를 확인한다**

Run: `npm test && npm run build`
Expected: PASS, 오류 없음.

- [ ] **Step 5: 커밋**

```bash
git add services/ai_usage.ts controllers/admin_controller.ts routes.ts
git commit -m "$(cat <<'EOF'
feat: 어드민이 AI 사용량 집계를 읽는 경로를 연다

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 프로덕션에 적용하고 눈으로 확인한다

**Files:** 없음 (운영 작업)

- [ ] **Step 1: 스키마를 올린다**

```bash
scp -i ~/.ssh/kispi-seoul.pem tools/sql/001_ai_usage.sql ubuntu@webserver.coinsect.io:~/
ssh -i ~/.ssh/kispi-seoul.pem ubuntu@webserver.coinsect.io \
  "sudo -u postgres psql -d coinsect -f ~/001_ai_usage.sql"
```

Expected: `CREATE TABLE` 둘, `CREATE INDEX` 둘.

- [ ] **Step 2: 배포한다**

기존 배포 절차를 따른다(`npm run build` 후 pm2 재시작).

- [ ] **Step 3: 행이 실제로 쌓이는지 본다**

데스크톱 캡처가 한 바퀴 돈 뒤:

```bash
ssh -i ~/.ssh/kispi-seoul.pem ubuntu@webserver.coinsect.io \
  "sudo -u postgres psql -d coinsect -c \"select task, model, count(*), sum(cost_micros) from ai_usage group by 1,2\""
```

Expected: `position_read` 행이 보이고 `cost_micros`가 0이 아니다.

**0이면 멈추고 원인을 찾는다.** 단가표에 모델 이름이 없거나 `usageMetadata`가 비어 있는 것이다. 두 경우 모두 로그에 남는다.

- [ ] **Step 4: 집계를 손으로 한 번 돌려 확인한다**

집계는 하루 한 번이라 배포 직후에는 확인할 수 없다. `GET /admin/ai_usage`가 빈 배열을 주는 것이 정상이며, 다음 날 값이 차는지 본다.

---

## Self-Review

**스펙 대응:** §4.1 → Task 2. §4.2 → Task 2. §4.3 → Task 1. §4.4 → Task 3. §4.5 → Task 4. §4.6 → Task 5. §4.7 → Task 6. 적용은 Task 7.

**남은 것:** B 계획(`2026-09-11-rag-search.md`)의 임베딩 경로가 `embed_index`와 `embed_query`를 기록한다. 이 계획에서는 태스크 타입만 정의하고 실제 기록은 B에서 붙인다.
