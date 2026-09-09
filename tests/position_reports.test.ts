import { test } from 'node:test'
import assert from 'node:assert/strict'
import positionReports, { positionHasChanged, IPositionReport } from '../services/content/position_reports'

const report = (o: Partial<IPositionReport>): IPositionReport => ({
  id: 'p1',
  lane: 'human',
  requester: 'tester',
  reportedAt: '2026-09-08T00:00:00+09:00',
  ...o,
})

test('positionHasChanged: 포지션 4개 필드만 본다', () => {
  const base = { contract: 'BTCUSDT', entryPrice: 100, liqPrice: 90, size: 1 }

  // 데스크톱 보고가 link/onAir를 갱신해도 제보로 번지면 안 된다.
  // 이 둘이 비교 대상에 들어가면 방송을 껐다 켤 때마다 전체 푸시가 나간다.
  assert.equal(positionHasChanged(base, { ...base, link: 'https://other', onAir: false }), false)

  assert.equal(positionHasChanged(base, { ...base, liqPrice: 91 }), true)
  assert.equal(positionHasChanged(base, { ...base, size: null }), true)
  // 문자열로 들어와도 같은 값이면 변경이 아니다. 어드민 폼은 문자열을 보낸다.
  assert.equal(positionHasChanged(base, { ...base, entryPrice: '100' }), false)
})

test('데스크톱 레인은 포지션당 1건만 남고 사람 제보를 밀어내지 않는다', async () => {
  for (let i = 0; i < 5; i++) {
    await positionReports.put(report({ id: `h${i}`, lane: 'human', reportedAt: `2026-09-08T00:0${i}:00+09:00` }))
  }
  // 스크립트가 5분마다 도는 동안 데스크톱 제보가 쌓여도 사람 제보가 밀려나면 안 된다.
  for (let i = 0; i < 20; i++) {
    await positionReports.put(report({ id: 'd1', lane: 'desktop', reportedAt: `2026-09-08T01:${String(i).padStart(2, '0')}:00+09:00` }))
  }

  const all = await positionReports.all()
  assert.equal(all.filter(o => o.lane === 'human').length, 5)
  assert.equal(all.filter(o => o.lane === 'desktop').length, 1, '같은 포지션의 데스크톱 제보는 덮어쓴다')
  assert.equal((await positionReports.find('d1')).reportedAt, '2026-09-08T01:19:00+09:00')

  await positionReports.remove('d1')
  for (let i = 0; i < 5; i++) await positionReports.remove(`h${i}`)
  assert.deepEqual(await positionReports.all(), [])
})

test('stale 방어: reportedAt이 어긋나면 제보를 내주지 않는다', async () => {
  const reportedAt = '2026-09-08T10:00:00+09:00'
  await positionReports.put(report({ id: 'p9', lane: 'desktop', reportedAt }))

  assert.ok(await positionReports.find('p9', reportedAt), '일치하면 찾는다')
  assert.equal(await positionReports.find('p9', '2026-09-05T10:00:00+09:00'), null, '오래된 슬랙 메시지의 버튼')
  assert.equal(await positionReports.find('없는id', reportedAt), null)

  await positionReports.remove('p9')
  assert.equal(await positionReports.find('p9', reportedAt), null, '처리된 제보는 다시 눌러도 안 먹는다')
})

test('file: 슬랙 알림이 실패하면 제보를 되돌린다', async () => {
  const original = positionReports.notify
  positionReports.notify = () => Promise.reject(new Error('slack 500'))

  try {
    await assert.rejects(positionReports.file(report({ id: 'f1', lane: 'desktop' })), /slack 500/)
    // 되돌리지 않으면 '직전 제보와 동일' 조건에 걸려 다음 주기부터 영원히 조용해진다.
    assert.equal(await positionReports.find('f1'), null, '알림이 못 나갔으면 제보도 남지 않는다')
  } finally {
    positionReports.notify = original
  }
})

test('file: 알림이 나갔으면 제보가 남는다', async () => {
  const original = positionReports.notify
  positionReports.notify = () => Promise.resolve()

  try {
    await positionReports.file(report({ id: 'f2', lane: 'desktop' }))
    assert.ok(await positionReports.find('f2'))
  } finally {
    positionReports.notify = original
    await positionReports.remove('f2')
  }
})

const resolved = (o: Partial<Parameters<typeof positionReports.resolutionText>[0]>) =>
  positionReports.resolutionText({
    approve: true,
    message: '승인됨',
    who: '<@U1>',
    when: '09-09 09:40',
    ...o,
  })

test('resolutionText: 무엇을 승인했는지가 한 줄에 남는다', () => {
  const text = resolved({
    report: report({
      lane: 'desktop',
      name: '웨돔',
      link: 'https://www.youtube.com/watch?v=abc',
      contract: 'BTCUSDT',
      size: 8.478,
      entryPrice: 64919.5,
      liqPrice: 63885,
    }),
  })

  assert.equal(
    text,
    '✅ 승인됨 — 🖥 <https://www.youtube.com/watch?v=abc|웨돔> · BTCUSDT · 규모 8.478 · 진입 64,919.5 · 청산 63,885 · <@U1> · 09-09 09:40',
  )
})

test('resolutionText: 거절은 아이콘만 다르고 기록은 같다', () => {
  const text = resolved({
    approve: false,
    message: '거절됨',
    // 사람 제보는 link가 없다. notify와 같이 굵게 처리한다.
    report: report({ lane: 'human', name: '뉴비', contract: 'SOXLUSDT', size: -913.55, entryPrice: 138.3, liqPrice: 145.79 }),
  })

  assert.equal(text, '❌ 거절됨 — 🙋 *뉴비* · SOXLUSDT · 규모 -913.55 · 진입 138.3 · 청산 145.79 · <@U1> · 09-09 09:40')
})

test('resolutionText: 큰 수는 콤마를 넣고, 계약만 비면 -로 적는다', () => {
  const text = resolved({
    report: report({ lane: 'desktop', name: '웨돔', entryPrice: 1234567.75, liqPrice: 1200000, size: 8.478 }),
  })
  assert.match(text, /· - · 규모 8\.478 · 진입 1,234,567\.75 · 청산 1,200,000 ·/)
})

test('resolutionText: 수치가 하나라도 비면 판독 불가로 적는다', () => {
  // 진입가만 읽힌 부분 판독. 빈 칸을 늘어놓으면 승인해도 되는 제보처럼 보인다.
  const text = resolved({ report: report({ lane: 'desktop', name: '웨돔', entryPrice: 1234567.75 }) })
  assert.equal(text, '✅ 승인됨 — 🖥 *웨돔* · 판독 불가 · <@U1> · 09-09 09:40')
})

test('resolutionText: 제보가 없으면 사유만 남긴다', () => {
  const text = resolved({ message: '제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다)' })
  assert.equal(text, '⚠️ 제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다) — <@U1> · 09-09 09:40')
})
