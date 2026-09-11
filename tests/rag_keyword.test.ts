import { test } from 'node:test'
import assert from 'node:assert/strict'
import keyword, { buildPatterns } from '../services/rag/keyword'
import { dataSource } from '../database'

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

test('본문 조건을 함수로 감싸지 않는다', async () => {
  // posts_content_trgm_idx는 content 자체에 걸린 인덱스다. coalesce(p.content, '')로
  // 감싸면 플래너에게는 다른 식이 되어 인덱스가 무시되고, 매 검색이 1,713글 · 3.94MB
  // 순차 스캔이 된다. content는 NOT NULL이라 감쌀 이유도 없다.
  const original = dataSource.query
  let sql = ''
  dataSource.query = (async (text: string) => { sql = text; return [] }) as never

  try {
    await keyword.search('비트코인 반감기', null, 10)
  } finally {
    dataSource.query = original
  }

  assert.doesNotMatch(sql, /coalesce/i)
  assert.match(sql, /p\.content ILIKE/)
  assert.match(sql, /p\.title ILIKE/)
})
