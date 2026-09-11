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
