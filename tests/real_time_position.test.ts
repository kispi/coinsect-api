import { test } from 'node:test'
import assert from 'node:assert/strict'
import realTimePositionService, { pickPosition } from '../services/content/real_time_position'
import positionReports, { hasUsableValues, IPositionReport } from '../services/content/position_reports'

const report = (o: Partial<IPositionReport>): IPositionReport => ({
  id: 'p1',
  lane: 'desktop',
  requester: 'tester',
  reportedAt: '2026-09-09T00:00:00+09:00',
  ...o,
})

test('hasUsableValues: 셋 중 하나라도 비면 반영해선 안 된다', () => {
  const full = { contract: 'BTCUSDT', entryPrice: 64919.5, liqPrice: 63885, size: 8.478 }

  assert.equal(hasUsableValues(full), true)
  assert.equal(hasUsableValues({ ...full, size: null }), false)
  assert.equal(hasUsableValues({ ...full, entryPrice: undefined }), false)
  assert.equal(hasUsableValues({ ...full, liqPrice: '' }), false)
  // 판독 실패 프레임에서 실제로 관측된 모양이다.
  assert.equal(hasUsableValues({ contract: 'SOXLUSDT Perp', entryPrice: null, liqPrice: null, size: null }), false)
})

test('빈 값 제보를 승인해도 기존 포지션을 지우지 않는다', async () => {
  const { data } = await realTimePositionService.all()
  const target = data[0]

  // 사람이 이미 넣어둔 멀쩡한 포지션
  target.contract = 'BTCUSDT'
  target.entryPrice = 64919.5
  target.liqPrice = 63885
  target.size = 8.478

  const reportedAt = '2026-09-09T11:00:00+09:00'
  await positionReports.put(report({ id: target.id, reportedAt, name: target.name, legible: false }))

  const result = await realTimePositionService.resolveReport({
    id: target.id,
    reportedAt,
    approve: true,
    who: '<@U1>',
    when: '09-09 11:00',
  })

  // set()은 빈 값을 '지우라'는 뜻으로 받아들여 컬럼을 날리고 전체 푸시까지 내보낸다.
  assert.equal(target.entryPrice, 64919.5, '진입가가 지워지면 안 된다')
  assert.equal(target.liqPrice, 63885, '청산가가 지워지면 안 된다')
  assert.equal(target.size, 8.478, '규모가 지워지면 안 된다')
  assert.match(result.text, /반영하지 않았습니다/)
  assert.equal(await positionReports.find(target.id), null, '처리된 제보는 제보함에서 빠진다')
})

test('resolutionText: 판독 불가 제보는 수치 자리에 판독 불가라고 적는다', () => {
  const text = positionReports.resolutionText({
    report: report({ name: '박호두', legible: false }),
    approve: false,
    message: '닫힘',
    who: '<@U1>',
    when: '09-09 11:00',
  })

  assert.equal(text, '❌ 닫힘 — 🖥 *박호두* · 판독 불가 · <@U1> · 09-09 11:00')
})

const pos = (contract: string, size: number, entryPrice: number) =>
  ({ contract, size, entryPrice, liqPrice: entryPrice * 0.9 })

test('pickPosition: 여러 포지션이면 명목가가 가장 큰 것을 대표로 뽑는다', () => {
  // 코인 개수로 재면 KORU(16,570개)가 이기지만, 실제로 크게 건 쪽은 BTC다.
  const btc = pos('BTCUSDT', 8.478, 64919.5)   // 약 $550,000
  const koru = pos('KORUUSDT', 16570, 24.36)   // 약 $403,000
  const sol = pos('SOLUSDT', 100, 150)         // 약 $15,000

  assert.equal(pickPosition([koru, btc, sol]).contract, 'BTCUSDT')
  assert.equal(pickPosition([sol, koru]).contract, 'KORUUSDT')
})

test('pickPosition: 하나뿐이거나 읽을 게 없으면 그대로 판단한다', () => {
  const btc = pos('BTCUSDT', 8.478, 64919.5)

  assert.equal(pickPosition([btc]).contract, 'BTCUSDT')
  assert.equal(pickPosition([]), null)
  assert.equal(pickPosition(null), null)
  // 수치가 빈 항목은 후보가 아니다.
  assert.equal(pickPosition([{ contract: 'BTCUSDT', size: null, entryPrice: null, liqPrice: null }]), null)
  assert.equal(pickPosition([{ contract: 'ETHUSDT', size: 3, entryPrice: 2000, liqPrice: 1800 }, { contract: 'X' }]).contract, 'ETHUSDT')
})

test('pickPosition: 순위를 못 매기면 고르지 않고 사람에게 넘긴다', () => {
  // 명목가가 같으면 어느 쪽이 대표인지 정할 근거가 없다. 판독 불가로 폴백한다.
  assert.equal(pickPosition([pos('BTCUSDT', 2, 1000), pos('ETHUSDT', 4, 500)]), null)
})
