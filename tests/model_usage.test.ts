import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addUsage, costOf, describeUsage, emptyUsage, mergeUsage, MODEL_PRICING } from '../services/content/model_usage'

test('costOf: thinking 토큰을 출력 단가로 함께 센다', () => {
  // gemini-3.8-flash: 입력 $0.75/M, 출력 $3.75/M
  // 빼고 세면 비용이 실제보다 싸게 나온다. 2026-09-09에 이걸로 월 $80을 $21로 착각했다.
  const withThinking = costOf('gemini-3.8-flash', 1_000_000, 0, 1_000_000)
  const withoutThinking = costOf('gemini-3.8-flash', 1_000_000, 0, 0)

  assert.equal(withoutThinking, 0.75)
  assert.equal(withThinking, 0.75 + 3.75)
  // 출력과 thinking은 같은 단가다.
  assert.equal(costOf('gemini-3.8-flash', 0, 500_000, 500_000), costOf('gemini-3.8-flash', 0, 1_000_000, 0))
})

test('costOf: 단가표에 없는 모델은 가장 비싼 단가로 친다', () => {
  // 모르는 것을 0으로 치면 비용이 조용히 무력해진다. 가장 비싼 단가로 계산한다.
  const unknown = costOf('gemini-unknown', 1_000_000, 1_000_000, 0)
  const priciest = Math.max(...Object.values(MODEL_PRICING).map(p => p.input + p.output))
  assert.equal(unknown, priciest)
  assert.ok(unknown > 0)
})

test('addUsage: SDK 응답 한 건을 누계에 더한다', () => {
  const usage = addUsage(emptyUsage('gemini-3.8-flash'), {
    promptTokenCount: 1616,
    candidatesTokenCount: 77,
    thoughtsTokenCount: 254,
  })

  assert.equal(usage.calls, 1)
  assert.equal(usage.inputTokens, 1616)
  assert.equal(usage.outputTokens, 77)
  assert.equal(usage.thinkingTokens, 254)
  assert.ok(usage.costUsd > 0)

  // usageMetadata가 비어 오는 경우도 있다. 터지면 판독 자체가 실패한다.
  const empty = addUsage(emptyUsage('gemini-3.8-flash'), undefined)
  assert.equal(empty.calls, 1)
  assert.equal(empty.inputTokens, 0)
})

test('mergeUsage: 프레임을 여러 장 보면 호출도 여러 번이라 곱해진다', () => {
  const one = addUsage(emptyUsage('gemini-3.8-flash'), { promptTokenCount: 1600, candidatesTokenCount: 80 })
  const merged = mergeUsage(one, one)

  assert.equal(merged.calls, 2)
  assert.equal(merged.inputTokens, 3200)
  // 비용도 누계 토큰으로 다시 계산된다.
  assert.ok(Math.abs(merged.costUsd - one.costUsd * 2) < 1e-12)

  // 아직 아무것도 안 읽었으면 그대로 둔다.
  assert.equal(mergeUsage(one, undefined), one)
})

test('describeUsage: 호출이 없으면 아무것도 적지 않는다', () => {
  // 사람 제보는 모델을 쓰지 않는다. 여기에 '0회 판독 · $0.0000'이 붙으면 안 된다.
  assert.equal(describeUsage(emptyUsage('gemini-3.8-flash')), null)
  assert.equal(describeUsage(undefined), null)
})

test('describeUsage: 모델과 토큰, 비용을 한 줄로 적는다', () => {
  const usage = addUsage(emptyUsage('gemini-3.8-flash'), {
    promptTokenCount: 1616,
    candidatesTokenCount: 77,
    thoughtsTokenCount: 254,
  })

  assert.equal(
    describeUsage(usage),
    'gemini-3.8-flash · 1회 판독 · 입력 1,616 · 출력 77 (+thinking 254) · $0.0025',
  )
  // thinking이 0이면 괄호를 붙이지 않는다.
  assert.doesNotMatch(
    describeUsage(addUsage(emptyUsage('gemini-3.8-flash'), { promptTokenCount: 100, candidatesTokenCount: 10 })),
    /thinking/,
  )
})

test('표에 없는 모델은 0이 아니라 가장 비싼 단가로 친다', () => {
  // 모르는 것을 0으로 치면 새 모델을 붙인 날 비용이 조용히 사라진다.
  const unknown = costOf('gemini-99-ultra', 1_000_000, 0, 0)
  const priciest = Math.max(...Object.values(MODEL_PRICING).map(p => p.input))

  assert.equal(unknown, priciest)
  assert.ok(unknown > 0)
})

test('임베딩 모델은 출력 단가가 0이라 입력만 센다', () => {
  const only = costOf('gemini-embedding-001', 1_000_000, 0, 0)
  assert.equal(only, 0.15)
  // 출력 토큰을 넣어도 값이 늘지 않는다.
  assert.equal(costOf('gemini-embedding-001', 1_000_000, 500_000, 0), 0.15)
})
