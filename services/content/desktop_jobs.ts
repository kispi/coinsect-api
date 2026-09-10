// 어드민이 "지금 캡처"를 누르면 여기 쌓이고, 집 PC가 5초마다 하나씩 집어간다.
// 집은 NAT 뒤에 있어 서버가 부를 수 없으므로, 즉시 실행도 결국 집이 물어보는 형태다.
//
// 큐를 JSON 배열 하나로 둔다. core/cache는 get/set/del만 노출해서 Redis 리스트 연산(LPOP)을
// 쓸 수 없고, read-modify-write에는 동시 쓰기 레이스가 있다. 운영자 1인 + 워커 1대라
// 실질적으로 걸리지 않지만, 워커를 여러 대로 늘리면 캐시 인터페이스에 리스트 연산을 먼저
// 추가해야 한다.
import useCache from '../../core/cache'
import helpers from '../../core/helpers'
import store from '../../store'

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

// 스트리머 하나당 잡 하나. 배열로 두고 넣을 때마다 중복을 찾아 막을 수도 있지만,
// 그러면 불변식이 코드 한 줄에만 있고 자료구조는 두 개를 허용한다. 키로 막는다.
// 어드민 요청과 사용자 요청이 같은 맵에 들어간다 - 다른 건 제한을 받느냐뿐이다.
export type IJobMap = { [streamerId: string]: IDesktopJob }

// 사용자 요청 제한. 신원이 아니라 '자원'에 건다.
//
// 이 서버는 trustProxy가 켜져 있어 c.req.ip가 X-Forwarded-For의 맨 앞을 그대로 쓴다.
// 클라이언트가 그 헤더를 정할 수 있으므로 **IP 기준 제한은 헤더만 바꾸면 뚫린다**
// (2026-09-10 프로덕션에서 확인). 게스트 토큰도 누구나 발급받으니 사정이 같다.
//
// 그래서 요청자를 세지 않고 스트리머 단위로 묶는다. 사용자들은 어차피 같은 것을 원하므로
// (그 방송인의 최신 포지션) 중복 제거와 쿨다운만으로 총량이 정해진다. 신원을 위조해도
// 늘어나지 않는다.
// 운영하며 조절할 값이라 .env로 뺀다. 인색하면 실시간성이 목적인 기능이 무용해지고,
// 헐거우면 비용이 새므로 한 번에 맞추기 어렵다.
const num = (v: string, fallback: number) => (Number.isFinite(parseInt(v)) ? parseInt(v) : fallback)

const USER_COOLDOWN_MS = num(store.state.serverConfig.CAPTURE_USER_COOLDOWN_SEC, 5 * 60) * 1000
// 스트리머가 늘어나도 총량이 함께 늘지 않도록 전체에 한 번 더 씌운다.
export const USER_HOURLY_LIMIT = num(store.state.serverConfig.CAPTURE_USER_HOURLY_LIMIT, 30)

// 집 PC가 꺼진 동안 쌓인 잡을 아침에 몰아서 돌리면 안 된다. 지난 건 버린다.
const QUEUED_TTL_MS = 10 * 60 * 1000
// 집 PC가 잡을 집어간 뒤 죽으면 그 잡이 영원히 '진행중'으로 남는다. 되돌린다.
const RUNNING_TTL_MS = 3 * 60 * 1000

const age = (iso: string, now: number) => now - new Date(iso).getTime()

// 만료된 것을 걷어낸다. 진행중이 오래됐으면 버리지 않고 대기로 되돌려 다시 시도하게 한다.
export const pruneJobs = (jobs: IJobMap, now: number): IJobMap =>
  Object.fromEntries(Object.entries(jobs || {})
    .filter(([, job]) => age(job.queuedAt, now) <= QUEUED_TTL_MS)
    .map(([id, job]) => [
      id,
      job.startedAt && age(job.startedAt, now) > RUNNING_TTL_MS ? { ...job, startedAt: undefined } : job,
    ]))

// 오래 기다린 것부터 준다. 맵의 키 순서에 기대지 않고 queuedAt으로 명시적으로 고른다 -
// JSON을 거치며 순서가 보존되는지에 동작이 달려 있으면 안 된다.
export const claimNextJob = (
  jobs: IJobMap,
  now: number,
): { jobs: IJobMap, job: IDesktopJob | null } => {
  const waiting = Object.values(jobs || {})
    .filter(job => !job.startedAt)
    .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1))

  const next = waiting[0]
  if (!next) return { jobs, job: null }

  const job = { ...next, startedAt: new Date(now).toISOString() }
  return { jobs: { ...jobs, [job.streamerId]: job }, job }
}

// 잡을 레디스 해시로 둔다. 필드가 streamerId라 '스트리머당 하나'가 자료구조로 보장되고,
// hSetNX 덕에 동시에 누른 두 요청이 잡을 두 개 만들 수 없다.
//
// get으로 읽고 고쳐 set으로 쓰던 예전 방식에는 그 사이에 await 경계가 있었다(레디스 왕복).
// 두 요청이 겹치면 나중에 쓴 쪽이 상대 잡을 덮어써 한쪽이 조용히 사라졌다. 서버가 한 대여도
// 나는 문제였고, 사용자에게 열면 자주 겹친다.
// 키 이름이 예전과 다르다. content:desktopJobs에는 JSON 문자열이 들어 있어서, 같은 키에
// 해시 연산을 걸면 레디스가 WRONGTYPE으로 거절한다(배포 순간 큐가 통째로 죽는다).
const JOBS_KEY = 'content:desktopJobQueue'
const CAPTURED_KEY = 'content:desktopCaptured'
const USER_QUEUED_KEY = 'content:desktopUserQueued'
const SEEN_KEY = 'content:desktopLastSeen'

// 만료된 필드는 읽을 때 실제로 지운다. 걸러내기만 하면 해시가 영원히 자란다.
const liveJobs = async (now: number): Promise<IJobMap> => {
  const stored = (await cache.hGetAll(JOBS_KEY)) as IJobMap
  const pruned = pruneJobs(stored, now)

  await Promise.all(Object.keys(stored || {})
    .filter(streamerId => !pruned[streamerId])
    .map(streamerId => cache.hDel(JOBS_KEY, streamerId)))

  // 진행중이 되돌려진 것도 저장에 반영해야 다음 폴링이 그것을 집는다.
  await Promise.all(Object.entries(pruned)
    .filter(([id, job]) => (stored[id] || {}).startedAt && !job.startedAt)
    .map(([id, job]) => cache.hSet(JOBS_KEY, id, job)))

  return pruned
}

// 시각만 담긴 해시를 읽어 한 시간 지난 것을 버린다.
const liveStamps = async (key: string, now: number) => {
  const stored = (await cache.hGetAll(key)) as { [streamerId: string]: string }
  const live = Object.fromEntries(Object.entries(stored || {}).filter(([, at]) => age(at, now) < 60 * 60 * 1000))

  await Promise.all(Object.keys(stored || {})
    .filter(streamerId => !live[streamerId])
    .map(streamerId => cache.hDel(key, streamerId)))

  return live
}

// 사용자 요청을 받아도 되는지. 막을 이유가 있으면 그 이유를 돌려준다.
export const userRequestBlockedBy = (
  { captured, queued }: {
    captured: { [streamerId: string]: string },
    queued: { [streamerId: string]: string },
  },
  streamerId: string,
  now: number,
): { reason: 'cooldown' | 'hourly', retryAfterMs: number } | null => {
  const recent = Object.values(queued || {}).filter(at => age(at, now) < 60 * 60 * 1000)
  const lastCapture = (captured || {})[streamerId]

  if (lastCapture && age(lastCapture, now) < USER_COOLDOWN_MS) {
    return { reason: 'cooldown', retryAfterMs: USER_COOLDOWN_MS - age(lastCapture, now) }
  }

  if (recent.length >= USER_HOURLY_LIMIT) {
    // 가장 오래된 것이 창을 벗어나면 한 자리가 난다.
    const oldest = Math.min(...recent.map(at => new Date(at).getTime()))
    return { reason: 'hourly', retryAfterMs: 60 * 60 * 1000 - (now - oldest) }
  }

  return null
}

const desktopJobs = {
  // 어드민 조회. 화면은 목록이라 배열로 내보낸다. 저장이 맵인 것과 표시가 목록인 것은 별개다.
  //
  // 남은 시간을 만료 시각이 아니라 '지금부터 몇 ms'로 보낸다. 만료 시각을 보내면 브라우저가
  // 자기 시계로 빼야 해서 시계가 어긋난 만큼 틀린다.
  status: async () => {
    const now = Date.now()
    const [jobs, lastSeenAt] = await Promise.all([liveJobs(now), cache.get(SEEN_KEY)])

    return {
      jobs: Object.values(jobs)
        .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1))
        .map(job => ({ ...job, remainingMs: Math.max(0, QUEUED_TTL_MS - age(job.queuedAt, now)) })),
      lastSeenAt: lastSeenAt || null,
    }
  },
  // 캡처가 실제로 일어났음을 기록한다. 정기 사이클도 여기를 지나므로, 방금 긁힌 스트리머는
  // 출처와 무관하게 쿨다운에 들어간다.
  markCaptured: (streamerId: string) =>
    cache.hSet(CAPTURED_KEY, streamerId, new Date().toISOString()),
  // 집 PC가 살아 있나. 5초마다 폴링하므로 그보다 한참 조용하면 꺼진 것이다.
  // 한 번 놓친 것과 꺼진 것을 구분하려고 넉넉히 잡는다.
  alive: async () => {
    const lastSeenAt = await cache.get(SEEN_KEY)
    return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 30 * 1000
  },
  // byUser면 쿨다운과 총량 제한을 건다. 운영자는 그대로 통과한다.
  enqueue: async (
    streamer: { id: string, name: string, channelUrl?: string },
    { byUser = false }: { byUser?: boolean } = {},
  ): Promise<{
    queued: boolean,
    job: IDesktopJob | null,
    // 막힌 이유. 중복이라 안 들어간 경우는 제한이 아니므로 비어 있다.
    reason?: 'cooldown' | 'hourly',
    retryAfterMs?: number,
  }> => {
    const now = Date.now()

    if (byUser) {
      const [captured, queued] = await Promise.all([
        liveStamps(CAPTURED_KEY, now),
        liveStamps(USER_QUEUED_KEY, now),
      ])

      // 이미 줄에 있으면 곧 캡처되므로 제한을 보지 않는다. '5분 뒤에 다시'는 사실과 다르고,
      // 남이 눌러둔 것 때문에 내가 막힌 것처럼 읽힌다.
      const pending = await liveJobs(now)
      if (!pending[streamer.id]) {
        const blocked = userRequestBlockedBy({ captured, queued }, streamer.id, now)
        if (blocked) return { queued: false, job: null, ...blocked }
      }
    }

    const job: IDesktopJob = {
      id: helpers.crypto.generateUUID(),
      streamerId: streamer.id,
      name: streamer.name,
      channelUrl: streamer.channelUrl,
      queuedAt: new Date(now).toISOString(),
    }

    // 없을 때만 넣는다. 같은 스트리머를 동시에 누른 두 요청 중 하나만 통과한다.
    const inserted = await cache.hSetNX(JOBS_KEY, streamer.id, job)
    if (!inserted) return { queued: false, job: null }

    // 실제로 줄에 들어간 것만 센다. 중복이라 안 들어간 요청까지 세면 남들이 이미 눌러둔
    // 것 때문에 한 시간 할당량이 소진된다.
    if (byUser) await cache.hSet(USER_QUEUED_KEY, streamer.id, new Date(now).toISOString())

    return { queued: true, job }
  },
  // 집 PC의 폴링. 하트비트 + 끝낸 잡 정리 + 다음 잡 집기를 한 번에 한다.
  // 셋을 따로 부르면 그 사이에 상태가 어긋날 틈이 생기고 왕복도 늘어난다.
  poll: async (doneId?: string) => {
    const now = Date.now()
    await cache.set(SEEN_KEY, new Date(now).toISOString())

    const pending = await liveJobs(now)

    // job.id로 지운다. streamerId로 지우면, 만료돼 사라진 뒤 새로 들어온 같은 스트리머의
    // 잡을 옛 완료 통지가 지워버린다.
    const done = Object.entries(pending).find(([, job]) => job.id === doneId)
    if (done) {
      await cache.hDel(JOBS_KEY, done[0])
      delete pending[done[0]]
    }

    const { job } = claimNextJob(pending, now)
    // 집 PC는 한 대라 여기서 두 폴러가 같은 잡을 집을 일은 없다. 늘어나면 이 자리도
    // hSetNX 계열로 바꿔야 한다.
    if (job) await cache.hSet(JOBS_KEY, job.streamerId, job)

    return { job }
  },
}

export default desktopJobs
