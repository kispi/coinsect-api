const { resolveLiveStream, captureFrames } = require('./live_capture')

const BASE = (process.env.API_BASE_URL || '').replace(/\/+$/, '')
const SECRET = process.env.DESKTOP_SECRET || ''
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 1000 * 60 * 5
const FRAMES = parseInt(process.env.FRAMES) || 3
const FRAME_INTERVAL_SEC = parseInt(process.env.FRAME_INTERVAL_SEC) || 4

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

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
  log(`capture_desktop 시작 — ${BASE}, 주기 ${INTERVAL_MS / 1000}초`)

  // 집에 사람이 없는 동안 조용히 멈춰 있으면 알아챌 방법이 없으므로 루프는 죽지 않는다.
  for (;;) {
    await runOnce().catch(e => log(`한 바퀴 실패: ${e.message}`))
    await new Promise(r => setTimeout(r, INTERVAL_MS))
  }
}

run().catch(e => {
  console.error(e.message)
  process.exit(1)
})
