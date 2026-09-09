const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp'
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

// 유튜브의 봇 차단 우회 수단은 계속 바뀌므로 코드 수정 없이 환경변수로 조정할 수 있게 둔다.
// 예:) YT_DLP_EXTRA_ARGS='--extractor-args youtube:player_client=tv,android_vr --cookies ./yt-cookies.txt'
// 값 자체에는 공백을 쓸 수 없다. (공백으로 잘라 인자 배열을 만든다)
const extraArgs = (process.env.YT_DLP_EXTRA_ARGS || '').trim().split(/\s+/).filter(Boolean)

const firstLineOf = (e, fallback) => ((e || {}).stderr || '').toString().split('\n')[0].trim() || fallback

// 방송을 껐다 켜면 watch URL이 바뀌므로 채널 핸들에서 매번 라이브 URL을 다시 찾는다.
const toLiveUrl = channelUrl => {
  const trimmed = (channelUrl || '').trim().replace(/\/live\/?$/, '')
  if (!trimmed) throw new Error('채널 URL이 없습니다.')
  if (/\/watch\?v=|youtu\.be\//.test(trimmed)) return trimmed

  const handle = (trimmed.match(/@[\w.-]+/) || [])[0]
  if (!handle) throw new Error('유튜브 채널 URL(@핸들 형식)이 필요합니다.')
  return `https://www.youtube.com/${handle}/live`
}

const resolveLiveStream = async channelUrl => {
  const target = toLiveUrl(channelUrl)

  let stdout = ''
  try {
    const result = await execFileAsync(YT_DLP, [
      '--no-warnings',
      '--no-playlist',
      // 'best'는 영상과 소리가 합쳐진(muxed) 포맷만 고른다. 유튜브가 어떤 player_client로
      // 응답하느냐에 따라 라이브가 video-only/audio-only만 내주는 경우가 있고, 그때는
      // 'Requested format is not available'로 죽는다. 우리는 프레임만 필요하므로
      // 소리 없는 영상으로 떨어지게 폴백을 둔다. 대역폭도 이쪽이 덜 든다.
      '-f', 'best[height<=1080]/bv*[height<=1080]/best/bv*',
      '--print', '%(id)s',
      '--print', '%(is_live)s',
      '--print', 'urls',
      ...extraArgs,
      target,
    ], { timeout: 1000 * 30, maxBuffer: 1024 * 1024 })
    stdout = result.stdout
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('yt-dlp가 설치되어 있지 않습니다.')

    const stderr = ((e || {}).stderr || '').toString()
    // 아래에서 사용자용 메시지로 뭉개지므로 원문을 남겨둬야 원인을 특정할 수 있다.
    console.error(`yt-dlp failed for ${target}: ${stderr.trim() || e.message}`)
    if (/404|does not exist/i.test(stderr)) throw new Error('채널을 찾을 수 없습니다.')
    if (/not currently live|This live event/i.test(stderr)) throw new Error('현재 방송 중이 아닙니다.')
    // player_client 설정이 해당 방송과 맞지 않을 때 주로 발생한다. '방송 중 아님'과 혼동하기 쉽다.
    if (/No video formats found/i.test(stderr)) throw new Error('스트림 형식을 찾지 못했습니다. (YT_DLP_EXTRA_ARGS의 player_client 설정 확인)')
    if (/Sign in to confirm|not a bot/i.test(stderr)) throw new Error('유튜브가 접근을 차단했습니다. (봇 차단)')
    throw new Error(`라이브 주소 확인에 실패했습니다: ${firstLineOf(e, e.message)}`)
  }

  const [videoId, isLive, hlsUrl] = stdout.trim().split('\n').map(s => s.trim())
  if (isLive !== 'True') throw new Error('현재 방송 중이 아닙니다.')
  if (!hlsUrl) throw new Error('라이브 스트림 주소를 찾지 못했습니다.')

  return { videoId, hlsUrl }
}

// 영상을 받을 필요 없이 HLS에 붙어 프레임만 뽑고 끊는다.
// 오버레이가 다른 UI에 가려지는 정도가 프레임마다 달라서 여러 장을 뜬다.
const captureFrames = async (hlsUrl, count, intervalSeconds) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-'))

  try {
    await execFileAsync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', hlsUrl,
      '-t', String(count * intervalSeconds),
      '-vf', `fps=1/${intervalSeconds},scale=1280:-2`,
      '-frames:v', String(count),
      '-q:v', '3',
      path.join(dir, 'f_%d.jpg'),
    ], { timeout: 1000 * 60, maxBuffer: 1024 * 1024 })

    return fs.readdirSync(dir).sort()
      .map(name => fs.readFileSync(path.join(dir, name)).toString('base64'))
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('ffmpeg가 설치되어 있지 않습니다.')

    console.error(`ffmpeg failed: ${((e || {}).stderr || '').toString().trim() || e.message}`)
    throw new Error(`스크린샷 캡처에 실패했습니다: ${firstLineOf(e, e.message)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { toLiveUrl, resolveLiveStream, captureFrames }
