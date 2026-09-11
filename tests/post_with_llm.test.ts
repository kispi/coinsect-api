import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnswerPrompt, cappedCostMicros, CAPPED_TASKS, DAILY_COST_CAP_MICROS } from '../services/post'

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

test('발췌에 답이 없으면 모른다고 말하라는 거절 지시문이 들어간다', () => {
  // 근거 없이 확신에 찬 답을 만들지 않도록 모델에게 못 박아 둔다.
  const prompt = buildAnswerPrompt('질문', [
    { postId: 1, boardId: 3, content: '내용', score: 0.8, matchType: 'vector' },
  ])

  assert.match(prompt, /say so instead of guessing/)
})

test('발췌가 여럿이면 [1], [2]로 번호가 붙는다', () => {
  const prompt = buildAnswerPrompt('질문', [
    { postId: 1, boardId: 3, content: '첫 번째 내용', score: 0.8, matchType: 'vector' },
    { postId: 2, boardId: 3, content: '두 번째 내용', score: 0.6, matchType: 'keyword' },
  ])

  assert.match(prompt, /\[1\]/)
  assert.match(prompt, /\[2\]/)
})

test('content가 빈 발췌만 있으면 null을 돌려준다', () => {
  // 키워드 전용 매치는 content가 빈 문자열이다(search.ts). 회수 결과가 있어도
  // 실제로 프롬프트에 넣을 조각이 없으면 답변을 만들면 안 된다.
  assert.equal(buildAnswerPrompt('질문', [
    { postId: 1, boardId: 3, content: '', score: null, matchType: 'keyword' },
  ]), null)
})

test('일일 상한은 공개 엔드포인트의 태스크만 센다', () => {
  // 캡처 트래픽(position_read)은 하루 3,500회 · 약 $10 규모라, 함께 더하면 UTC
  // 날짜가 바뀌고 한 시간 안에 $2 상한을 넘겨 with_llm이 하루 종일 답을 못 준다.
  const rows = [
    { task: 'position_read', costMicros: 10_000_000 },
    { task: 'embed_index', costMicros: 500_000 },
    { task: 'post_answer', costMicros: 300 },
    { task: 'embed_query', costMicros: 20 },
  ]

  assert.equal(cappedCostMicros(rows), 320)
  assert.ok(cappedCostMicros(rows) < DAILY_COST_CAP_MICROS)
})

test('상한 대상은 post_answer와 embed_query 둘이다', () => {
  assert.deepEqual([...CAPPED_TASKS].sort(), ['embed_query', 'post_answer'])
})

test('상한 대상만으로도 한도를 넘으면 잡힌다', () => {
  // 필터가 상한 자체를 무력화하면 안 된다. 공개 경로가 실제로 태우면 걸려야 한다.
  const rows = [{ task: 'post_answer', costMicros: DAILY_COST_CAP_MICROS }]

  assert.ok(cappedCostMicros(rows) >= DAILY_COST_CAP_MICROS)
})
