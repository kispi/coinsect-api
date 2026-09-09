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
