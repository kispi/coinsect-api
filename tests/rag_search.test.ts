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

test('벡터 SQL이 던져도 키워드 결과는 나온다', async () => {
  // embed가 null을 주는 부드러운 실패 말고, vectorSearch 자체가 타임아웃이나
  // 연결 오류로 던지는 경우다. Promise.all에 각자 catch가 없으면 이미 돌아온
  // 키워드 결과까지 함께 버려진다.
  const originals = { embed: embedding.embed, vec: search.vectorSearch, kw: keyword.search }
  embedding.embed = (async () => [[0.1]]) as never
  search.vectorSearch = (async () => { throw new Error('연결 끊김') }) as never
  keyword.search = (async () => [{ postId: 3, boardId: 1 }]) as never

  try {
    const result = await search.retrieve({ q: '질문', boardId: 1, limit: 10 }) as never[]
    assert.equal(result.length, 1)
    assert.equal(result[0]['matchType'], 'keyword')
  } finally {
    embedding.embed = originals.embed
    search.vectorSearch = originals.vec
    keyword.search = originals.kw
  }
})

test('키워드 검색이 던져도 벡터 결과는 나온다', async () => {
  const originals = { embed: embedding.embed, vec: search.vectorSearch, kw: keyword.search }
  embedding.embed = (async () => [[0.1]]) as never
  search.vectorSearch = (async () => [{ postId: 7, boardId: 1, content: '조각', score: 0.85 }]) as never
  keyword.search = (async () => { throw new Error('연결 끊김') }) as never

  try {
    const result = await search.retrieve({ q: '질문', boardId: 1, limit: 10 }) as never[]
    assert.equal(result.length, 1)
    assert.equal(result[0]['matchType'], 'vector')
  } finally {
    embedding.embed = originals.embed
    search.vectorSearch = originals.vec
    keyword.search = originals.kw
  }
})

test('빈 질의는 아무것도 찾지 않는다', async () => {
  const result = await search.retrieve({ q: '   ', boardId: 1, limit: 10 })
  assert.deepEqual(result, [])
})
