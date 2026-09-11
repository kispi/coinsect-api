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
