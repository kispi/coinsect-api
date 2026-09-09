import { GoogleGenAI } from '@google/genai'
import store from '../../store'
import helpers from '../../core/helpers'
import useCache from '../../core/cache'
import presets from '../../constants/position_presets'
import IContext from '../../core/interfaces/context'
import positionReports, { positionHasChanged, hasUsableValues, IPositionReport } from './position_reports'
import awsService from '../aws'
import { log } from '../../core/logger'
import chatService from '../chat'

const now = () => helpers.dayjs().format()

// 화면에서 읽어낸 포지션 한 건. canonical(IRealTimePosition)의 부분집합이다.
type IPositionValues = {
  contract?: string
  entryPrice?: number
  liqPrice?: number
  size?: number
}

type IRealTimePosition = {
  id: string
  name: string
  link: string
  channelUrl: string
  image: string
  contract: string
  entryPrice: number
  liqPrice: number
  size: number
  onAir: boolean,
  editable: boolean,
  lastUpdate: Date | string,
}

const cache = useCache()

// 벤치(tools/bench_position_models.ts)가 이 상수를 그대로 import해 쓴다. 프롬프트를 한 곳에서만
// 관리해야 '벤치에서 이긴 설정'과 '운영이 실제로 쓰는 설정'이 어긋나지 않는다. 2026-09-09에
// 벤치가 프롬프트를 복사해 갖고 있다가 실제와 다른 결과를 내는 일을 겪었다.
export const POSITION_PROMPT = `
  You are reading a crypto futures trading screen captured from a livestream.

  Ignore the orderbook and the chart. The position information is usually near the bottom of the image.

  For each open position, read:
  - 'contract': the trading pair, usually ending in USDT (e.g. BTCUSDT, ETHUSDT, SOLUSDT).
    Any coin is possible, not just Bitcoin. If it is not written next to the position, look for it
    in nearby labels or the window title.
  - 'entryPrice': the price the position was opened at. Look for 'Open Price', 'Entry Price' or a
    similar label. Do not compute it from position value divided by size.
  - 'liqPrice': the liquidation price, usually labeled 'Liq' or 'Liquidation Price'.
  - 'size': how many coins are held. Positive for a long, negative for a short. A long usually has
    liqPrice below entryPrice; a short usually has liqPrice above it.

  Scale varies enormously by coin. A position may be 0.5 coins or 16,570 coins, and a price may be
  $0.0001 or $95,000. Never doubt or reject a value because it looks too large or too small.

  Commas are thousand separators: "56,829.50" is the number 56829.5. Return numbers, not strings.
  Report the coin amount, not the total value in USDT.

  The screen may show several positions at once (BTC, ETH, SOL, ...). Return every position you can
  read as a separate entry. Do not merge them and do not pick one yourself.
`

export const POSITION_SCHEMA_PROMPT = `
  Fill this JSON using the given image.

  Set "legible" to false ONLY when no position is visible at all, or every position is covered or cut
  off so the digits cannot be read. If you can read at least one position, set it to true. Do not use
  false merely because you are unsure -- being unsure is normal, guessing at digits you cannot see is not.

  {
    "legible": boolean,
    "positions": [
      { "contract": string, "entryPrice": number, "liqPrice": number, "size": number }
    ]
  }
`

// 한 화면에 BTC/ETH/SOL이 동시에 잡혀 있는 경우가 있다. canonical은 스트리머당 포지션 하나라
// 대표를 골라야 하는데, 코인 개수는 코인마다 자릿수가 달라(0.5 BTC vs 16,570 KORU) 그대로
// 비교할 수 없다. 명목가(|수량| x 진입가)로 '가장 크게 건 포지션'을 고른다.
// 순위를 못 매기면 고르지 않는다. 사람이 스샷을 보고 판단하는 편이 낫다.
export const pickPosition = (positions): IPositionValues => {
  const usable = (positions || []).filter(p => p && hasUsableValues(p))
  if (!usable.length) return null
  if (usable.length === 1) return usable[0]

  const notional = p => Math.abs(parseFloat(p.size)) * Math.abs(parseFloat(p.entryPrice))
  const ranked = [...usable].sort((a, b) => notional(b) - notional(a))

  // 1등과 2등이 같으면 어느 쪽이 대표인지 정할 근거가 없다.
  if (notional(ranked[0]) === notional(ranked[1])) return null
  return ranked[0]
}

const createPosition = ({
  image,
  name,
  link,
  channelUrl,
}: {
  image: string,
  name: string,
  link?: string,
  channelUrl?: string,
}): IRealTimePosition => ({
  id: helpers.crypto.generateUUID(true),
  image,
  name,
  entryPrice: null,
  liqPrice: null,
  contract: 'BTCUSDT',
  size: null,
  link,
  channelUrl,
  onAir: true,
  editable: true,
  lastUpdate: now(),
})

let cachedPositions = {
  data: presets.map(createPosition),
  lastUpdate: null,
}

const setRealTimePositions = async o => {
  o.lastUpdate = now()
  cache.set('content:realTimePositions', o)

  const dashboards = await cache.get('dashboards:main')
  if ((dashboards || {}).realTimePositions) {
    dashboards.realTimePositions = {
      data: (o.data || []).filter(o => o.editable),
      lastUpdate: o.lastUpdate,
    }
    cache.set('dashboards:main', dashboards, 60)
  }
}

const realTimePositionService = {
  presets: () => presets,
  changeNotification: {
    delete: (id: string) => positionReports.remove(id),
    all: () => positionReports.all(),
    create: async (c: IContext) => {
      const found = cachedPositions.data.find(o => o.id === c.req.body['id'])
      if (found && !found.editable) return Promise.reject({ message: '수정이 불가능한 포지션입니다.' })

      const payload = c.req.body

      if (!positionHasChanged(found, payload)) return Promise.reject({ message: '제출하신 포지션이 기존 포지션과 동일합니다.' })

      try {
        await realTimePositionService.validate(payload)
        const u = await chatService.getUser(payload['token'])

        return await positionReports.file({
          id: payload['id'],
          lane: 'human',
          requester: `${u.profile.nickname} / ${u.token}`,
          ip: c.req.ip,
          name: payload['name'] || (found || {}).name,
          link: (found || {}).link,
          contract: payload['contract'],
          entryPrice: payload['entryPrice'],
          liqPrice: payload['liqPrice'],
          size: payload['size'],
          onAir: payload['onAir'],
          reportedAt: now(),
        })
      } catch (e) {
        return Promise.reject(e)
      }
    },
  },
  validate: async o => {
    const p = parseFloat
    if (
      (o.liqPrice && isNaN(p(o.liqPrice))) ||
      (o.entryPrice && isNaN(p(o.entryPrice))) ||
      (o.size && isNaN(p(o.size)))
    ) throw { message: '진입가, 청산가, 규모는 숫자여야 합니다.' }

    if (o.liqPrice && o.entryPrice && o.size) {
      if (p(o.liqPrice) > p(o.entryPrice) && o.size > 0) throw { message: '롱포지션의 청산가가 진입가보다 높을 수는 없습니다' }
      if (p(o.liqPrice) < p(o.entryPrice) && o.size < 0) throw { message: '숏포지션의 청산가가 진입가보다 낮을 수는 없습니다' }
    }

    if ((o.name || '').length > 20) throw { message: '스트리머 이름은 20자 미만으로 적어주세요' }
    if ((o.image || '').length > 255) throw { message: '255자 미만의 이미지 URL을 사용해주세요' }
    if ((o.link || '').length > 255) throw { message: '255자 미만의 방송플랫폼 URL을 사용해주세요' }
    if ((o.channelUrl || '').length > 255) throw { message: '255자 미만의 채널 URL을 사용해주세요' }
    if (o.contract && !o.contract.endsWith('USDT')) throw { message: '계약은 반드시 USDT로 끝나야 합니다' }
  },
  all: async () => {
    // 매번 레디스에서 읽어오도록 해야 나중에 서버가 분산되었을 때 data-sync 문제가 없고, 레디스의 RPS는 워낙 높아서 걱정할 수준이 아님.
    const stored = await cache.get('content:realTimePositions')
    if (stored) cachedPositions = stored
    return cachedPositions
  },
  set: async (payload, submittedByUser?) => {
    if (!payload.id) {
      cachedPositions.data.push({
        id: helpers.crypto.generateUUID(true),
        image: payload.image,
        link: payload.link,
        channelUrl: payload.channelUrl,
        name: payload.name,
        liqPrice: null,
        entryPrice: null,
        contract: 'BTCUSDT',
        size: null,
        onAir: true,
        editable: true,
        lastUpdate: now(),
      })
      setRealTimePositions(cachedPositions)
      return
    }

    try {
      await realTimePositionService.validate(payload)

      if (!payload.id) payload.id = helpers.crypto.generateUUID(true)

      const found = cachedPositions.data.find(o => o.id === payload.id)
      const changed = positionHasChanged(found, payload)
      if (!found) return Promise.reject({ message: 'invalid request' })

      payload.entryPrice ? found.entryPrice = parseFloat(payload.entryPrice) : delete found.entryPrice
      payload.liqPrice ? found.liqPrice = parseFloat(payload.liqPrice) : delete found.liqPrice
      payload.size ? found.size = parseFloat(payload.size) : delete found.size
      found.contract = (payload.contract || '').trim()
      found.onAir = payload.onAir

      if (!submittedByUser) {
        found.image = (payload.image || '').trim()
        found.name = (payload.name || '').trim()
        found.link = (payload.link || '').trim()
        found.channelUrl = (payload.channelUrl || '').trim()
        found.editable = payload.editable
      }
      await positionReports.remove(found.id)

      if (changed) {
        found.lastUpdate = now()
        chatService.broadcast({
          type: 'alert',
          text: `
            [${found.name}] 포지션이 업데이트되었습니다.
            계약 / 규모: ${found.contract || '-'} / ${found.size || '-'}
            진입 / 청산: ${found.entryPrice || '-'} / ${found.liqPrice || '-'}
          `,
          meta: {
            ...found,
            $$alertType: 'realTimePosition',
          },
        })
        chatService.broadcastPushNotifications({
          title: `[${found.name}] 포지션이 업데이트되었습니다.`,
          body: `
            계약 / 규모: ${found.contract || '-'} / ${found.size || '-'}
            진입 / 청산: ${found.entryPrice || '-'} / ${found.liqPrice || '-'}
          `,
          icon: found.image,
          link: 'https://coinsect.io/indicators/positions',
        })
      }
      setRealTimePositions(cachedPositions)
    } catch (e) {
      return Promise.reject(e)
    }
  },
  delete: async id => {
    const idx = cachedPositions.data.findIndex(o => o.id === id)
    if (idx >= 0) cachedPositions.data.splice(idx, 1)

    chatService.broadcast({
      type: 'alert',
      meta: { id, $$deleted: true, $$alertType: 'realTimePosition' },
    })
    setRealTimePositions(cachedPositions)
  },
  autoParse: async ({
    url,
    base64,
    mimeType,
    prompt,
  }: {
    url?: string,
    base64?: string,
    mimeType?: string,
    prompt?: string,
  }) => {
    const genAI = new GoogleGenAI({ apiKey: store.state.serverConfig.GOOGLE_AI_STUDIO })

    const contents = [{
      text: (prompt || '').trim() || POSITION_PROMPT,
    }, {
      text: POSITION_SCHEMA_PROMPT,
    }, {
      inlineData: {
        mimeType: mimeType || 'image/png',
        data: base64 || await helpers.imageUrlToBase64String(url),
      },
    }]

    const result = await genAI.models.generateContent({
      // 'gemini-flash-latest'는 떠다니는 별칭이라, 구글이 이걸 다음 티어로 옮기면 배포도
      // 하지 않았는데 단가와 판독 성향이 함께 바뀐다. 버전을 고정한다.
      //
      // 2026-09-09에 gemini-3.5-flash-lite(월 $28 → $4)로 내리려다 접었다. 이 프롬프트로
      // 재보니 BTC 화면은 읽는데 알트코인 화면(SOXL 픽스처)은 9회 중 0회, 전부
      // legible=false로 넘긴다. 방송인들이 실제로 만지는 게 알트코인이라
      // (2026-09-09 박호두 KORUUSDT) 비용을 아끼는 게 아니라 자동화를 수동 입력으로
      // 바꾸는 셈이 된다. 같은 조건에서 이 모델은 9/9로 읽는다.
      model: 'gemini-3.8-flash',
      config: {
        responseMimeType: 'application/json',
      },
      contents,
    })

    const parsed = JSON.parse(result.text)
    // 어드민이 커스텀 프롬프트를 넣으면 positions 배열이 없다. 예전 모양 그대로 받아들인다.
    const positions = Array.isArray(parsed.positions) ? parsed.positions : [parsed]
    const picked = parsed.legible === false ? null : pickPosition(positions)

    // 어드민 화면과 desktopReport가 둘 다 평탄한 네 필드를 읽는다. 대표 포지션을 그 자리에
    // 두고, 무엇을 두고 골랐는지는 positions에 남긴다.
    return JSON.stringify({
      legible: !!picked,
      contract: picked ? picked.contract : null,
      entryPrice: picked ? picked.entryPrice : null,
      liqPrice: picked ? picked.liqPrice : null,
      size: picked ? picked.size : null,
      positions,
    })
  },
  // 집에서 도는 capture_desktop이 캡처 대상을 물어본다.
  desktopTargets: async () => {
    const { data } = await realTimePositionService.all()
    return data
      .filter(o => o.channelUrl)
      .map(({ id, name, channelUrl }) => ({ id, name, channelUrl }))
  },
  // capture_desktop이 뜬 프레임을 받아 인식하고, 바뀌었을 때만 제보한다.
  desktopReport: async ({
    positionId,
    videoId,
    isLive,
    images,
  }: {
    positionId: string,
    videoId?: string,
    isLive: boolean,
    images?: string[],
  }) => {
    const { data } = await realTimePositionService.all()
    const found = data.find(o => o.id === positionId)
    if (!found) throw { message: '해당 포지션을 찾을 수 없습니다.' }

    // 방송 상태와 링크는 canonical에 바로 반영한다. positionHasChanged가 보는 필드가
    // 아니므로 여기서는 브로드캐스트도 푸시도 발생하지 않는다.
    found.onAir = isLive
    if (isLive && videoId) found.link = `https://www.youtube.com/watch?v=${videoId}`
    found.lastUpdate = now()
    await setRealTimePositions(cachedPositions)

    if (!isLive) return { isLive, reported: false, reason: '방송 중이 아님' }

    // 프레임마다 오버레이가 가려지는 정도가 다르다. 읽힌 프레임이 나오면 거기서 멈추고,
    // 끝까지 못 읽으면 마지막 판독을 '판독 불가' 제보로 올린다. 사람이 스샷을 보고
    // 어드민에서 직접 넣으면 되므로, 조용히 버리는 것보다 알리는 편이 낫다.
    let parsed = null
    let usedFrame = null
    for (const base64 of images || []) {
      let candidate = null
      try {
        candidate = JSON.parse(await realTimePositionService.autoParse({ base64, mimeType: 'image/jpeg' }))
      } catch (e) { continue /* JSON이 깨진 응답. 다음 장을 본다. */ }

      parsed = candidate
      usedFrame = base64
      if (candidate.legible !== false && hasUsableValues(candidate)) break
    }
    if (!parsed) return { isLive, reported: false, reason: '화면에서 포지션을 찾지 못함' }

    // 못 읽었을 때 모델이 내주는 contract는 'SOXLUSDT Perp'처럼 매번 흔들린다. 그대로 두면
    // 아래 중복 억제가 매번 '달라졌다'고 판정해 판독 불가 알림이 주기마다 온다. 전부 비운다.
    const legible = parsed.legible !== false && hasUsableValues(parsed)
    const values = legible
      ? { contract: parsed.contract, entryPrice: parsed.entryPrice, liqPrice: parsed.liqPrice, size: parsed.size }
      : { contract: null, entryPrice: null, liqPrice: null, size: null }

    if (!positionHasChanged(found, values)) return { isLive, reported: false, reason: '기존 포지션과 동일' }

    // 관리자가 승인하지 않고 두면 canonical은 계속 낡은 값이라, 위 비교만으로는
    // 같은 알림이 주기마다 영원히 온다. 직전 제보와도 달라야 다시 알린다.
    // 값이 같으면 기존 제보를 건드리지 않는다. reportedAt이 바뀌면 이미 보낸
    // 슬랙 메시지의 버튼이 죽기 때문이다.
    const previous = await positionReports.find(positionId)
    if (previous && !positionHasChanged(previous, values)) return { isLive, reported: false, reason: '직전 제보와 동일' }

    // 제보로 확정된 뒤에만 올린다. 억제된 판독까지 올리면 쓰이지 않을 파일이 쌓인다.
    // 실패해도 제보 자체는 나가야 하므로 삼키고 진행한다. (이미지 없이 렌더된다)
    let image = { imageUrl: undefined, imageKey: undefined }
    try {
      const imageKey = `real_time_positions/${helpers.crypto.generateUUID()}.jpg`
      const imageUrl = await awsService.s3.putObject({
        key: imageKey,
        body: Buffer.from(usedFrame, 'base64'),
        contentType: 'image/jpeg',
      })
      image = { imageUrl, imageKey }
    } catch (e) {
      log.error('desktopReport: 프레임 업로드 실패', e)
    }

    await positionReports.file({
      id: positionId,
      lane: 'desktop',
      requester: 'coinsect-api-desktop',
      name: found.name,
      link: found.link,
      ...values,
      legible,
      ...image,
      reportedAt: now(),
    })

    return { isLive, reported: true, legible, position: values }
  },
  // 슬랙 버튼에서 온 승인/거절을 적용한다. 누가 언제 눌렀는지는 슬랙 페이로드에서만
  // 알 수 있어 컨트롤러가 넘겨주고, 기록 문구는 여기서 완성해 돌려준다.
  resolveReport: async ({ id, reportedAt, approve, who, when }: {
    id: string,
    reportedAt: string,
    approve: boolean,
    who: string,
    when: string,
  }) => {
    const resolution = (message: string, report?: IPositionReport) => ({
      ok: !!report,
      text: positionReports.resolutionText({ report, approve, message, who, when }),
    })

    const report = await positionReports.find(id, reportedAt)
    if (!report) return resolution('제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다)')

    // 메시지가 한 줄 요약으로 교체되면 이 이미지를 참조하는 곳이 없어진다.
    if (report.imageKey) awsService.s3.deleteObject(report.imageKey).catch(e => log.error('제보 이미지 삭제 실패', e))

    if (!approve) {
      await positionReports.remove(id)
      return resolution(hasUsableValues(report) ? '거절됨' : '닫힘', report)
    }

    // 판독에 실패한 제보에는 승인 버튼을 달지 않지만, 사람 제보나 부분 판독으로도
    // 빈 값이 들어올 수 있다. set()은 빈 값을 '지우라'로 받아들여 포지션을 날리고
    // 전 유저에게 푸시까지 내보내므로, 반영 직전에 한 번 더 막는다.
    if (!hasUsableValues(report)) {
      await positionReports.remove(id)
      return {
        ok: false,
        text: positionReports.resolutionText({
          report,
          approve: false,
          message: '값이 비어 반영하지 않았습니다. 어드민에서 직접 넣어주세요',
          who,
          when,
        }),
      }
    }

    // set은 모듈 캐시만 보므로, 재배포 뒤 첫 클릭이 프리셋 기본값에 쓰이지 않도록 먼저 읽어둔다.
    await realTimePositionService.all()

    // set이 제보를 지우고 broadcast/푸시까지 처리한다.
    await realTimePositionService.set({
      id,
      contract: report.contract,
      entryPrice: report.entryPrice,
      liqPrice: report.liqPrice,
      size: report.size,
      onAir: true,
    }, true)

    return resolution('승인됨', report)
  },
}

export default realTimePositionService
