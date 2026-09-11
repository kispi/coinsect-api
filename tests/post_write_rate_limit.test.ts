import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeIpRateLimited, mayIndexNow, IMMEDIATE_DRAIN_LIMIT } from '../controllers/post_controller'
import IContext from '../core/interfaces/context'

const contextOf = (ip: string) => ({ req: { ip } }) as unknown as IContext

// 창 키는 시각을 창 길이로 나눈 몫이라, 같은 키를 두 번 쓰면 카운터를 이어받는다.
// IP와 전역 키 둘 다 검사마다 새로 만들어야 각 검사가 자기가 재려던 것을 잰다 -
// IP만 갈면 전역 바구니는 하나뿐이라 앞선 검사가 쓴 만큼이 그대로 남는다.
let seq = 0
const fresh = (prefix: string) => `${prefix}:${Date.now()}:${seq++}`

test('한 IP가 분당 다섯 건을 넘기면 요청이 막힌다', async () => {
  const c = contextOf(fresh('10.0.0'))

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await writeIpRateLimited(c), false, `${i + 1}번째 글은 통과해야 한다`)
  }

  assert.equal(await writeIpRateLimited(c), true)
})

test('IP 층에서 막힌 요청은 전역 인덱싱 예산을 쓰지 않는다', async () => {
  // 가용성의 핵심이다. 저장에 이르지 못한 요청이 전역 예산을 태우면, 비밀번호를
  // 모르는 사람이 틀린 요청 몇 건으로 게시판 전체의 즉시 인덱싱을 잠글 수 있다.
  const c = contextOf(fresh('10.0.1'))
  const globalKey = fresh('test:write:global')

  for (let i = 0; i < 10; i += 1) await writeIpRateLimited(c)

  assert.equal(await mayIndexNow(c.req.ip, globalKey), true)
})

test('즉시 인덱싱은 분당 다섯 건까지만 전역으로 허용한다', async () => {
  const globalKey = fresh('test:write:global')

  for (let i = 0; i < 5; i += 1) {
    assert.equal(await mayIndexNow('10.0.2.1', globalKey), true, `${i + 1}번째는 통과해야 한다`)
  }

  assert.equal(await mayIndexNow('10.0.2.1', globalKey), false)
})

test('전역 예산은 IP를 바꿔도 피할 수 없다', async () => {
  // trustProxy로 c.req.ip가 위조되므로 IP 층만으로는 아무것도 막지 못한다.
  // 매번 다른 IP로 들어와도 전역 바구니 하나에서 걸려야 한다.
  const globalKey = fresh('test:write:global')
  let passed = 0

  for (let i = 0; i < 20; i += 1) {
    if (await mayIndexNow(fresh('10.0.3'), globalKey)) passed += 1
  }

  assert.equal(passed, 5)
})

test('쓰기와 수정이 같은 전역 바구니를 쓴다', async () => {
  // 둘이 만드는 인덱싱 비용이 같은데 바구니를 나누면 같은 사람이 두 배를 쓴다.
  // create와 update가 같은 기본 키를 쓰므로 호출 출처와 무관하게 합산된다.
  const globalKey = fresh('test:write:global')

  // create 세 건
  for (let i = 0; i < 3; i += 1) assert.equal(await mayIndexNow('10.0.4.1', globalKey), true)
  // update 두 건. 바구니가 갈렸다면 여기도 전부 통과하고 아래 검사가 뒤집힌다.
  for (let i = 0; i < 2; i += 1) assert.equal(await mayIndexNow('10.0.4.2', globalKey), true)

  assert.equal(await mayIndexNow('10.0.4.1', globalKey), false)
})

test('즉시 배수는 한 번에 한 건만 처리한다', () => {
  // cron은 20건이다. 값이 다른 것이 의도다 - 20으로 맞추면 전역 한도(분당 5회)에
  // 20이 곱해져 분당 100건이 천장이 되고, 한도를 걸어 둔 의미가 스무 배로 흐려진다.
  assert.equal(IMMEDIATE_DRAIN_LIMIT, 1)
})
