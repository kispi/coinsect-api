import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rateLimit } from '../core/rate_limit'

test('한도까지는 통과하고 그 뒤는 막는다', async () => {
  const key = `test:${Date.now()}`

  assert.equal(await rateLimit(key, 2, 60), true)
  assert.equal(await rateLimit(key, 2, 60), true)
  assert.equal(await rateLimit(key, 2, 60), false)
})

test('키가 다르면 서로 영향을 주지 않는다', async () => {
  const a = `test:a:${Date.now()}`
  const b = `test:b:${Date.now()}`

  assert.equal(await rateLimit(a, 1, 60), true)
  assert.equal(await rateLimit(a, 1, 60), false)
  assert.equal(await rateLimit(b, 1, 60), true)
})

test('동시에 들어온 요청도 한도를 넘지 못한다', async () => {
  // read-then-write로 세면 열 건이 모두 같은 값을 읽어 전부 통과한다. 전역 바구니가
  // 실질적인 유일한 방어선이므로(IP 층은 X-Forwarded-For로 우회된다) 여기가 새면
  // 남는 방어선이 없다.
  const key = `test:burst:${Date.now()}`

  const results = await Promise.all(Array.from({ length: 10 }, () => rateLimit(key, 3, 60)))

  assert.equal(results.filter(Boolean).length, 3)
})

test('창이 다르면 카운터가 새로 시작한다', async () => {
  // 창 번호는 시각을 창 길이로 나눈 몫이다. 1초 창이면 다음 초에 키가 갈린다.
  const key = `test:window:${Date.now()}`

  assert.equal(await rateLimit(key, 1, 1), true)
  assert.equal(await rateLimit(key, 1, 1), false)

  await new Promise(resolve => setTimeout(resolve, 1100))

  assert.equal(await rateLimit(key, 1, 1), true)
})
