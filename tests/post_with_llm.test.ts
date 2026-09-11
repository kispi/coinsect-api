import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnswerPrompt, DAILY_COST_CAP_MICROS } from '../services/post'

test('프롬프트에 회수된 조각만 들어간다', () => {
  const prompt = buildAnswerPrompt('반감기가 뭐야', [
    { postId: 1, boardId: 3, content: '반감기는 보상이 절반이 되는 것이다', score: 0.8, matchType: 'vector' },
  ])

  assert.match(prompt, /반감기가 뭐야/)
  assert.match(prompt, /보상이 절반/)
  // 글 전문을 넣던 옛 구조로 돌아가면 안 된다. 조각만 들어간다.
  assert.ok(prompt.length < 2000)
})

test('회수가 비면 프롬프트를 만들지 않는다', () => {
  // 근거 없이 답하게 두면 그럴듯한 거짓말이 나온다.
  assert.equal(buildAnswerPrompt('아무거나', []), null)
})

test('일일 상한이 상수로 정의되어 있다', () => {
  assert.ok(DAILY_COST_CAP_MICROS > 0)
})
