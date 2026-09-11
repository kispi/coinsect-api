import { test } from 'node:test'
import assert from 'node:assert/strict'
import indexer from '../services/rag/indexer'
import embedding from '../services/rag/embedding'
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

test('15분 지난 잠금은 죽은 것으로 보고 뺏는다', async () => {
  await unlocked()
  // 해시 필드에는 개별 만료가 없다. 배수 도중 프로세스가 죽으면 잠금이 영원히 남는다.
  // 죽은 것으로 보는 기준(15분)은 cron 주기(5분)보다 넉넉해야 한다 - 같으면 배수
  // 한 번이 살짝만 늘어져도 다음 틱이 곧바로 뺏어 같은 잡을 두 배수가 처리한다.
  const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString()
  await cache.hSet(LOCK_KEY, 'drain', sixteenMinutesAgo)

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
  // replaceChunks 자체를 갈아끼우면 함수 본문이 비어 있어도 통과한다. indexer.query를
  // 갈아끼워 실제로 실행되는 문장과 파라미터를 본다.
  const calls: { text: string, params: unknown[] }[] = []
  const original = indexer.query
  indexer.query = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params || [] })
    return []
  }) as never

  try {
    await indexer.replaceChunks(7, 1, [{ content: 'a', hash: 'h', vector: null }])
  } finally {
    indexer.query = original
  }

  const deleteCall = calls.find(c => /DELETE FROM post_chunks WHERE post_id = \$1 AND chunk_index >= \$2/.test(c.text))
  assert.ok(deleteCall, '남는 꼬리를 지우는 문장이 있어야 한다')
  // 글이 한 조각으로 줄었으니 인덱스 1 이상(=둘째 조각부터)을 지워야 한다.
  assert.deepEqual(deleteCall.params, [7, 1])

  const insertCalls = calls.filter(c => /INSERT INTO post_chunks/.test(c.text))
  assert.equal(insertCalls.length, 1)

  // 삭제가 upsert보다 먼저 실행되면, 짧아진 글의 새 청크까지 함께 지워버릴 수 있다.
  assert.ok(calls.indexOf(insertCalls[0]) < calls.indexOf(deleteCall))
})

test('같은 잡을 두 번 처리해도 청크가 중복되지 않는다', async () => {
  // (post_id, chunk_index) 유니크가 보장하지만, upsert 구문과 실제로 나가는
  // 파라미터가 맞는지 눈으로 본다.
  const calls: { text: string, params: unknown[] }[] = []
  const original = indexer.query
  indexer.query = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params: params || [] })
    return []
  }) as never

  try {
    await indexer.replaceChunks(7, 1, [{ content: 'a', hash: 'h', vector: [0.1] }])
  } finally {
    indexer.query = original
  }

  const upsertCall = calls.find(c => /ON CONFLICT \(post_id, chunk_index\) DO UPDATE/.test(c.text))
  assert.ok(upsertCall)
  // postId, boardId, chunkIndex, content 순서로 실제 값이 나가야 한다.
  assert.deepEqual(upsertCall.params.slice(0, 4), [7, 1, 0, 'a'])

  const deleteCall = calls.find(c => /chunk_index >= \$2/.test(c.text))
  assert.ok(deleteCall, '남는 꼬리를 지우는 문장이 있어야 한다')
  // 파라미터가 [postId, rows.length]가 아니라면(예: 항상 0) 있는 청크까지 지운다.
  assert.deepEqual(deleteCall.params, [7, 1])

  assert.ok(calls.indexOf(upsertCall) < calls.indexOf(deleteCall), '삭제는 upsert 뒤에 와야 한다')
})

// indexer.query가 유일한 raw SQL 접점이라 DB 없이는 실제 행 단위 동작을
// 검증할 수 없다. 대신 sweep이 만드는 SQL 문 자체를 확인한다 - failed 잡을
// 되살리는 조건이 indexed_at이 아니라 failed_at(또는 그것이 비어 있을 때의
// updated_at)과 posts.updated_at의 비교에 걸려 있는지가 핵심이다.
test('훑기는 failed 잡을 indexed_at이 아니라 failed_at 비교로 되살린다', async () => {
  const sql: string[] = []
  const original = indexer.query
  indexer.query = (async (text: string) => { sql.push(text); return [] }) as never

  try {
    await indexer.sweep()
  } finally {
    indexer.query = original
  }

  const insertSql = sql.find(s => /INSERT INTO embedding_jobs/.test(s))
  assert.ok(insertSql, 'sweep은 embedding_jobs에 삽입하는 문장을 실행해야 한다')

  // failed가 아닌 잡만 indexed_at 비교로 되살아난다.
  assert.ok(/j\.status <> 'failed' AND \(j\.indexed_at IS NULL OR p\.updated_at > j\.indexed_at\)/.test(insertSql))
  // failed 잡은 별도 갈래에서 failed_at(없으면 updated_at)과 글의 updated_at을
  // 비교해야만 되살아난다. NULL과의 비교는 항상 거짓이라 COALESCE 없이 failed_at만
  // 보면 이 컬럼이 생기기 전에 실패한 행은 영영 못 살아난다.
  assert.ok(/j\.status = 'failed' AND p\.updated_at > COALESCE\(j\.failed_at, j\.updated_at\)/.test(insertSql))
})

test('되살아난 잡의 시도 횟수는 failed였을 때만 초기화된다', async () => {
  const sql: string[] = []
  const original = indexer.query
  indexer.query = (async (text: string) => { sql.push(text); return [] }) as never

  try {
    await indexer.sweep()
  } finally {
    indexer.query = original
  }

  const insertSql = sql.find(s => /INSERT INTO embedding_jobs/.test(s))

  // pending 잡은 indexed_at이 아직 NULL인 동안 이 문장에 매 주기 다시 걸린다.
  // 그때마다 attempts를 무조건 0으로 되돌리면, drain이 올린 시도 횟수가 다음
  // 훑기에서 지워져 잡이 영원히 failed에 도달하지 못한다(비용 누수가 재현된다).
  // failed였던 잡이 되살아날 때만 0으로 되돌려야 한다.
  assert.ok(
    /attempts = CASE WHEN embedding_jobs\.status = 'failed' THEN 0 ELSE embedding_jobs\.attempts END/.test(insertSql),
  )
  assert.ok(/failed_at = NULL/.test(insertSql))
  // 옛 버그였던 무조건 초기화 형태가 남아 있지 않은지 확인한다.
  assert.ok(!/attempts = 0,/.test(insertSql), 'attempts를 조건 없이 0으로 두면 안 된다')
})

test('drain이 실패 시각을 앱 시계가 아니라 DB의 now()로 찍는다', async () => {
  const sql: string[] = []
  const originalQuery = indexer.query
  const originalRunJob = indexer.runJob

  indexer.query = (async (text: string, params?: unknown[]) => {
    sql.push(text)
    if (/^SELECT id, post_id, attempts FROM embedding_jobs/.test(text)) {
      return [{ id: 1, post_id: 7, attempts: 4 }]
    }
    return []
  }) as never
  indexer.runJob = (async () => { throw new Error('항상 실패') }) as never

  try {
    await unlocked()
    await indexer.drain()
  } finally {
    indexer.query = originalQuery
    indexer.runJob = originalRunJob
    await unlocked()
  }

  const updateSql = sql.find(s => /UPDATE embedding_jobs SET attempts/.test(s))
  assert.ok(updateSql)
  // JS Date를 파라미터로 넘기면 앱 서버와 DB 시계가 어긋날 때 posts.updated_at과의
  // 비교 기준이 밀린다. now()를 SQL 안에서 직접 써야 한다.
  assert.ok(/failed_at = CASE WHEN \$4 = 'failed' THEN now\(\) END/.test(updateSql))
})

test('임베딩이 전부 실패하면 done으로 찍지 않고 던진다', async () => {
  // embedding.embed는 설계상 던지지 않고 null을 채운다. runJob이 그 null을 그대로
  // 받아들이면 API 장애 때도 성공한 것처럼 기록되어, 그 글은 벡터 검색에서
  // 영영 빠지는데 아무 데도 드러나지 않는다.
  const originalQuery = indexer.query
  const originalEmbed = embedding.embed

  indexer.query = (async (text: string) => {
    if (/^SELECT id, board_id, title, content FROM posts/.test(text)) {
      return [{ id: 7, board_id: 1, title: '제목', content: '내용' }]
    }
    return []
  }) as never
  embedding.embed = (async (texts: string[]) => texts.map(() => null)) as never

  try {
    await assert.rejects(() => indexer.runJob({ id: 1, post_id: 7, attempts: 0 }))
  } finally {
    indexer.query = originalQuery
    embedding.embed = originalEmbed
  }
})

test('임베딩이 일부만 실패하면 나머지로 done을 찍는다', async () => {
  // 청크 하나가 계속 실패한다고 글 전체의 검색 가능성을 막을 이유는 없다.
  const longSource = `${'가'.repeat(500)}\n\n${'나'.repeat(500)}`
  const originalQuery = indexer.query
  const originalEmbed = embedding.embed
  const calls: string[] = []

  indexer.query = (async (text: string) => {
    calls.push(text)
    if (/^SELECT id, board_id, title, content FROM posts/.test(text)) {
      return [{ id: 7, board_id: 1, title: '', content: longSource }]
    }
    return []
  }) as never
  embedding.embed = (async (texts: string[]) => texts.map((_, i) => (i === 0 ? [0.1] : null))) as never

  try {
    await indexer.runJob({ id: 1, post_id: 7, attempts: 0 })
  } finally {
    indexer.query = originalQuery
    embedding.embed = originalEmbed
  }

  assert.ok(calls.some(s => /UPDATE embedding_jobs SET status = 'done'/.test(s)))
})
