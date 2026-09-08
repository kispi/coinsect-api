const { resolveLiveStream, captureFrames } = require('./live_capture')

const BASE = (process.env.API_BASE_URL || '').replace(/\/+$/, '')
const SECRET = process.env.DESKTOP_SECRET || ''
// 방송인들이 몰리는 시간대만 촘촘히 돌고 나머지는 느슨하게 돈다. 비용보다도 같은 집
// IP에서 유튜브를 두드리는 횟수를 줄여 봇 차단을 자초하지 않는 목적이 크다.
// parseInt는 값이 없으면 NaN을 주는데 NaN은 nullish가 아니라 ??도 ||도 제대로 못 거른다.
// (||는 0을 걸러버려서 PEAK_FROM_HOUR=0 같은 유효한 값도 기본값으로 덮어쓴다)
const num = (v, fallback) => (Number.isFinite(parseInt(v)) ? parseInt(v) : fallback)

const PEAK_MS = num(process.env.PEAK_INTERVAL_MS, 1000 * 60 * 5)
const OFFPEAK_MS = num(process.env.OFFPEAK_INTERVAL_MS, 1000 * 60 * 60)
const PEAK_FROM = num(process.env.PEAK_FROM_HOUR, 21)
const PEAK_TO = num(process.env.PEAK_TO_HOUR, 3)
const FRAMES = parseInt(process.env.FRAMES) || 3
const FRAME_INTERVAL_SEC = parseInt(process.env.FRAME_INTERVAL_SEC) || 4

// 한국은 서머타임이 없어 +9가 항상 맞다.
const kstNow = () => new Date(Date.now() + 1000 * 60 * 60 * 9)
const log = (...args) => console.log(kstNow().toISOString().slice(11, 19), ...args)

// 자정을 넘는 구간(21시~3시)이라 단순 비교로는 안 되고 두 조각으로 나눠 봐야 한다.
const isPeak = () => {
  const h = kstNow().getUTCHours()
  return PEAK_FROM <= PEAK_TO ? h >= PEAK_FROM && h < PEAK_TO : h >= PEAK_FROM || h < PEAK_TO
}
const intervalMs = () => (isPeak() ? PEAK_MS : OFFPEAK_MS)

const call = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Desktop-Secret': SECRET },
    body: body && JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

const captureOne = async target => {
  let live
  try {
    live = await resolveLiveStream(target.channelUrl)
  } catch (e) {
    // '방송 중이 아님'은 실패가 아니라 유효한 관측이다. 서버가 onAir를 내려야 하므로 보고한다.
    if (!/방송 중이 아닙니다|찾을 수 없습니다/.test(e.message)) throw e
    log(`  ${e.message}`)
    return call('/contents/real_time_positions/desktop_report', { positionId: target.id, isLive: false })
  }

  const images = await captureFrames(live.hlsUrl, FRAMES, FRAME_INTERVAL_SEC)
  log(`  프레임 ${images.length}장 (videoId=${live.videoId})`)
  return call('/contents/real_time_positions/desktop_report', {
    positionId: target.id,
    videoId: live.videoId,
    isLive: true,
    images,
  })
}

const runOnce = async () => {
  const targets = await call('/contents/real_time_positions/desktop_targets')
  log(`대상 ${targets.length}명`)

  // 같은 IP에서 여러 스트림에 동시에 붙으면 봇 차단을 자초하므로 순차로 돈다.
  for (const target of targets) {
    log(`[${target.name}]`)
    try {
      log(`  → ${JSON.stringify(await captureOne(target))}`)
    } catch (e) {
      log(`  실패: ${e.message}`) // 한 명의 실패가 나머지를 막지 않는다.
    }
  }
}

const run = async () => {
  if (!BASE || !SECRET) throw new Error('.env의 API_BASE_URL과 DESKTOP_SECRET이 필요합니다.')
  log(`capture_desktop 시작 — ${BASE}`)
  log(`주기: ${PEAK_FROM}~${PEAK_TO}시 ${PEAK_MS / 1000}초, 그 외 ${OFFPEAK_MS / 1000}초 (KST)`)

  // 집에 사람이 없는 동안 조용히 멈춰 있으면 알아챌 방법이 없으므로 루프는 죽지 않는다.
  for (;;) {
    await runOnce().catch(e => log(`한 바퀴 실패: ${e.message}`))
    const wait = intervalMs()
    log(`다음 바퀴까지 ${wait / 1000}초 (${isPeak() ? '피크' : '비피크'})`)
    await new Promise(r => setTimeout(r, wait))
  }
}

run().catch(e => {
  console.error(e.message)
  process.exit(1)
})
