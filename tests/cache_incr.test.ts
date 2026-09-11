import { test } from 'node:test'
import assert from 'node:assert/strict'
import useCache from '../core/cache'

// 테스트와 개발은 레디스 없이 돌아 메모리 구현을 탄다. 레디스 INCR과 계약이 같아야
// 여기서 통과한 것이 배포에서도 같게 동작한다.
const cache = useCache()

test('incr는 올린 뒤의 값을 준다', async () => {
  const key = `test:incr:${Date.now()}`

  assert.equal(await cache.incr(key, 60), 1)
  assert.equal(await cache.incr(key, 60), 2)
  assert.equal(await cache.incr(key, 60), 3)
})

test('동시에 불러도 값이 겹치지 않는다', async () => {
  // get 뒤 set이면 전부 같은 값을 돌려받는다. 원자적이어야 1..5가 한 번씩 나온다.
  const key = `test:incr:parallel:${Date.now()}`

  const values = await Promise.all(Array.from({ length: 5 }, () => cache.incr(key, 60)))

  assert.deepEqual(values.sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('만료가 지나면 0에서 다시 센다', async () => {
  const key = `test:incr:ttl:${Date.now()}`

  assert.equal(await cache.incr(key, 1), 1)
  assert.equal(await cache.incr(key, 1), 2)

  await new Promise(resolve => setTimeout(resolve, 1100))

  // 만료는 첫 증가에서만 걸린다. 두 번째 증가가 만료를 미뤘다면 여기서 3이 나온다.
  assert.equal(await cache.incr(key, 1), 1)
})
