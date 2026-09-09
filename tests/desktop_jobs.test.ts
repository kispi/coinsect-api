import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimNextJob, enqueueJob, pruneJobs, type IDesktopJob } from '../services/content/desktop_jobs'

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

test('enqueueJob: 같은 스트리머를 두 번 넣지 않는다', () => {
  // 버튼을 두 번 누른 것이 두 번 캡처가 되면 같은 IP에서 유튜브를 그만큼 더 두드린다.
  const first = enqueueJob([], { id: 's1', name: '짭구', channelUrl: 'https://www.youtube.com/@zzap9' }, NOW, makeId)
  assert.equal(first.jobs.length, 1)
  assert.ok(first.job)
  assert.equal(first.job.channelUrl, 'https://www.youtube.com/@zzap9', '집 PC가 쓸 핸들이 실린다')

  const again = enqueueJob(first.jobs, { id: 's1', name: '짭구', channelUrl: 'https://www.youtube.com/@zzap9' }, NOW, makeId)
  assert.equal(again.jobs.length, 1)
  assert.equal(again.job, null, '두 번째는 넣지 않는다')

  const other = enqueueJob(first.jobs, { id: 's2', name: '웨돔', channelUrl: 'https://www.youtube.com/@wedombtc' }, NOW, makeId)
  assert.equal(other.jobs.length, 2, '다른 스트리머는 들어간다')
})

test('pruneJobs: 집 PC가 꺼진 동안 쌓인 것을 버린다', () => {
  // 아침에 켰더니 어제 눌러둔 20건이 순차로 도는 상황을 막는다.
  const fresh = job({ id: 'fresh', queuedAt: ago(60 * 1000) })
  const stale = job({ id: 'stale', streamerId: 's2', queuedAt: ago(11 * 60 * 1000) })

  assert.deepEqual(pruneJobs([fresh, stale], NOW).map(o => o.id), ['fresh'])
})

test('pruneJobs: 진행중이 오래됐으면 버리지 않고 대기로 되돌린다', () => {
  // 집 PC가 잡을 집어간 뒤 죽으면 그 잡이 영원히 '진행중'으로 남는다.
  const stuck = job({ queuedAt: ago(4 * 60 * 1000), startedAt: ago(4 * 60 * 1000) })
  const [reset] = pruneJobs([stuck], NOW)

  assert.equal(reset.startedAt, undefined, '다시 시도할 수 있게 대기로 돌아간다')

  // 방금 집어간 것은 그대로 진행중이다.
  const running = job({ startedAt: ago(10 * 1000) })
  assert.ok(pruneJobs([running], NOW)[0].startedAt)
})

test('claimNextJob: 대기중인 것 중 가장 오래된 하나만 집는다', () => {
  const older = job({ id: 'older', queuedAt: ago(60 * 1000) })
  const newer = job({ id: 'newer', streamerId: 's2', queuedAt: ago(10 * 1000) })

  const first = claimNextJob([older, newer], NOW)
  assert.equal(first.job.id, 'older')
  assert.ok(first.jobs.find(o => o.id === 'older').startedAt, '진행중으로 표시된다')

  // 이미 진행중인 것을 다시 집지 않는다 - 같은 IP에서 병렬로 도는 것을 막는 근거다.
  const second = claimNextJob(first.jobs, NOW)
  assert.equal(second.job.id, 'newer')

  const third = claimNextJob(second.jobs, NOW)
  assert.equal(third.job, null, '전부 진행중이면 더 주지 않는다')
})

test('claimNextJob: 줄이 비면 아무것도 주지 않는다', () => {
  assert.equal(claimNextJob([], NOW).job, null)
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
