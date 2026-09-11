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
