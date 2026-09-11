import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeRateLimited } from '../controllers/post_controller'
import IContext from '../core/interfaces/context'

const contextOf = (ip: string) => ({ req: { ip } }) as unknown as IContext

// 창 키는 시각을 창 길이로 나눈 몫이라, 한 테스트가 쓴 IP를 다른 테스트가 다시 쓰면
// 카운터를 이어받는다. 매번 새 IP를 만든다.
let seq = 0
const freshIp = () => `10.0.0.${seq++}:${Date.now()}`

test('한 IP가 분당 다섯 건을 넘기면 막는다', async () => {
  const c = contextOf(freshIp())

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await writeRateLimited(c), false, `${i + 1}번째 글은 통과해야 한다`)
  }

  assert.equal(await writeRateLimited(c), true)
})

test('IP를 바꿔도 전역 바구니는 피하지 못한다', async () => {
  // 이것이 요점이다. trustProxy 때문에 c.req.ip는 헤더로 위조되므로 IP 층만으로는
  // 아무것도 막지 못한다. 매번 다른 IP로 들어와도 전역 한도에서 걸려야 한다.
  let passed = 0

  for (let i = 0; i < 20; i += 1) {
    if (!await writeRateLimited(contextOf(freshIp()))) passed += 1
  }

  assert.ok(passed <= 10, `전역 한도(분당 10)를 넘겨 통과했다: ${passed}`)
})

test('쓰기와 수정이 같은 바구니를 쓴다', async () => {
  // 바구니를 나누면 같은 사람이 두 배를 쓴다. create와 update가 같은 함수를 부르므로
  // 호출 출처와 무관하게 합산된다는 것을 못 박아 둔다.
  const c = contextOf(freshIp())

  for (let i = 0; i < 5; i += 1) await writeRateLimited(c)

  assert.equal(await writeRateLimited(c), true)
})
