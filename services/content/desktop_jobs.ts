// 어드민이 "지금 캡처"를 누르면 여기 쌓이고, 집 PC가 5초마다 하나씩 집어간다.
// 집은 NAT 뒤에 있어 서버가 부를 수 없으므로, 즉시 실행도 결국 집이 물어보는 형태다.
//
// 큐를 JSON 배열 하나로 둔다. core/cache는 get/set/del만 노출해서 Redis 리스트 연산(LPOP)을
// 쓸 수 없고, read-modify-write에는 동시 쓰기 레이스가 있다. 운영자 1인 + 워커 1대라
// 실질적으로 걸리지 않지만, 워커를 여러 대로 늘리면 캐시 인터페이스에 리스트 연산을 먼저
// 추가해야 한다.
import useCache from '../../core/cache'
import helpers from '../../core/helpers'

const cache = useCache()

const KEY = 'content:desktopJobs'

export type IDesktopJob = {
  id: string
  streamerId: string
  name: string
  // 집 PC가 이 핸들로 라이브를 찾는다. 잡에 실어 보내야 집이 대상 목록을 따로 조회하지 않는다.
  channelUrl: string
  queuedAt: string
  // 집 PC가 집어간 시각. 있으면 '진행중'이다.
  startedAt?: string
}

type IQueue = {
  jobs: IDesktopJob[]
  // 집 PC가 마지막으로 폴링한 시각. 살아 있는지 판단하는 유일한 근거다.
  lastSeenAt?: string
}

// 집 PC가 꺼진 동안 쌓인 잡을 아침에 몰아서 돌리면 안 된다. 지난 건 버린다.
const QUEUED_TTL_MS = 10 * 60 * 1000
// 집 PC가 잡을 집어간 뒤 죽으면 그 잡이 영원히 '진행중'으로 남는다. 되돌린다.
const RUNNING_TTL_MS = 3 * 60 * 1000

const age = (iso: string, now: number) => now - new Date(iso).getTime()

// 만료된 것을 걷어낸다. 진행중이 오래됐으면 버리지 않고 대기로 되돌려 다시 시도하게 한다.
export const pruneJobs = (jobs: IDesktopJob[], now: number): IDesktopJob[] =>
  (jobs || [])
    .map(job => (job.startedAt && age(job.startedAt, now) > RUNNING_TTL_MS
      ? { ...job, startedAt: undefined }
      : job))
    .filter(job => age(job.queuedAt, now) <= QUEUED_TTL_MS)

// 같은 스트리머가 이미 줄에 있으면 더 넣지 않는다. 버튼을 두 번 누른 것이 두 번 캡처가 되면
// 같은 IP에서 유튜브를 그만큼 더 두드린다.
export const enqueueJob = (
  jobs: IDesktopJob[],
  streamer: { id: string, name: string, channelUrl?: string },
  now: number,
  makeId: () => string,
): { jobs: IDesktopJob[], job: IDesktopJob | null } => {
  const existing = (jobs || []).find(job => job.streamerId === streamer.id)
  if (existing) return { jobs, job: null }

  const job: IDesktopJob = {
    id: makeId(),
    streamerId: streamer.id,
    name: streamer.name,
    channelUrl: streamer.channelUrl,
    queuedAt: new Date(now).toISOString(),
  }
  return { jobs: [...(jobs || []), job], job }
}

// 대기중인 것 중 가장 오래된 하나를 집어 '진행중'으로 표시한다. 표시를 서버가 들고 있어야
// 어드민이 지금 무엇이 도는지 볼 수 있다.
export const claimNextJob = (
  jobs: IDesktopJob[],
  now: number,
): { jobs: IDesktopJob[], job: IDesktopJob | null } => {
  const idx = (jobs || []).findIndex(job => !job.startedAt)
  if (idx < 0) return { jobs, job: null }

  const job = { ...jobs[idx], startedAt: new Date(now).toISOString() }
  const next = [...jobs]
  next[idx] = job
  return { jobs: next, job }
}

const read = async (): Promise<IQueue> => {
  const stored = await cache.get(KEY)
  return { jobs: [], ...(stored || {}) }
}

const write = (queue: IQueue) => cache.set(KEY, queue)

const desktopJobs = {
  // 어드민 조회. 만료된 것을 걷어낸 상태로 준다 - 화면에 유령 잡이 남지 않는다.
  status: async () => {
    const queue = await read()
    const jobs = pruneJobs(queue.jobs, Date.now())
    return { jobs, lastSeenAt: queue.lastSeenAt || null }
  },
  enqueue: async (streamer: { id: string, name: string, channelUrl?: string }) => {
    const queue = await read()
    const now = Date.now()
    const { jobs, job } = enqueueJob(pruneJobs(queue.jobs, now), streamer, now, helpers.crypto.generateUUID)

    await write({ ...queue, jobs })
    return { queued: !!job, job }
  },
  // 집 PC의 폴링. 하트비트 + 끝낸 잡 정리 + 다음 잡 집기를 한 번에 한다.
  // 셋을 따로 부르면 그 사이에 상태가 어긋날 틈이 생기고 왕복도 늘어난다.
  poll: async (doneId?: string) => {
    const queue = await read()
    const now = Date.now()

    const remaining = pruneJobs(queue.jobs, now).filter(job => job.id !== doneId)
    const { jobs, job } = claimNextJob(remaining, now)

    await write({ jobs, lastSeenAt: new Date(now).toISOString() })
    return { job }
  },
}

export default desktopJobs
