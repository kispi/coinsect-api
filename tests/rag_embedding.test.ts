import { test } from 'node:test'
import assert from 'node:assert/strict'
import embedding, {
  computeHash,
  normalize,
  cacheTaskOf,
  estimateTokens,
  queryCacheKey,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
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

test('같은 텍스트가 배치에 두 번 있어도 API에는 한 번만 보낸다', async () => {
  const vec = new Array(EMBEDDING_DIMS).fill(0.3)
  let sent: string[] = []

  const originals = { api: embedding.callApi, get: embedding.getCached, put: embedding.putCached }
  embedding.getCached = (async () => new Map()) as never
  embedding.callApi = (async texts => { sent = texts; return texts.map(() => vec) }) as never
  embedding.putCached = (async () => {}) as never

  try {
    const out = await embedding.embed(['같은 글', '같은 글'], 'RETRIEVAL_DOCUMENT')
    assert.equal(sent.length, 1, '유니크 텍스트만 API로 보낸다')
    assert.deepEqual(out[0], vec)
    assert.deepEqual(out[1], vec)
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

test('질의 캐시 키에 차원과 태스크가 들어간다', () => {
  // 둘 중 하나라도 빠지면 차원이나 taskType을 바꾼 뒤에도 옛 벡터가 돌아오고,
  // 그 벡터는 새로 만든 것들과 다른 공간에 있어 검색이 조용히 망가진다.
  const hash = computeHash('같은 글')

  assert.notEqual(queryCacheKey(hash, 'RETRIEVAL_QUERY'), queryCacheKey(hash, 'RETRIEVAL_DOCUMENT'))
  assert.ok(queryCacheKey(hash, 'RETRIEVAL_QUERY').includes(String(EMBEDDING_DIMS)))
  assert.ok(queryCacheKey(hash, 'RETRIEVAL_QUERY').includes(EMBEDDING_MODEL))
  assert.ok(queryCacheKey(hash, 'RETRIEVAL_QUERY').includes(hash))
})

test('질의 임베딩은 Postgres를 타지 않고 공용 캐시로 간다', async () => {
  // getCached/putCached를 갈아끼우지 않는 것이 이 검사의 요점이다. 이 테스트에는
  // DB 연결이 없으므로, 질의 경로가 embedding_cache를 보러 갔다면 두 번째 호출도
  // 캐시를 못 찾아 API를 한 번 더 친다.
  const vec = new Array(EMBEDDING_DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))
  let apiCalls = 0

  const originalApi = embedding.callApi
  embedding.callApi = (async texts => { apiCalls += 1; return texts.map(() => vec) }) as never

  try {
    const q = `반감기가 뭐야 ${Date.now()}`

    assert.deepEqual((await embedding.embed([q], 'RETRIEVAL_QUERY', 'embed_query'))[0], vec)
    assert.equal(apiCalls, 1)

    assert.deepEqual((await embedding.embed([q], 'RETRIEVAL_QUERY', 'embed_query'))[0], vec)
    assert.equal(apiCalls, 1, '같은 질의는 캐시가 답한다')
  } finally {
    embedding.callApi = originalApi
  }
})

test('질의 캐시가 죽어도 던지지 않고 API로 떨어진다', async () => {
  // 캐시는 최적화일 뿐 진실의 출처가 아니다. 레디스 장애가 검색 장애가 되면 안 된다.
  const vec = new Array(EMBEDDING_DIMS).fill(0.5)
  let apiCalls = 0

  const originals = { api: embedding.callApi, get: embedding.getCachedQuery, put: embedding.putCachedQuery }
  embedding.callApi = (async texts => { apiCalls += 1; return texts.map(() => vec) }) as never
  embedding.getCachedQuery = (async () => { throw new Error('레디스가 죽었다') }) as never
  embedding.putCachedQuery = (async () => { throw new Error('레디스가 죽었다') }) as never

  try {
    const out = await embedding.embed([`무엇이든 ${Date.now()}`], 'RETRIEVAL_QUERY', 'embed_query')
    assert.deepEqual(out[0], vec)
    assert.equal(apiCalls, 1)
  } finally {
    embedding.callApi = originals.api
    embedding.getCachedQuery = originals.get
    embedding.putCachedQuery = originals.put
  }
})
