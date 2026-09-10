import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyExcludeBetweenSameExchange, usesLegacyExcludeFilter } from '../services/onchain/whale_alert'

const fakeQb = () => {
  const calls: Array<{ sql: string, params?: object }> = []
  return { calls, andWhere(sql: string, params?: object) { calls.push({ sql, params }); return this } }
}

test('excludeBetweenSameExchange: XOR을 불리언 <>로 옮기고 값은 파라미터로 넘긴다', () => {
  const qb = fakeQb()
  applyExcludeBetweenSameExchange(qb as any)

  assert.equal(qb.calls.length, 1)
  assert.match(qb.calls[0].sql, /<>/)
  assert.doesNotMatch(qb.calls[0].sql, /XOR/i, 'XOR은 PostgreSQL에 없다')
  assert.doesNotMatch(qb.calls[0].sql, /'unknown'/, '값은 SQL에 박히면 안 된다')
  assert.deepEqual(qb.calls[0].params, { unknown: 'unknown' })
})

// 프로덕션에서 실제로 들어온 문자열들이다. 새로고침이 닿지 않는 탭들이 보내고 있고,
// 재시도할 때마다 URL을 다시 인코딩해서 같은 뜻의 변형이 여러 개 존재한다.
const REAL_WORLD = {
  '원본': 'amount_usd >= 3000000 AND (from_owner_type != "unknown" XOR to_owner_type != "unknown")',
  '1회 인코딩': 'amount_usd%20%3E%3D%203000000%20AND%20(from_owner_type%20!%3D%20%22unknown%22%20XOR%20to_owner_type%20!%3D%20%22unknown%22)',
  '2회 인코딩': 'amount_usd%2520%253E%3D%25203000000%2520AND%2520(from_owner_type%2520!%3D%2520%2522unknown%2522%2520XOR%2520to_owner_type%2520!%3D%2520%2522unknown%2522)',
  '다른 임계값': 'amount_usd >= 18000000 AND (from_owner_type != "unknown" XOR to_owner_type != "unknown")',
}

test('usesLegacyExcludeFilter: 인코딩이 몇 겹이든 알아본다', () => {
  for (const [name, where] of Object.entries(REAL_WORLD)) {
    assert.equal(usesLegacyExcludeFilter(where), true, `${name}을 못 알아봤다`)
  }
})

test('usesLegacyExcludeFilter: 그 외에는 건드리지 않는다', () => {
  // 넓게 열면 진짜 클라이언트 버그까지 조용히 삼킨다. 이 한 형태만 알아봐야 한다.
  const others = [
    'amountUsd:gte:3000000',                       // 현재 DSL
    'from_owner_type != "unknown"',                // XOR 없는 구 문법
    'amount_usd >= 1 AND (a XOR b)',               // XOR은 있지만 다른 컬럼
    'DROP TABLE whale_alert',
    '',
    undefined,
    null,
    123,
    '%E0%A4%A',                                    // decodeURIComponent가 던지는 문자열
  ]

  for (const where of others) {
    assert.equal(usesLegacyExcludeFilter(where), false, `${JSON.stringify(where)}를 잘못 받아들였다`)
  }
})
