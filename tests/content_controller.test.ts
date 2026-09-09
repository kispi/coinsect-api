import { test } from 'node:test'
import assert from 'node:assert/strict'
import contentController from '../controllers/content_controller'
import IContext from '../core/interfaces/context'

// asJSON에 넘어간 값을 붙잡는 가짜 컨텍스트. fastify의 reply.send는 Promise를 받으면
// await하지 않고 그대로 직렬화해 {}를 뱉는다. 그래서 '무엇을 넘겼는지'가 곧 버그다.
const captureContext = () => {
  const captured: { value?: unknown } = {}
  return {
    captured,
    c: {
      req: { body: {}, params: {}, headers: {} },
      res: {
        asJSON: (v: unknown) => { captured.value = v },
        success: (v: unknown) => { captured.value = v },
        failed: (v: unknown) => { captured.value = v },
      },
    } as unknown as IContext,
  }
}

test('제보 목록은 Promise가 아니라 배열로 응답한다', async () => {
  const { c, captured } = captureContext()

  await contentController.realTimePositions.changeNotification.all(c)

  // Promise를 그대로 넘기면 fastify가 {}로 직렬화하고, 어드민은
  // "(o.value || []).filter is not a function"으로 죽는다.
  assert.equal(
    typeof (captured.value as { then?: unknown } || {}).then,
    'undefined',
    'Promise를 그대로 넘기면 안 된다',
  )
  assert.ok(Array.isArray(captured.value), `배열이어야 한다 (실제: ${JSON.stringify(captured.value)})`)
})

// 슬랙 인터랙션은 컨트롤러가 액션 종류를 갈라 처리한다. 체크박스 토글이 승인으로
// 새면 한 번 건드린 것만으로 포지션이 반영된다.
const slackPayload = (action: Record<string, unknown>) => ({
  req: { body: { payload: JSON.stringify({ actions: [action], user: { username: 'chanho' }, response_url: 'https://slack.test/hook' }) }, params: {}, headers: {} },
  res: { asJSON: () => undefined, success: () => undefined, failed: () => undefined },
} as unknown as IContext)

test('체크박스 토글은 승인으로 처리되지 않는다', async () => {
  const service = (await import('../services')).default()
  const calls = { resolve: 0, select: [] as unknown[] }
  const originals = {
    resolve: service.content.realTimePosition.resolveReport,
    select: service.content.realTimePosition.selectReported,
  }
  service.content.realTimePosition.resolveReport = (async () => { calls.resolve++; return { ok: true, text: '' } }) as never
  service.content.realTimePosition.selectReported = (async (id, contracts) => { calls.select.push([id, contracts]); return null }) as never

  try {
    await contentController.realTimePositions.slackInteraction(slackPayload({
      action_id: 'position_select',
      block_id: JSON.stringify({ id: 's1', reportedAt: 'r' }),
      selected_options: [{ value: 'BTCUSDT' }, { value: 'ETHUSDT' }],
    }))

    assert.equal(calls.resolve, 0, '토글은 승인을 부르지 않는다')
    assert.deepEqual(calls.select, [['s1', ['BTCUSDT', 'ETHUSDT']]])

    // 모르는 액션이 늘어나도 승인으로 새지 않아야 한다.
    await contentController.realTimePositions.slackInteraction(slackPayload({ action_id: 'something_else', value: '{}' }))
    assert.equal(calls.resolve, 0)
  } finally {
    service.content.realTimePosition.resolveReport = originals.resolve
    service.content.realTimePosition.selectReported = originals.select
  }
})
