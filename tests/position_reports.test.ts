import { test } from 'node:test'
import assert from 'node:assert/strict'
import positionReports, { IPositionReport, selectedPositions, SLACK_OPTION_LIMIT } from '../services/content/position_reports'
import { IPosition } from '../services/content/position_model'

const pos = (contract: string, size: number, entryPrice: number, liqPrice = entryPrice * 0.9): IPosition =>
  ({ contract, size, entryPrice, liqPrice })

const report = (o: Partial<IPositionReport>): IPositionReport => ({
  id: 'p1',
  lane: 'human',
  requester: 'tester',
  positions: [],
  reportedAt: '2026-09-08T00:00:00+09:00',
  ...o,
})

test('데스크톱 레인은 스트리머당 1건만 남고 사람 제보를 밀어내지 않는다', async () => {
  for (let i = 0; i < 5; i++) {
    await positionReports.put(report({ id: `h${i}`, lane: 'human', reportedAt: `2026-09-08T00:0${i}:00+09:00` }))
  }
  // 스크립트가 5분마다 도는 동안 데스크톱 제보가 쌓여도 사람 제보가 밀려나면 안 된다.
  for (let i = 0; i < 20; i++) {
    await positionReports.put(report({ id: 'd1', lane: 'desktop', reportedAt: `2026-09-08T01:${String(i).padStart(2, '0')}:00+09:00` }))
  }

  const all = await positionReports.all()
  assert.equal(all.filter(o => o.lane === 'human').length, 5)
  assert.equal(all.filter(o => o.lane === 'desktop').length, 1, '같은 스트리머의 데스크톱 제보는 덮어쓴다')
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

test('selectedPositions: 체크한 계약만 승인 대상이 된다', () => {
  const positions = [pos('BTCUSDT', 8.478, 64919.5), pos('ETHUSDT', 3, 2000), pos('SOLUSDT', 100, 150)]

  assert.deepEqual(
    selectedPositions(report({ positions, selected: ['ETHUSDT', 'SOLUSDT'] })).map(o => o.contract),
    ['ETHUSDT', 'SOLUSDT'],
  )
  assert.deepEqual(selectedPositions(report({ positions, selected: [] })), [], '체크를 다 풀면 대상이 없다')
  // selected가 아예 없는 옛 제보는 전부로 본다.
  assert.equal(selectedPositions(report({ positions })).length, 3)
  // 수치가 빈 포지션은 체크되어 있어도 대상이 아니다.
  assert.deepEqual(
    selectedPositions(report({ positions: [{ contract: 'X' }], selected: ['X'] })),
    [],
  )
})

test('select: 토글이 선택을 제보함에 적어둔다', async () => {
  const positions = [pos('BTCUSDT', 8.478, 64919.5), pos('ETHUSDT', 3, 2000)]
  await positionReports.put(report({ id: 's1', lane: 'desktop', positions, selected: ['BTCUSDT', 'ETHUSDT'] }))

  await positionReports.select('s1', ['ETHUSDT'])
  assert.deepEqual((await positionReports.find('s1')).selected, ['ETHUSDT'])
  assert.deepEqual(selectedPositions(await positionReports.find('s1')).map(o => o.contract), ['ETHUSDT'])

  assert.equal(await positionReports.select('없는id', []), null, '없는 제보의 토글은 조용히 무시된다')
  await positionReports.remove('s1')
})

const resolved = (o: Partial<Parameters<typeof positionReports.resolutionText>[0]>) =>
  positionReports.resolutionText({
    approve: true,
    message: '승인됨',
    who: 'chanho',
    when: '09-09 09:40',
    ...o,
  })

test('resolutionText: 반영된 포지션이 한 줄에 남는다', () => {
  const text = resolved({
    report: report({
      lane: 'desktop',
      name: '웨돔',
      link: 'https://www.youtube.com/watch?v=abc',
      positions: [pos('BTCUSDT', 8.478, 64919.5, 63885)],
    }),
  })

  assert.equal(
    text,
    '✅ 승인됨 — 🖥 <https://www.youtube.com/watch?v=abc|웨돔> · BTCUSDT 롱 8.478 @64,919.5 · 청산 63,885 · chanho · 09-09 09:40',
  )
})

test('resolutionText: 여러 개를 승인하면 전부 적는다', () => {
  const positions = [pos('BTCUSDT', 8.478, 64919.5, 63885), pos('SOXLUSDT', -913.55, 138.3, 145.79)]
  const text = resolved({ report: report({ lane: 'human', name: '뉴비', positions }), positions })

  // 사람 제보는 link가 없어 이름만 굵게 나온다. 숏은 부호 대신 '숏'으로 적는다.
  assert.equal(
    text,
    '✅ 승인됨 — 🙋 *뉴비* · BTCUSDT 롱 8.478 @64,919.5 · 청산 63,885 / SOXLUSDT 숏 913.55 @138.3 · 청산 145.79 · chanho · 09-09 09:40',
  )
})

test('resolutionText: 체크한 것만 기록에 남는다', () => {
  const positions = [pos('BTCUSDT', 8.478, 64919.5, 63885), pos('ETHUSDT', 3, 2000, 1800)]
  // 승인하지 않은 포지션이 승인된 것처럼 기록되면 나중에 이력을 믿을 수 없다.
  const text = resolved({ report: report({ lane: 'desktop', name: '웨돔', positions, selected: ['ETHUSDT'] }) })

  assert.match(text, /ETHUSDT/)
  assert.doesNotMatch(text, /BTCUSDT/)
})

test('resolutionText: 판독 불가와 제보 없음은 사유만 적는다', () => {
  assert.equal(
    resolved({ report: report({ lane: 'desktop', name: '박호두' }), approve: false, message: '닫힘' }),
    '❌ 닫힘 — 🖥 *박호두* · 판독 불가 · chanho · 09-09 09:40',
  )
  assert.equal(
    resolved({ message: '제보를 찾을 수 없습니다.' }),
    '⚠️ 제보를 찾을 수 없습니다. — chanho · 09-09 09:40',
  )
})

test('positionLine: 큰 수는 콤마를 넣고 방향을 말로 적는다', () => {
  assert.equal(
    positionReports.positionLine(pos('KORUUSDT', -16570, 24.36, 35.496)),
    'KORUUSDT 숏 16,570 @24.36 · 청산 35.496',
  )
  // toLocaleString의 소수 상한 기본값은 3자리다. 그대로 쓰면 기록이 조용히 뭉개진다.
  assert.match(positionReports.positionLine(pos('XUSDT', 1, 1234567.75)), /@1,234,567\.75/)
})

test('notify: 판독한 포지션이 체크박스로 나가고, 기본은 전부 체크다', async () => {
  const sent = []
  const positions = [pos('BTCUSDT', 8.478, 64919.5), pos('ETHUSDT', 3, 2000)]

  await withSlack(sent, () => positionReports.notify(report({
    lane: 'desktop', name: '웨돔', link: 'https://x', positions, imageUrl: 'https://img',
  })))

  const [message] = sent
  const checkboxes = message.blocks.find(b => (b.accessory || {}).type === 'checkboxes').accessory
  assert.deepEqual(checkboxes.options.map(o => o.value), ['BTCUSDT', 'ETHUSDT'], '명목가 큰 순')
  assert.deepEqual(checkboxes.initial_options, checkboxes.options, '기본은 전부 체크')
  assert.equal(checkboxes.action_id, 'position_select')

  const buttons = message.blocks.find(b => b.type === 'actions').elements
  assert.deepEqual(buttons.map(b => b.action_id), ['position_approve', 'position_reject'])
  assert.ok(message.blocks.some(b => b.type === 'image'), '스샷이 붙는다')
})

test('notify: 판독 불가는 체크박스도 승인 버튼도 없다', async () => {
  const sent = []
  await withSlack(sent, () => positionReports.notify(report({ lane: 'desktop', name: '박호두', imageUrl: 'https://img' })))

  const [message] = sent
  assert.equal(message.blocks.find(b => (b.accessory || {}).type === 'checkboxes'), undefined)
  const buttons = message.blocks.find(b => b.type === 'actions').elements
  assert.deepEqual(buttons.map(b => b.action_id), ['position_reject'], '닫기만 둔다')
  // 스샷은 여전히 보낸다. 사람이 방송을 켜지 않고 화면을 볼 수 있어야 한다.
  assert.ok(message.blocks.some(b => b.type === 'image'))
})

test('notify: 포지션이 10개를 넘으면 상위 10개만 싣고 그렇게 적는다', async () => {
  const sent = []
  // 슬랙 체크박스는 옵션 10개까지다. 넘겨 보내면 메시지 자체가 거부된다.
  const positions = Array.from({ length: 13 }, (_, i) => pos(`C${i}USDT`, 1, (i + 1) * 100))

  await withSlack(sent, () => positionReports.notify(report({ lane: 'desktop', name: '웨돔', positions })))

  const checkboxes = sent[0].blocks.find(b => (b.accessory || {}).type === 'checkboxes').accessory
  assert.equal(checkboxes.options.length, SLACK_OPTION_LIMIT)
  assert.equal(checkboxes.options[0].value, 'C12USDT', '명목가 가장 큰 것')
  assert.match(sent[0].blocks[0].text.text, /3개 생략/)
})

// slackService를 갈아끼워 실제로 어떤 블록이 나가는지 붙잡는다.
async function withSlack(sink: unknown[], fn: () => Promise<unknown>) {
  const slack = (await import('../services/slack')).default
  const original = slack.postMessage
  slack.postMessage = (async message => { sink.push(message) }) as typeof slack.postMessage
  try {
    await fn()
  } finally {
    slack.postMessage = original
  }
}
