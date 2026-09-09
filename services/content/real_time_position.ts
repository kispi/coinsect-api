import { GoogleGenAI } from '@google/genai'
import store from '../../store'
import helpers from '../../core/helpers'
import useCache from '../../core/cache'
import presets from '../../constants/position_presets'
import IContext from '../../core/interfaces/context'
import positionReports, { positionHasChanged, IPositionReport } from './position_reports'
import awsService from '../aws'
import { log } from '../../core/logger'
import chatService from '../chat'

const now = () => helpers.dayjs().format()

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
      text: (prompt || '').trim() || `
        Ignore the orderbook. The relevant information is usually located near the bottom-left corner of the image.

        - 'entryPrice' is the initial price at which the position was entered. Look for 'Open Price', 'Entry Price' or similar labels. Don't assume that entry price = position value / size.
        - 'liqPrice' refers to the liquidation price, which is typically labeled as 'Liq' or 'Liquidation Price'.
        - 'size' indicates the position size. Positive for long position, usually where liqPrice is lower than entryPrice. Negative for short position, usually where liqPrice is higher than entryPrice. Usually ranges between 1 and 100 BTC. (not always, so make your own guess.)
        - 'contract' is the trading pair and usually ends with 'USDT' (e.g., 'BTCUSDT', 'ETHUSDT'). It can also be any altcoin-USDT pair. If the contract is not explicitly mentioned, look for it in labels near the position information or default to 'BTCUSDT'.

        Make sure entryPrice, liqPrice, and size are all numbers, not string representations of numbers.

        Ignore the total value of the position, I just need how many coins are being longed or shorted.
        Bitcoin is currently at 5 figures, so if you see something like "56,829.50", it's a number 56829.5 (Make sure to ignore all commas)

        I wish you can check all the values correctly like human can do even without hinting labels.
      `,
    }, {
      text: `
        Fill this JSON using the given image.

        {
          "entryPrice": number,
          "liqPrice": number,
          "size": number,
          "contract": string 
        }
      `
    }, {
      inlineData: {
        mimeType: mimeType || 'image/png',
        data: base64 || await helpers.imageUrlToBase64String(url),
      },
    }]

    const result = await genAI.models.generateContent({
      // 'gemini-flash-latest'는 떠다니는 별칭이라, 구글이 이걸 다음 티어로 옮기면 배포도
      // 하지 않았는데 단가와 판독 성향이 함께 바뀐다. 2026-09-08에 4/4로 검증된 이 버전으로 고정한다.
      // 더 싸게 가려면 gemini-3.5-flash-lite(입력 $0.30/M)로 바꾸면 된다.
      model: 'gemini-3.8-flash',
      config: {
        responseMimeType: 'application/json',
      },
      contents,
    })
    return result.text
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

    // 판정 계층은 아직 없다. 먼저 읽힌 프레임을 그대로 쓴다.
    let parsed = null
    let usedFrame = null
    for (const base64 of images || []) {
      try {
        parsed = JSON.parse(await realTimePositionService.autoParse({ base64, mimeType: 'image/jpeg' }))
        usedFrame = base64
        break
      } catch (e) { /* 프레임마다 가려지는 정도가 달라 실패는 흔하다. 다음 장을 본다. */ }
    }
    if (!parsed) return { isLive, reported: false, reason: '화면에서 포지션을 찾지 못함' }

    if (!positionHasChanged(found, parsed)) return { isLive, reported: false, reason: '기존 포지션과 동일' }

    // 관리자가 승인하지 않고 두면 canonical은 계속 낡은 값이라, 위 비교만으로는
    // 같은 알림이 주기마다 영원히 온다. 직전 제보와도 달라야 다시 알린다.
    // 값이 같으면 기존 제보를 건드리지 않는다. reportedAt이 바뀌면 이미 보낸
    // 슬랙 메시지의 버튼이 죽기 때문이다.
    const previous = await positionReports.find(positionId)
    if (previous && !positionHasChanged(previous, parsed)) return { isLive, reported: false, reason: '직전 제보와 동일' }

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
      contract: parsed.contract,
      entryPrice: parsed.entryPrice,
      liqPrice: parsed.liqPrice,
      size: parsed.size,
      ...image,
      reportedAt: now(),
    })

    return { isLive, reported: true, position: parsed }
  },
  // 슬랙 버튼에서 온 승인/거절을 적용한다.
  resolveReport: async ({ id, reportedAt, approve }: { id: string, reportedAt: string, approve: boolean }) => {
    const report = await positionReports.find(id, reportedAt)
    if (!report) return { ok: false, message: '제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다)' }

    // 메시지가 텍스트로 교체되면 이 이미지를 참조하는 곳이 없어진다.
    if (report.imageKey) awsService.s3.deleteObject(report.imageKey).catch(e => log.error('제보 이미지 삭제 실패', e))

    if (!approve) {
      await positionReports.remove(id)
      return { ok: true, message: '거절됨' }
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

    return { ok: true, message: '승인됨' }
  },
}

export default realTimePositionService
