import { test } from 'node:test'
import assert from 'node:assert/strict'
import realTimePositionService from '../services/content/real_time_position'
import positionReports, { IPositionReport } from '../services/content/position_reports'
import { IPosition } from '../services/content/position_model'
import slackService from '../services/slack'
import chatService from '../services/chat'

const pos = (contract: string, size: number, entryPrice: number, liqPrice = entryPrice * 0.9): IPosition =>
  ({ contract, size, entryPrice, liqPrice })

const report = (o: Partial<IPositionReport>): IPositionReport => ({
  id: 'p1',
  lane: 'desktop',
  requester: 'tester',
  positions: [],
  reportedAt: '2026-09-09T00:00:00+09:00',
  ...o,
})

// 승인은 슬랙 발송과 유저 브로드캐스트를 건드린다. 테스트에서는 나가지 않게 막고,
// 무엇이 나갔는지만 센다.
const silenced = async <T>(fn: (sent: { alerts: unknown[], pushes: unknown[] }) => Promise<T>) => {
  const sent = { alerts: [], pushes: [] }
  const originals = {
    slack: slackService.postMessage,
    broadcast: chatService.broadcast,
    push: chatService.broadcastPushNotifications,
  }
  slackService.postMessage = (async () => undefined) as unknown as typeof slackService.postMessage
  chatService.broadcast = ((o: unknown) => { sent.alerts.push(o) }) as typeof chatService.broadcast
  chatService.broadcastPushNotifications = ((o: unknown) => { sent.pushes.push(o) }) as typeof chatService.broadcastPushNotifications

  try {
    return await fn(sent)
  } finally {
    slackService.postMessage = originals.slack
    chatService.broadcast = originals.broadcast
    chatService.broadcastPushNotifications = originals.push
  }
}

const streamer = async () => (await realTimePositionService.all()).data[0]

const approve = (id: string, reportedAt: string) => realTimePositionService.resolveReport({
  id, reportedAt, approve: true, who: 'chanho', when: '09-09 11:00',
})

test('승인은 체크한 포지션만 반영하고 나머지는 남긴다', async () => {
  const target = await streamer()
  target.positions = [
    { id: 'keep', ...pos('ETHUSDT', 3, 2000) },
    { id: 'update', ...pos('BTCUSDT', 8.478, 64919.5) },
  ]

  const reportedAt = '2026-09-09T11:00:00+09:00'
  await positionReports.put(report({
    id: target.id,
    reportedAt,
    positions: [pos('BTCUSDT', 9, 65000, 60000), pos('SOLUSDT', 100, 150)],
    selected: ['BTCUSDT'],   // SOL은 화면과 안 맞아 체크를 풀었다
  }))

  const result = await silenced(() => approve(target.id, reportedAt))

  assert.equal(result.ok, true)
  assert.deepEqual((await streamer()).positions.map(o => o.contract).sort(), ['BTCUSDT', 'ETHUSDT'])
  assert.equal((await streamer()).positions.find(o => o.contract === 'BTCUSDT').size, 9, '체크한 것은 갱신')
  assert.equal((await streamer()).positions.find(o => o.contract === 'ETHUSDT').size, 3, '기존은 남는다')
  assert.match(result.text, /BTCUSDT/)
  assert.doesNotMatch(result.text, /SOLUSDT/, '체크 안 한 것은 기록에도 없다')
  assert.equal(await positionReports.find(target.id), null, '처리된 제보는 빠진다')
})

test('체크를 다 풀고 승인하면 반영하지 않고 제보를 남긴다', async () => {
  const target = await streamer()
  target.positions = [{ id: 'a', ...pos('ETHUSDT', 3, 2000) }]

  const reportedAt = '2026-09-09T12:00:00+09:00'
  await positionReports.put(report({
    id: target.id, reportedAt, positions: [pos('BTCUSDT', 9, 65000)], selected: [],
  }))

  const result = await silenced(() => approve(target.id, reportedAt))

  assert.equal(result.ok, false)
  assert.match(result.text, /체크한 포지션이 없어/)
  assert.deepEqual((await streamer()).positions.map(o => o.contract), ['ETHUSDT'], 'canonical은 그대로')
  // 다시 체크해 승인할 수 있어야 하므로 제보는 남아 있어야 한다.
  assert.ok(await positionReports.find(target.id), '제보는 남는다')
  await positionReports.remove(target.id)
})

test('사이드 포지션만 바뀌면 브로드캐스트와 푸시가 나가지 않는다', async () => {
  const target = await streamer()
  // 대표는 BTC(명목 550,000). SOL(15,000)은 사이드다.
  target.positions = [
    { id: 'btc', ...pos('BTCUSDT', 8.478, 64919.5) },
    { id: 'sol', ...pos('SOLUSDT', 100, 150) },
  ]

  const reportedAt = '2026-09-09T13:00:00+09:00'
  await positionReports.put(report({
    id: target.id, reportedAt, positions: [pos('SOLUSDT', 120, 150)], selected: ['SOLUSDT'],
  }))

  const sent = await silenced(async box => { await approve(target.id, reportedAt); return box })

  assert.equal((await streamer()).positions.find(o => o.contract === 'SOLUSDT').size, 120, '반영은 됐다')
  assert.equal(sent.alerts.length, 0, '대표가 안 바뀌었으면 조용하다')
  assert.equal(sent.pushes.length, 0)
})

test('대표 포지션이 바뀌면 알린다', async () => {
  const target = await streamer()
  target.positions = [{ id: 'btc', ...pos('BTCUSDT', 8.478, 64919.5) }]

  const reportedAt = '2026-09-09T14:00:00+09:00'
  await positionReports.put(report({
    id: target.id, reportedAt, positions: [pos('BTCUSDT', 12, 64919.5)], selected: ['BTCUSDT'],
  }))

  const sent = await silenced(async box => { await approve(target.id, reportedAt); return box })

  assert.equal(sent.alerts.length, 1)
  assert.equal(sent.pushes.length, 1)
  // 알림 문구는 대표 포지션 기준이다.
  assert.match(sent.alerts[0]['text'], /BTCUSDT/)
  assert.equal(sent.alerts[0]['meta'].$$alertType, 'realTimePosition')
  assert.ok(Array.isArray(sent.alerts[0]['meta'].positions), 'meta는 포지션 배열을 담는다')
})

test('거절은 canonical을 건드리지 않고, 무엇을 거절했는지 남긴다', async () => {
  const target = await streamer()
  target.positions = [{ id: 'a', ...pos('ETHUSDT', 3, 2000) }]

  const reportedAt = '2026-09-09T15:00:00+09:00'
  const positions = [pos('BTCUSDT', 9, 65000, 60000), pos('SOLUSDT', 100, 150, 140)]
  await positionReports.put(report({ id: target.id, reportedAt, positions, selected: ['BTCUSDT'] }))

  const result = await silenced(() => realTimePositionService.resolveReport({
    id: target.id, reportedAt, approve: false, who: 'chanho', when: '09-09 15:00',
  }))

  assert.deepEqual((await streamer()).positions.map(o => o.contract), ['ETHUSDT'])
  // 체크와 무관하게 판독한 것 전부를 남긴다. 무엇을 물리쳤는지가 기록이다.
  assert.match(result.text, /BTCUSDT/)
  assert.match(result.text, /SOLUSDT/)
  assert.equal(await positionReports.find(target.id), null)
})

// 서비스는 Error가 아니라 { message }를 던진다(응답 본문으로 그대로 나가는 모양이다).
const rejection = async (positions: IPosition[]) => {
  try {
    await realTimePositionService.validate({ positions })
    return null
  } catch (e) {
    return e.message
  }
}

test('validate: 같은 계약을 두 번 넣으면 거부한다', async () => {
  // 승인 반영이 계약을 키로 쓰므로, 중복이 있으면 조용히 하나가 다른 하나를 덮어쓴다.
  assert.match(await rejection([pos('BTCUSDT', 1, 100), pos('BTCUSDT', 2, 200)]), /같은 계약을 두 번/)
  assert.equal(await rejection([pos('BTCUSDT', 1, 100), pos('ETHUSDT', 2, 200)]), null)
})

test('validate: 롱/숏의 청산가 방향과 계약 형식을 본다', async () => {
  assert.match(await rejection([pos('BTCUSDT', 1, 100, 200)]), /롱포지션/)
  assert.match(await rejection([pos('BTCUSDT', -1, 200, 100)]), /숏포지션/)
  assert.match(await rejection([pos('BTCKRW', 1, 100)]), /USDT/)
})
