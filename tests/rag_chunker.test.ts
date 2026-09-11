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
