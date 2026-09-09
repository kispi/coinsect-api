import { test } from 'node:test'
import assert from 'node:assert/strict'
import realTimePositionService from '../services/content/real_time_position'
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
