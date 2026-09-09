import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasUsableValues,
  positionSetHasChanged,
  pickPosition,
  upsertPositions,
  toStreamer,
} from '../services/content/position_model'

let seq = 0
const makeId = () => `id-${++seq}`

const pos = (contract: string, size: number, entryPrice: number, liqPrice = entryPrice * 0.9) =>
  ({ contract, size, entryPrice, liqPrice })

test('hasUsableValues: 셋 중 하나라도 비면 반영해선 안 된다', () => {
  const full = pos('BTCUSDT', 8.478, 64919.5, 63885)

  assert.equal(hasUsableValues(full), true)
  assert.equal(hasUsableValues({ ...full, size: null }), false)
  assert.equal(hasUsableValues({ ...full, entryPrice: undefined }), false)
  // 판독 실패 프레임에서 실제로 관측된 모양이다.
  assert.equal(hasUsableValues({ contract: 'SOXLUSDT Perp' }), false)
  assert.equal(hasUsableValues(undefined), false)
})

test('positionSetHasChanged: 계약 순서가 달라도 같은 집합이면 변경이 아니다', () => {
  const btc = pos('BTCUSDT', 8.478, 64919.5)
  const eth = pos('ETHUSDT', 3, 2000)

  // 모델은 계약을 매번 같은 순서로 내주지 않는다. 순서로 알림이 나가면 안 된다.
  assert.equal(positionSetHasChanged([btc, eth], [eth, btc]), false)
  assert.equal(positionSetHasChanged([], []), false)

  assert.equal(positionSetHasChanged([btc], [btc, eth]), true, '추가')
  assert.equal(positionSetHasChanged([btc, eth], [btc]), true, '삭제')
  assert.equal(positionSetHasChanged([btc], [pos('BTCUSDT', 8.5, 64919.5)]), true, '값 변경')
  // 같은 개수라도 계약이 다르면 다른 집합이다.
  assert.equal(positionSetHasChanged([btc], [eth]), true, '계약 교체')
})

test('pickPosition: 명목가가 가장 큰 것을 대표로 뽑는다', () => {
  // 코인 개수로 재면 KORU(16,570개)가 이기지만, 실제로 크게 건 쪽은 BTC다.
  const btc = pos('BTCUSDT', 8.478, 64919.5)
  const koru = pos('KORUUSDT', 16570, 24.36)
  const sol = pos('SOLUSDT', 100, 150)

  assert.equal(pickPosition([koru, btc, sol]).contract, 'BTCUSDT')
  assert.equal(pickPosition([sol, koru]).contract, 'KORUUSDT')
  assert.equal(pickPosition([btc]).contract, 'BTCUSDT')
  assert.equal(pickPosition([]), null)
  assert.equal(pickPosition(null), null)
  // 순위를 못 매기면 고르지 않고 사람에게 넘긴다.
  assert.equal(pickPosition([pos('BTCUSDT', 2, 1000), pos('ETHUSDT', 4, 500)]), null)
})

test('upsertPositions: 체크한 것만 반영하고 나머지는 지우지 않는다', () => {
  const current = [
    { id: 'a', ...pos('BTCUSDT', 8.478, 64919.5) },
    { id: 'b', ...pos('ETHUSDT', 3, 2000) },
  ]

  // BTC만 승인. ETH는 손대지 않아야 한다 (판독이 일부만 맞는 경우가 흔하다)
  const next = upsertPositions(current, [pos('BTCUSDT', 9, 65000, 60000)], makeId)

  assert.equal(next.length, 2)
  assert.equal(next.find(o => o.contract === 'BTCUSDT').size, 9)
  assert.equal(next.find(o => o.contract === 'BTCUSDT').id, 'a', 'id는 유지된다')
  assert.equal(next.find(o => o.contract === 'ETHUSDT').size, 3, 'ETH는 그대로')
})

test('upsertPositions: 새 계약은 추가하고, 쓸 수 없는 값은 무시한다', () => {
  const next = upsertPositions([{ id: 'a', ...pos('BTCUSDT', 8.478, 64919.5) }], [
    pos('SOLUSDT', 100, 150),
    { contract: 'DOGEUSDT', size: null, entryPrice: null, liqPrice: null },
  ], makeId)

  assert.deepEqual(next.map(o => o.contract), ['BTCUSDT', 'SOLUSDT'])
  assert.ok(next[1].id, '새 포지션에는 id가 붙는다')
  // 문자열로 와도 숫자로 저장한다. 어드민 폼과 모델 응답이 둘 다 문자열을 줄 수 있다.
  const coerced = upsertPositions([], [{ contract: 'X', size: '3', entryPrice: '10', liqPrice: '9' } as never], makeId)
  assert.equal(coerced[0].size, 3)
  assert.equal(typeof coerced[0].entryPrice, 'number')
})

test('toStreamer: 옛 저장분을 포지션 배열로 감싼다', () => {
  const legacy = {
    id: 's1', name: '박호두', link: 'l', channelUrl: 'c', image: 'i',
    onAir: true, editable: true, lastUpdate: 'now',
    contract: 'BTCUSDT', entryPrice: 64919.5, liqPrice: 63885, size: 8.478,
  }

  const migrated = toStreamer(legacy, makeId)
  assert.equal(migrated.positions.length, 1)
  assert.equal(migrated.positions[0].contract, 'BTCUSDT')
  assert.ok(migrated.positions[0].id)
  // 스트리머 필드에 포지션 값이 남아 있으면 두 곳이 어긋난다.
  assert.equal(migrated['entryPrice'], undefined)
  assert.equal(migrated.name, '박호두')

  // 프리셋 기본값(계약만 있고 수치는 빈 상태)은 포지션으로 세지 않는다.
  assert.deepEqual(toStreamer({ id: 's2', contract: 'BTCUSDT', size: null }, makeId).positions, [])

  // 이미 새 모양이면 그대로 돌려준다.
  const modern = { id: 's3', positions: [{ id: 'p', ...pos('ETHUSDT', 1, 2000) }] }
  assert.equal(toStreamer(modern, makeId), modern)
})
