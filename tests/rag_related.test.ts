import { test } from 'node:test'
import assert from 'node:assert/strict'
import search from '../services/rag/search'

// SQL을 타는 두 지점을 갈아끼운다. tests/rag_search.test.ts가 vectorSearch를
// 갈아끼우는 방식과 같다.
const withStubs = async (
  stubs: { vector?: number[] | null, hits?: unknown[] },
  fn: () => Promise<unknown>,
) => {
  const originals = { src: search.sourceVector, rel: search.relatedSearch }
  search.sourceVector = (async () => (stubs.vector === undefined ? [0.1] : stubs.vector)) as never
  search.relatedSearch = (async () => (stubs.hits || [])) as never

  try {
    return await fn()
  } finally {
    search.sourceVector = originals.src
    search.relatedSearch = originals.rel
  }
}

const hit = (postId: number, userId: number | null, score: number, nickname: string | null = null) =>
  ({ postId, boardId: 1, userId, nickname, score })

test('색인되지 않은 글은 관련 글이 없는 것과 같게 다룬다', async () => {
  // 아직 인덱싱 전이거나 색인 대상 보드가 아닌 글이다. 여기서 던지면 글 상세가
  // 통째로 500이 된다 - 관련 글은 본문을 읽는 데 없어도 되는 곁가지다.
  const result = await withStubs({ vector: null }, () =>
    search.related({ postId: 1, boardId: 1 }))

  assert.deepEqual(result, [])
})

test('같은 글의 청크가 여럿 걸려도 관련 글은 한 줄이다', async () => {
  // 한 글이 청크 여러 개로 색인되므로 이웃 목록에는 같은 글이 반복해서 나온다.
  const result = await withStubs({
    hits: [hit(7, 10, 0.94), hit(7, 10, 0.92), hit(8, 11, 0.90)],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [7, 8])
})

test('작성자당 한 건으로 묶는다', async () => {
  // 실측에서 컷오프를 넘는 이웃 대부분이 같은 사람이 같은 형식으로 매일 쓴 글이었다.
  // 접지 않으면 관련 글이 '날짜만 다른 같은 글' 목록이 된다.
  const result = await withStubs({
    hits: [hit(7, 10, 0.95), hit(8, 10, 0.94), hit(9, 10, 0.93), hit(20, 11, 0.90)],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [7, 20])
})

test('작성자당 한 건으로 묶을 때 더 유사한 글이 남는다', async () => {
  // 같은 작성자의 글이 여럿이면 첫 번째, 즉 가장 유사한 것이 대표가 되어야 한다.
  // SQL이 유사도 순으로 돌려주므로 순서를 뒤집지 않는 것으로 충분하다.
  const result = await withStubs({
    hits: [hit(7, 10, 0.95), hit(8, 10, 0.99)],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number, score: number }[]

  assert.equal(result.length, 1)
  assert.equal(result[0].postId, 7)
  assert.equal(result[0].score, 0.95)
})

test('userId가 없는 글은 nickname으로 묶는다', async () => {
  // 이것이 실측에서 드러난 자리다. 관련 글 상위를 통째로 차지한 '[09/14] 비트코인 시황'
  // 연작이 전부 userId 없는 크롤링 글이었다. userId로만 묶으면 그 글들이 서로 다른
  // 작성자로 취급돼 장치가 정작 필요한 자리에서 아무 일도 하지 않는다.
  const result = await withStubs({
    hits: [
      hit(61, null, 0.98, 'BTjino'),
      hit(62, null, 0.97, 'BTjino'),
      hit(63, null, 0.97, 'BTjino'),
      hit(1342, 409, 0.94, '베스트코인'),
    ],
  }, () => search.related({ postId: 60, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [61, 1342])
})

test('userId와 nickname이 모두 없으면 접지 않고 통과시킨다', async () => {
  // 묶을 근거가 없는 글이다. 여기서 하나로 접으면 서로 아무 관계 없는 글들이
  // 한 건으로 사라진다.
  const result = await withStubs({
    hits: [hit(7, null, 0.95), hit(8, null, 0.94), hit(9, null, 0.93)],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [7, 8, 9])
})

test('같은 사람이 회원 글과 익명 글로 두 칸을 차지하지 않는다', async () => {
  // 실측에서 '베스트코인'이 userId 있는 글과 없는 글로 각각 한 칸씩 올라왔다.
  // userId를 우선해 하나만 쓰면 두 글의 키가 달라 접히지 않는다.
  const result = await withStubs({
    hits: [hit(7, 409, 0.95, '베스트코인'), hit(8, null, 0.94, '베스트코인')],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [7])
})

test('nickname이 같으면 서로 다른 userId여도 한 명으로 접는다', async () => {
  // 접는 쪽을 고른 대가다. 익명 글의 닉은 사람이 직접 적는 값이라 겹칠 수 있다.
  // 잃는 것은 목록의 한 칸이고, 막는 것은 같은 사람의 연작이 화면을 덮는 것이다.
  const result = await withStubs({
    hits: [hit(7, 10, 0.95, '같은닉'), hit(8, 11, 0.94, '같은닉')],
  }, () => search.related({ postId: 1, boardId: 1 })) as { postId: number }[]

  assert.deepEqual(result.map(o => o.postId), [7])
})

test('limit을 넘겨 채우지 않는다', async () => {
  const result = await withStubs({
    hits: [hit(7, 10, 0.95), hit(8, 11, 0.94), hit(9, 12, 0.93), hit(10, 13, 0.92)],
  }, () => search.related({ postId: 1, boardId: 1, limit: 2 })) as unknown[]

  assert.equal(result.length, 2)
})

test('자기 글은 애초에 조회에서 빠진다', async () => {
  // 자기 자신과의 유사도는 1.0이라 컷오프를 언제나 넘는다. JS에서 걸러내는 것이
  // 아니라 SQL이 제외해야 하고, 그러려면 자기 id가 그 질의까지 내려가야 한다.
  const passed: unknown[] = []
  const originals = { src: search.sourceVector, rel: search.relatedSearch }
  search.sourceVector = (async () => [0.1]) as never
  search.relatedSearch = (async (
    vector: number[],
    boardId: number,
    excludePostId: number,
  ) => {
    passed.push({ boardId, excludePostId })
    return []
  }) as never

  try {
    await search.related({ postId: 42, boardId: 3 })
  } finally {
    search.sourceVector = originals.src
    search.relatedSearch = originals.rel
  }

  assert.deepEqual(passed, [{ boardId: 3, excludePostId: 42 }])
})

test('접힌 뒤에도 limit을 채울 수 있도록 넉넉히 뽑는다', async () => {
  // 글 단위와 작성자 단위로 두 번 접으므로, limit만큼만 뽑으면 접은 뒤에 남는 것이
  // 거의 없다. 이 여유가 사라지면 관련 글이 비는 것으로 조용히 퇴화한다.
  const depths: number[] = []
  const originals = { src: search.sourceVector, rel: search.relatedSearch }
  search.sourceVector = (async () => [0.1]) as never
  search.relatedSearch = (async (
    vector: number[],
    boardId: number,
    excludePostId: number,
    minScore: number,
    limit: number,
  ) => {
    depths.push(limit)
    return []
  }) as never

  try {
    await search.related({ postId: 1, boardId: 1, limit: 5 })
  } finally {
    search.sourceVector = originals.src
    search.relatedSearch = originals.rel
  }

  assert.equal(depths.length, 1)
  assert.ok(depths[0] >= 50, `요청한 5건보다 훨씬 깊게 뽑아야 한다. 실제: ${depths[0]}`)
})
