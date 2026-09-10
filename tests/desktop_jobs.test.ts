import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimNextJob, pruneJobs, userRequestBlockedBy, type IDesktopJob } from '../services/content/desktop_jobs'

const NOW = new Date('2026-09-09T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
const makeId = () => `job-${++seq}`

const job = (o: Partial<IDesktopJob> = {}): IDesktopJob => ({
  id: 'j1',
  streamerId: 's1',
  name: '짭구',
  channelUrl: 'https://www.youtube.com/@zzap9',
  queuedAt: ago(1000),
  ...o,
})

// 스트리머 하나당 잡 하나라는 불변식을 자료구조가 들고 있다(맵의 키가 streamerId).
const asMap = (...jobs: IDesktopJob[]) => Object.fromEntries(jobs.map(o => [o.streamerId, o]))

test('enqueue: 같은 스트리머를 동시에 눌러도 잡은 하나다', async () => {
  // 예전에는 읽고-고쳐-쓰는 사이에 await 경계가 있어 두 요청이 겹치면 한쪽이 사라졌다.
  // hSetNX가 '없을 때만 넣기'를 원자적으로 하므로 동시에 눌러도 정확히 하나만 통과한다.
  const desktopJobs = (await import('../services/content/desktop_jobs')).default
  const streamer = { id: 'race-test', name: '짭구', channelUrl: 'https://www.youtube.com/@zzap9' }

  const results = await Promise.all(Array.from({ length: 5 }, () => desktopJobs.enqueue(streamer)))

  assert.equal(results.filter(o => o.queued).length, 1, '다섯 번 눌러도 하나만 들어간다')
  assert.equal((await desktopJobs.status()).jobs.filter(o => o.streamerId === 'race-test').length, 1)
})

test('enqueue: 다른 스트리머를 동시에 누르면 둘 다 들어간다', async () => {
  // 해시 필드가 달라 서로 덮어쓰지 않는다. 예전 구조에서는 한쪽이 사라졌다.
  const desktopJobs = (await import('../services/content/desktop_jobs')).default

  const results = await Promise.all([
    desktopJobs.enqueue({ id: 'race-a', name: 'A', channelUrl: 'https://www.youtube.com/@a' }),
    desktopJobs.enqueue({ id: 'race-b', name: 'B', channelUrl: 'https://www.youtube.com/@b' }),
  ])

  assert.deepEqual(results.map(o => o.queued), [true, true])
  const ids = (await desktopJobs.status()).jobs.map(o => o.streamerId)
  assert.ok(ids.includes('race-a') && ids.includes('race-b'), '둘 다 살아 있다')
})

test('pruneJobs: 집 PC가 꺼진 동안 쌓인 것을 버린다', () => {
  // 아침에 켰더니 어제 눌러둔 20건이 순차로 도는 상황을 막는다.
  const fresh = job({ id: 'fresh', queuedAt: ago(60 * 1000) })
  const stale = job({ id: 'stale', streamerId: 's2', queuedAt: ago(11 * 60 * 1000) })

  assert.deepEqual(Object.keys(pruneJobs(asMap(fresh, stale), NOW)), ['s1'])
})

test('pruneJobs: 진행중이 오래됐으면 버리지 않고 대기로 되돌린다', () => {
  // 집 PC가 잡을 집어간 뒤 죽으면 그 잡이 영원히 '진행중'으로 남는다.
  const stuck = job({ queuedAt: ago(4 * 60 * 1000), startedAt: ago(4 * 60 * 1000) })

  assert.equal(pruneJobs(asMap(stuck), NOW).s1.startedAt, undefined, '다시 시도할 수 있게 대기로 돌아간다')

  // 방금 집어간 것은 그대로 진행중이다.
  assert.ok(pruneJobs(asMap(job({ startedAt: ago(10 * 1000) })), NOW).s1.startedAt)
})

test('claimNextJob: 오래 기다린 것부터 준다', () => {
  const older = job({ id: 'older', queuedAt: ago(60 * 1000) })
  const newer = job({ id: 'newer', streamerId: 's2', queuedAt: ago(10 * 1000) })

  // 맵의 키 순서가 아니라 queuedAt으로 고른다. 늦게 들어온 것을 앞에 두고 확인한다.
  const first = claimNextJob(asMap(newer, older), NOW)
  assert.equal(first.job.id, 'older')
  assert.ok(first.jobs.s1.startedAt, '진행중으로 표시된다')

  // 이미 진행중인 것을 다시 집지 않는다 - 같은 IP에서 병렬로 도는 것을 막는 근거다.
  const second = claimNextJob(first.jobs, NOW)
  assert.equal(second.job.id, 'newer')

  const third = claimNextJob(second.jobs, NOW)
  assert.equal(third.job, null, '전부 진행중이면 더 주지 않는다')
})

test('claimNextJob: 줄이 비면 아무것도 주지 않는다', () => {
  assert.equal(claimNextJob({}, NOW).job, null)
  assert.equal(claimNextJob(undefined, NOW).job, null)
})

test('status: 남은 시간을 지금부터의 상대값으로 준다', async () => {
  // 만료 시각을 보내면 브라우저가 자기 시계로 빼야 해서 시계가 어긋난 만큼 틀린다.
  const desktopJobs = (await import('../services/content/desktop_jobs')).default

  await desktopJobs.enqueue({ id: 'sx', name: '짭구', channelUrl: 'https://www.youtube.com/@zzap9' })
  const { jobs } = await desktopJobs.status()
  const queued = jobs.find(o => o.streamerId === 'sx')

  assert.ok(queued.remainingMs > 9 * 60 * 1000, '방금 넣었으니 10분에 가깝다')
  assert.ok(queued.remainingMs <= 10 * 60 * 1000)

  // 처리하면 사라진다 - 타이머가 0이 됐을 때 어드민이 다시 물어보고 지우는 근거다.
  await desktopJobs.poll()
  await desktopJobs.poll(jobs.find(o => o.streamerId === 'sx').id)
  assert.equal((await desktopJobs.status()).jobs.find(o => o.streamerId === 'sx'), undefined)
})

// 사용자 요청 제한. IP를 못 믿으므로(trustProxy가 켜져 있어 X-Forwarded-For를 클라이언트가
// 정한다) 요청자가 아니라 스트리머 단위로 묶는다. 신원을 위조해도 총량이 늘지 않아야 한다.
// 쿨다운의 기준은 '누가 요청했나'가 아니라 '그 스트리머가 마지막으로 언제 긁혔나'다.
// 정기 사이클이 방금 긁었으면 사용자 요청은 같은 화면을 다시 보는 것이라 막는 게 맞다.
test('userRequestBlockedBy: 방금 긁힌 스트리머는 막는다', () => {
  const captured = { s1: ago(60 * 1000) }

  const blocked = userRequestBlockedBy({ captured, queued: {} }, 's1', NOW)
  assert.equal(blocked.reason, 'cooldown')
  assert.ok(blocked.retryAfterMs > 3 * 60 * 1000, '남은 시간을 알려준다')

  // 다른 스트리머는 막지 않는다. 제한은 자원 단위지 사람 단위가 아니다.
  assert.equal(userRequestBlockedBy({ captured, queued: {} }, 's2', NOW), null)

  // 쿨다운이 지나면 풀린다.
  assert.equal(userRequestBlockedBy({ captured: { s1: ago(6 * 60 * 1000) }, queued: {} }, 's1', NOW), null)
})

test('userRequestBlockedBy: 정기 사이클이 긁은 것도 쿨다운에 넣는다', () => {
  // 사용자가 한 번도 요청하지 않았어도, 방금 자동으로 긁혔으면 새로 볼 것이 없다.
  const blocked = userRequestBlockedBy({ captured: { s1: ago(30 * 1000) }, queued: {} }, 's1', NOW)
  assert.equal(blocked.reason, 'cooldown')
})

test('userRequestBlockedBy: 시간당 총량을 넘으면 막는다', () => {
  // 스트리머가 늘어도 총량이 함께 늘지 않게 하는 장치다.
  const queued = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`s${i}`, ago((i + 1) * 60 * 1000)]),
  )

  const blocked = userRequestBlockedBy({ captured: {}, queued }, 'new', NOW)
  assert.equal(blocked.reason, 'hourly')
  assert.ok(blocked.retryAfterMs > 0)

  // 한 시간이 지난 기록은 창에서 빠져 자리가 난다.
  const expired = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`s${i}`, ago(61 * 60 * 1000 + i)]),
  )
  assert.equal(userRequestBlockedBy({ captured: {}, queued: expired }, 'new', NOW), null)
})

test('enqueue: 운영자는 제한을 받지 않는다', async () => {
  const desktopJobs = (await import('../services/content/desktop_jobs')).default
  const streamer = { id: 'admin-test', name: '짭구', channelUrl: 'https://www.youtube.com/@zzap9' }

  // 방금 긁힌 상태를 만든다. 정기 사이클이 돈 것과 같은 상황이다.
  await desktopJobs.markCaptured(streamer.id)

  const asUser = await desktopJobs.enqueue(streamer, { byUser: true })
  assert.equal(asUser.queued, false)
  assert.equal(asUser.reason, 'cooldown')

  // 운영자는 같은 상황에서도 들어간다. 자기 서비스를 자기가 못 고치면 안 된다.
  const asAdmin = await desktopJobs.enqueue(streamer)
  assert.equal(asAdmin.queued, true)
})

test('markCaptured: 폴링이 쿨다운 기록을 지우지 않는다', async () => {
  // poll이 큐를 통째로 덮어쓰면 5초마다 제한이 초기화된다. 실제로 그 버그가 있었다.
  const desktopJobs = (await import('../services/content/desktop_jobs')).default

  await desktopJobs.markCaptured('poll-test')
  await desktopJobs.poll()

  const blocked = await desktopJobs.enqueue(
    { id: 'poll-test', name: '테스트', channelUrl: 'https://www.youtube.com/@x' },
    { byUser: true },
  )
  assert.equal(blocked.reason, 'cooldown', '폴링 뒤에도 쿨다운이 살아 있다')
})

test('enqueue: 중복이라 안 들어간 요청은 할당량을 쓰지 않는다', async () => {
  const desktopJobs = (await import('../services/content/desktop_jobs')).default
  const streamer = { id: 'dedupe-test', name: '웨돔', channelUrl: 'https://www.youtube.com/@wedombtc' }

  const first = await desktopJobs.enqueue(streamer, { byUser: true })
  assert.equal(first.queued, true)

  // 남이 이미 눌러둔 것 때문에 내 할당량이 깎이면 안 된다. 줄에 들어간 것만 센다.
  const second = await desktopJobs.enqueue(streamer, { byUser: true })
  assert.equal(second.queued, false)
  assert.equal(second.reason, undefined, '중복은 제한이 아니라 그냥 이미 있는 것이다')
})
