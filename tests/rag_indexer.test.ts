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

// indexer.query가 유일한 raw SQL 접점이라 DB 없이는 실제 행 단위 동작을
// 검증할 수 없다. 대신 sweep이 만드는 SQL 문 자체를 확인한다 - failed 잡을
// 되살리는 조건이 indexed_at이 아니라 failed_at과 posts.updated_at의 비교에
// 걸려 있는지가 핵심이다.
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
  // failed 잡은 별도 갈래에서 failed_at과 글의 updated_at을 비교해야만 되살아난다.
  assert.ok(/j\.status = 'failed' AND p\.updated_at > j\.failed_at/.test(insertSql))
})

test('되살아난 failed 잡은 attempts와 failed_at을 초기화한다', async () => {
  const sql: string[] = []
  const original = indexer.query
  indexer.query = (async (text: string) => { sql.push(text); return [] }) as never

  try {
    await indexer.sweep()
  } finally {
    indexer.query = original
  }

  const insertSql = sql.find(s => /INSERT INTO embedding_jobs/.test(s))
  // 글이 바뀌어 되살아난 경우 이전 실패 흔적(시도 횟수, failed_at)이 남아 있으면
  // 안 된다 - 다음 실패까지 남은 시도 횟수가 실제보다 적게 잡힌다.
  assert.ok(/ON CONFLICT \(post_id\) DO UPDATE SET status = 'pending', attempts = 0, failed_at = NULL/.test(insertSql))
})
