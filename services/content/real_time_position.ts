import { GoogleGenAI } from '@google/genai'
import store from '../../store'
import helpers from '../../core/helpers'
import useCache from '../../core/cache'
import presets from '../../constants/position_presets'
import IContext from '../../core/interfaces/context'
import positionReports, { IPositionReport, selectedPositions } from './position_reports'
import desktopJobs from './desktop_jobs'
import {
  IPosition,
  IStreamer,
  hasUsableValues,
  pickPosition,
  positionSetHasChanged,
  sortByNotional,
  toStreamer,
  unseenContracts,
  upsertPositions,
  watchUrl,
} from './position_model'
import { IModelUsage, addUsage, emptyUsage, mergeUsage } from './model_usage'
import awsService from '../aws'
import { log } from '../../core/logger'
import chatService from '../chat'
import aiUsage from '../ai_usage'

const now = () => helpers.dayjs().format()
const newId = () => helpers.crypto.generateUUID(true)

// 자동승인 모드. 켜면 슬랙으로 물어보지 않고 판독을 바로 반영하고 결과만 알린다.
// 사람이 스샷을 보고 걸러주는 층이 사라지므로 오인식이 그대로 유저 푸시까지 나간다.
// 판독이 충분히 믿을 만하다고 판단했을 때만 켤 것. (기본은 꺼짐)
//
// **데스크톱 제보에만 적용된다.** 유저가 보내는 제보까지 자동으로 반영하면 누구나
// 임의의 포지션을 전체 푸시로 내보낼 수 있다.
const autoApproves = () => store.state.serverConfig.POSITION_AUTO_APPROVE === 'yes'

const cache = useCache()

export { pickPosition }

// 벤치(tools/bench_position_models.ts)가 이 상수를 그대로 import해 쓴다. 프롬프트를 한 곳에서만
// 관리해야 '벤치에서 이긴 설정'과 '운영이 실제로 쓰는 설정'이 어긋나지 않는다. 2026-09-09에
// 벤치가 프롬프트를 복사해 갖고 있다가 실제와 다른 결과를 내는 일을 겪었다.
// 'gemini-flash-latest'는 떠다니는 별칭이라, 구글이 이걸 다음 티어로 옮기면 배포도
// 하지 않았는데 단가와 판독 성향이 함께 바뀐다. 버전을 고정한다.
export const POSITION_MODEL = 'gemini-3.8-flash'

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

const createStreamer = ({
  image,
  name,
  channelUrl,
  sourceUrl,
}: {
  image: string,
  name: string,
  channelUrl?: string,
  sourceUrl?: string,
}): IStreamer => ({
  id: newId(),
  image,
  name,
  channelUrl,
  sourceUrl,
  onAir: true,
  editable: true,
  lastUpdate: now(),
  positions: [],
})

let cachedPositions: { data: IStreamer[], lastUpdate: string } = {
  data: presets.map(createStreamer),
  lastUpdate: null,
}

// 대표 포지션 기준으로 유저에게 알린다. 사이드 포지션이 꿈틀거려도 조용해야 한다.
const describe = (position?: IPosition) => `
  계약 / 규모: ${(position || {}).contract || '-'} / ${(position || {}).size || '-'}
  진입 / 청산: ${(position || {}).entryPrice || '-'} / ${(position || {}).liqPrice || '-'}
`

const announce = (streamer: IStreamer) => {
  const headline = pickPosition(streamer.positions)

  chatService.broadcast({
    type: 'alert',
    text: `
      [${streamer.name}] 포지션이 업데이트되었습니다.
      ${describe(headline)}
    `,
    meta: {
      ...streamer,
      $$alertType: 'realTimePosition',
    },
  })
  chatService.broadcastPushNotifications({
    title: `[${streamer.name}] 포지션이 업데이트되었습니다.`,
    body: describe(headline),
    icon: streamer.image,
    link: 'https://coinsect.io/indicators/positions',
  })
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
    all: () => positionReports.all(),
    // 유저가 화면을 보고 직접 고쳐 보내는 제보. 포지션 하나만 다룬다 - 유저는 모달에서
    // 계약 하나를 골라 수정한다.
    create: async (c: IContext) => {
      const { data } = await realTimePositionService.all()
      const found = data.find(o => o.id === c.req.body['id'])
      if (found && !found.editable) return Promise.reject({ message: '수정이 불가능한 포지션입니다.' })

      const payload = c.req.body
      const reported: IPosition = {
        contract: payload['contract'],
        entryPrice: payload['entryPrice'],
        liqPrice: payload['liqPrice'],
        size: payload['size'],
      }

      // 같은 계약의 기존 포지션과 비교한다. 다른 계약을 새로 제보하는 것은 항상 변경이다.
      const current = ((found || {}).positions || []).find(o => o.contract === reported.contract)
      if (!positionSetHasChanged(current ? [current] : [], [reported])) {
        return Promise.reject({ message: '제출하신 포지션이 기존 포지션과 동일합니다.' })
      }

      try {
        await realTimePositionService.validate({ name: payload['name'], positions: [reported] })
        const u = await chatService.getUser(payload['token'])

        return await positionReports.file({
          id: payload['id'],
          lane: 'human',
          requester: `${u.profile.nickname} / ${u.token}`,
          ip: c.req.ip,
          name: payload['name'] || (found || {}).name,
          watchUrl: watchUrl(found || {}),
          positions: [reported],
          reportedAt: now(),
        })
      } catch (e) {
        return Promise.reject(e)
      }
    },
  },
  // 포지션 한 건의 수치 검증. 스트리머 하나가 여러 개를 들 수 있어 따로 뗐다.
  validatePosition: (o: IPosition) => {
    const p = parseFloat
    if (
      (o.liqPrice && isNaN(p(String(o.liqPrice)))) ||
      (o.entryPrice && isNaN(p(String(o.entryPrice)))) ||
      (o.size && isNaN(p(String(o.size))))
    ) throw { message: '진입가, 청산가, 규모는 숫자여야 합니다.' }

    if (o.contract && !o.contract.endsWith('USDT')) throw { message: '계약은 반드시 USDT로 끝나야 합니다' }
  },
  validate: async o => {
    (o.positions || []).forEach(realTimePositionService.validatePosition)

    // 한 스트리머가 같은 계약을 두 번 들 수는 없다. 승인 반영이 계약을 키로 쓰기 때문에
    // 중복이 있으면 조용히 하나가 다른 하나를 덮어쓴다.
    const contracts = (o.positions || []).map(p => (p.contract || '').trim()).filter(Boolean)
    if (new Set(contracts).size !== contracts.length) throw { message: '같은 계약을 두 번 넣을 수는 없습니다' }

    if ((o.name || '').length > 20) throw { message: '스트리머 이름은 20자 미만으로 적어주세요' }
    if ((o.image || '').length > 255) throw { message: '255자 미만의 이미지 URL을 사용해주세요' }
    if ((o.sourceUrl || '').length > 255) throw { message: '255자 미만의 출처 URL을 사용해주세요' }
    if ((o.channelUrl || '').length > 255) throw { message: '255자 미만의 채널 URL을 사용해주세요' }
  },
  all: async () => {
    // 매번 레디스에서 읽어오도록 해야 나중에 서버가 분산되었을 때 data-sync 문제가 없고, 레디스의 RPS는 워낙 높아서 걱정할 수준이 아님.
    const stored = await cache.get('content:realTimePositions')
    // 2026-09-09 이전 저장분은 스트리머와 포지션이 한 객체에 섞여 있다. 읽을 때 감싼다.
    if (stored) cachedPositions = { ...stored, data: (stored.data || []).map(toStreamer) }
    return cachedPositions
  },
  // 어드민 저장. 스트리머 하나를 통째로 받는다. positions 배열이 곧 정답이고,
  // 빠진 포지션은 삭제된 것으로 본다 - 사람이 직접 편집하는 화면이라 그게 놀랍지 않다.
  // 제보 승인 경로는 이 규칙을 쓰지 않는다(applyReportedPositions 참고).
  set: async payload => {
    const { data } = await realTimePositionService.all()

    if (!payload.id) {
      data.push({
        ...createStreamer({
          image: payload.image,
          name: payload.name,
          channelUrl: payload.channelUrl,
          sourceUrl: payload.sourceUrl,
        }),
        positions: [],
      })
      await setRealTimePositions(cachedPositions)
      return
    }

    try {
      await realTimePositionService.validate(payload)

      const found = data.find(o => o.id === payload.id)
      if (!found) return Promise.reject({ message: 'invalid request' })

      const before = [...(found.positions || [])]

      // 수치는 문자열로 온다. 어드민 폼이 input 값을 그대로 보낸다.
      found.positions = (payload.positions || [])
        .filter(o => hasUsableValues(o))
        .map(o => ({
          id: o.id || newId(),
          contract: (o.contract || '').trim(),
          entryPrice: parseFloat(String(o.entryPrice)),
          liqPrice: parseFloat(String(o.liqPrice)),
          size: parseFloat(String(o.size)),
        }))

      found.onAir = payload.onAir
      found.image = (payload.image || '').trim()
      found.name = (payload.name || '').trim()
      found.sourceUrl = (payload.sourceUrl || '').trim() || undefined
      found.channelUrl = (payload.channelUrl || '').trim()
      found.editable = payload.editable

      await positionReports.remove(found.id)
      await realTimePositionService.commit(found, before)
    } catch (e) {
      return Promise.reject(e)
    }
  },
  // 승인된 제보를 canonical에 얹는다. 체크된 것만 upsert하고, 체크하지 않았지만 화면에는
  // 있던 계약은 그대로 둔다(판독이 틀렸을 뿐 포지션은 살아 있다).
  // 화면에서 아예 사라진 계약(unseen)은 방송인이 닫은 것으로 보고 지운다.
  applyReportedPositions: async (streamerId: string, positions: IPosition[], unseen: string[] = []) => {
    const { data } = await realTimePositionService.all()
    const found = data.find(o => o.id === streamerId)
    if (!found) return Promise.reject({ message: 'invalid request' })

    const before = [...(found.positions || [])]

    found.positions = upsertPositions(found.positions, positions, newId, unseen)
    found.onAir = true

    await positionReports.remove(streamerId)
    await realTimePositionService.commit(found, before)
  },
  // 저장하고, 대표 포지션이 바뀌었을 때만 유저에게 알린다. 사이드 포지션이 꿈틀거려도
  // 브로드캐스트와 푸시는 나가지 않는다.
  //
  // lastUpdate는 알림 여부와 따로 움직여야 한다. 둘을 묶어두면 사이드 포지션만 승인했을 때
  // 화면의 '몇 분 전'이 그대로여서, 반영이 됐는데도 아무 일도 안 일어난 것처럼 보인다.
  // lastUpdate는 '데이터를 마지막으로 만진 시각', 알림은 '유저를 방해할 만한 변화인가'다.
  commit: async (streamer: IStreamer, before: IPosition[]) => {
    const positions = streamer.positions || []

    if (positionSetHasChanged(before || [], positions)) streamer.lastUpdate = now()

    const [was, is] = [pickPosition(before || []), pickPosition(positions)]
    if (positionSetHasChanged(was ? [was] : [], is ? [is] : [])) announce(streamer)

    await setRealTimePositions(cachedPositions)
  },
  delete: async id => {
    // 모듈 캐시만 보면 재배포 뒤 첫 삭제가 프리셋 기본값에 적용된다. 먼저 읽어둔다.
    const { data } = await realTimePositionService.all()
    const idx = data.findIndex(o => o.id === id)
    if (idx >= 0) data.splice(idx, 1)

    chatService.broadcast({
      type: 'alert',
      meta: { id, $$deleted: true, $$alertType: 'realTimePosition' },
    })
    await setRealTimePositions(cachedPositions)
  },
  autoParse: async ({
    url,
    base64,
    mimeType,
    prompt,
    positionId,
    requester,
  }: {
    url?: string,
    base64?: string,
    mimeType?: string,
    prompt?: string,
    // 어느 스트리머의 화면을 읽었는지. desktopReport는 알고 있지만 어드민의
    // auto_parse 호출(스트리머 없이 임의 URL을 넣는 경우)은 모르므로 선택 항목이다.
    positionId?: string,
    requester?: string,
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

    const ref = positionId ? { type: 'streamer', id: positionId } : undefined

    const startedAt = Date.now()
    let result
    try {
      result = await genAI.models.generateContent({
        // 2026-09-09에 gemini-3.5-flash-lite(월 $28 → $4)로 내리려다 접었다. 이 프롬프트로
        // 재보니 BTC 화면은 읽는데 알트코인 화면(SOXL 픽스처)은 9회 중 0회, 전부
        // legible=false로 넘긴다. 방송인들이 실제로 만지는 게 알트코인이라
        // (2026-09-09 박호두 KORUUSDT) 비용을 아끼는 게 아니라 자동화를 수동 입력으로
        // 바꾸는 셈이 된다. 같은 조건에서 이 모델은 9/9로 읽는다.
        model: POSITION_MODEL,
        config: {
          responseMimeType: 'application/json',
          // 주지 않으면 이 모델은 호출당 2,600토큰씩 생각하고, 그게 출력 단가로 과금된다.
          // 2026-09-09 실측(픽스처 3장 x 4회): 안 주면 44/48 · 11.7초 · 월 $80,
          // 0을 주면 48/48 · 4.2초 · 월 $21. 정확도가 오히려 올라가서 트레이드오프가 없다.
          // thinkingLevel은 3.x의 새 파라미터지만 MINIMAL은 이 모델이 400으로 거부하고
          // LOW는 안 준 것과 차이가 없다. thinkingBudget이 맞는 손잡이다.
          thinkingConfig: { thinkingBudget: 0 },
        },
        contents,
      })
    } catch (e) {
      // 판독 호출이 가장 빈번한 자리라, 여기서 조용히 실패하면 장애 중에도 ai_usage가
      // 텅 비어 ok 칼럼이 있는 이유가 무색해진다. 실패도 행으로 남기고 원래 에러는
      // 그대로 위로 던진다 - desktopReport가 다음 프레임으로 넘어가는 판단은 그대로 해야 한다.
      void aiUsage.record({
        task: 'position_read',
        model: POSITION_MODEL,
        latencyMs: Date.now() - startedAt,
        ok: false,
        error: (e || {}).message || String(e),
        ref,
        requester,
      })
      throw e
    }

    // 계측. 프레임을 여러 장 보면 호출도 여러 번이므로 행도 여러 개 남는다.
    // 기다리지 않는다 - 판독 응답이 계측 때문에 늦어지면 안 된다.
    void aiUsage.record({
      task: 'position_read',
      model: POSITION_MODEL,
      usageMetadata: result.usageMetadata,
      latencyMs: Date.now() - startedAt,
      ref,
      requester,
    })

    const parsed = JSON.parse(result.text)
    // 어드민이 커스텀 프롬프트를 넣으면 positions 배열이 없다. 예전 모양 그대로 받아들인다.
    const positions = Array.isArray(parsed.positions) ? parsed.positions : [parsed]
    const picked = parsed.legible === false ? null : pickPosition(positions)

    // 어드민 화면과 desktopReport가 둘 다 평탄한 네 필드를 읽는다. 대표 포지션을 그 자리에
    // 두고, 무엇을 두고 골랐는지는 positions에 남긴다.
    // usage는 이 한 번의 호출분이다. 프레임을 여러 장 보면 부르는 쪽에서 누계한다.
    return JSON.stringify({
      usage: addUsage(emptyUsage(POSITION_MODEL), result.usageMetadata),
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

    // 방송 상태만 canonical에 바로 반영한다. positionHasChanged가 보는 필드가 아니므로
    // 여기서는 브로드캐스트도 푸시도 발생하지 않는다.
    // 방송 주소는 더 이상 저장하지 않는다 - 핸들에 /live를 붙이면 그 순간의 방송으로 간다.
    found.onAir = isLive
    found.lastUpdate = now()
    await setRealTimePositions(cachedPositions)

    // 화면을 실제로 보러 갔다는 기록. 출처가 정기 사이클이든 사용자 요청이든 같다.
    // 사용자 요청의 쿨다운이 이 시각을 기준으로 판단된다.
    await desktopJobs.markCaptured(positionId)

    if (!isLive) return { isLive, reported: false, reason: '방송 중이 아님' }

    // 프레임마다 오버레이가 가려지는 정도가 다르다. 읽힌 프레임이 나오면 거기서 멈추고,
    // 끝까지 못 읽으면 마지막 판독을 '판독 불가' 제보로 올린다. 사람이 스샷을 보고
    // 어드민에서 직접 넣으면 되므로, 조용히 버리는 것보다 알리는 편이 낫다.
    let positions: IPosition[] = null
    let usedFrame = null
    // 프레임을 여러 장 보면 호출도 여러 번이라 비용이 곱해진다. 이 제보가 실제로 얼마
    // 들었는지 알아야 하므로 시도한 것을 전부 누계한다.
    let usage = emptyUsage(POSITION_MODEL)

    for (const base64 of images || []) {
      let candidate = null
      try {
        candidate = JSON.parse(await realTimePositionService.autoParse({
          base64,
          mimeType: 'image/jpeg',
          positionId,
          requester: 'desktop',
        }))
        usage = mergeUsage(usage, candidate.usage)
      } catch (e) { continue /* JSON이 깨진 응답. 다음 장을 본다. */ }

      // 못 읽었을 때 모델이 내주는 contract는 'SOXLUSDT Perp'처럼 매번 흔들린다. 그대로
      // 두면 중복 억제가 매번 '달라졌다'고 판정해 판독 불가 알림이 주기마다 온다.
      // 쓸 수 있는 포지션만 남겨, 판독 실패는 항상 빈 배열이라는 하나의 모양이 되게 한다.
      positions = (candidate.legible === false ? [] : (candidate.positions || [])).filter(hasUsableValues)
      usedFrame = base64
      if (positions.length) break
    }
    if (!usedFrame) return { isLive, reported: false, reason: '화면에서 포지션을 찾지 못함', usage }

    if (!positionSetHasChanged(found.positions, positions)) return { isLive, reported: false, reason: '기존 포지션과 동일', usage }

    // 관리자가 승인하지 않고 두면 canonical은 계속 낡은 값이라, 위 비교만으로는
    // 같은 알림이 주기마다 영원히 온다. 직전 제보와도 달라야 다시 알린다.
    // 값이 같으면 기존 제보를 건드리지 않는다. reportedAt이 바뀌면 이미 보낸
    // 슬랙 메시지의 버튼이 죽기 때문이다.
    const previous = await positionReports.find(positionId)
    if (previous && !positionSetHasChanged(previous.positions, positions)) {
      return { isLive, reported: false, reason: '직전 제보와 동일', usage }
    }

    // 화면에서 사라진 계약. 방송인이 닫은 것으로 보고 정리한다.
    const unseen = unseenContracts(found.positions, positions)

    const report: IPositionReport = {
      id: positionId,
      lane: 'desktop',
      requester: 'coinsect-api-desktop',
      name: found.name,
      watchUrl: watchUrl(found),
      positions,
      // 기본은 전부 체크. 판독은 대개 맞으므로 틀린 것만 풀는 쪽이 클릭이 적다.
      selected: positions.map(o => o.contract),
      // 지금 계산해 담아두는 이유는, 슬랙 메시지로 사람에게 보여준 목록이 그대로
      // 적용되어야 하기 때문이다.
      unseen,
      // 이 제보가 실제로 얼마 들었는지. 슬랙 메시지에 한 줄로 붙는다.
      usage,
      reportedAt: now(),
    }

    // 자동승인: 물어보지 않고 바로 반영하고 결과만 알린다. 승인 대기가 없으므로
    // 제보함에 넣지 않고, 스샷도 올리지 않는다 - 승인 시점에 지워질 파일이고,
    // 무엇을 읽었는지는 결과 한 줄에 수치로 남는다.
    if (autoApproves() && positions.length) {
      await realTimePositionService.applyReportedPositions(positionId, positions, unseen)
      await positionReports.notifyAutoApproved(report, positions)
      log.info(`desktopReport: 자동승인 ${found.name} — ${positions.map(o => o.contract).join(', ')}`)

      return { isLive, reported: true, autoApproved: true, positions, usage }
    }

    // 제보로 확정된 뒤에만 올린다. 억제된 판독까지 올리면 쓰이지 않을 파일이 쌓인다.
    // 실패해도 제보 자체는 나가야 하므로 삼키고 진행한다. (이미지 없이 렌더된다)
    try {
      const imageKey = `real_time_positions/${helpers.crypto.generateUUID()}.jpg`
      report.imageUrl = await awsService.s3.putObject({
        key: imageKey,
        body: Buffer.from(usedFrame, 'base64'),
        contentType: 'image/jpeg',
      })
      report.imageKey = imageKey
    } catch (e) {
      log.error('desktopReport: 프레임 업로드 실패', e)
    }

    await positionReports.file(report)

    return { isLive, reported: true, autoApproved: false, positions, usage }
  },
  // 슬랙 버튼에서 온 승인/거절을 적용한다. 누가 언제 눌렀는지는 슬랙 페이로드에서만
  // 알 수 있어 컨트롤러가 넘겨주고, 기록 문구는 여기서 완성해 돌려준다.
  // 슬랙 체크박스 토글. 사람이 화면과 대조해 남긴 선택을 제보함에 적어둔다.
  // 이 선택은 승인 클릭 때 읽힌다.
  selectReported: (id: string, contracts: string[]) => positionReports.select(id, contracts),
  // 슬랙 버튼에서 온 승인/거절을 적용한다. 누가 언제 눌렀는지는 슬랙 페이로드에서만
  // 알 수 있어 컨트롤러가 넘겨주고, 기록 문구는 여기서 완성해 돌려준다.
  resolveReport: async ({ id, reportedAt, approve, who, when }: {
    id: string,
    reportedAt: string,
    approve: boolean,
    who: string,
    when: string,
  }) => {
    const resolution = (message: string, report?: IPositionReport, positions?: IPosition[]) => ({
      ok: !!report,
      text: positionReports.resolutionText({ report, approve, message, who, when, positions }),
    })

    const report = await positionReports.find(id, reportedAt)
    if (!report) return resolution('제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다)')

    const chosen = selectedPositions(report)

    // 거절/닫기. canonical은 그대로 두고 제보만 치운다.
    if (!approve) {
      if (report.imageKey) awsService.s3.deleteObject(report.imageKey).catch(e => log.error('제보 이미지 삭제 실패', e))
      await positionReports.remove(id)
      // 판독한 것 전부를 적는다. 무엇을 거절했는지가 기록으로 남아야 한다.
      return resolution(chosen.length ? '거절됨' : '닫힘', report, (report.positions || []))
    }

    // 슬랙은 버튼을 조건부로 비활성화하지 못한다. 체크를 다 푼 채로 승인을 누를 수 있으므로
    // 서버에서 막는다. 제보는 남겨둬야 다시 체크해 승인할 수 있다.
    if (!chosen.length) {
      return {
        ok: false,
        text: positionReports.resolutionText({
          report,
          approve: false,
          message: '체크한 포지션이 없어 반영하지 않았습니다',
          who,
          when,
          positions: [],
        }),
      }
    }

    // 메시지가 한 줄 요약으로 교체되면 이 이미지를 참조하는 곳이 없어진다.
    if (report.imageKey) awsService.s3.deleteObject(report.imageKey).catch(e => log.error('제보 이미지 삭제 실패', e))

    // 체크된 것만 upsert한다. 체크하지 않은 기존 포지션은 남는다 - 판독이 일부만 맞는
    // 경우가 흔한데 승인 한 번에 나머지가 조용히 사라지면 사람이 눈으로 못 잡는다.
    await realTimePositionService.applyReportedPositions(id, chosen, report.unseen || [])

    return resolution('승인됨', report, chosen)
  },
}

export default realTimePositionService
