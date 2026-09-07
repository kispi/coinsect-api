import { GoogleGenAI } from '@google/genai'
import axios from 'axios'
import { resolveLiveStream, captureFrames } from './live_capture'
import store from '../../store'
import helpers from '../../core/helpers'
import useCache from '../../core/cache'
import presets from '../../constants/position_presets'
import IContext from '../../core/interfaces/context'
import slackService from '../slack'
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

let notifiedPositionHistories = []

const removeNotifiedPositionHistoriesOf = id => {
  const idx = notifiedPositionHistories.findIndex(o => o.id === id)
  if (idx < 0) return

  notifiedPositionHistories.splice(idx, 1)
  removeNotifiedPositionHistoriesOf(id)
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

const positionHasChanged = (a, b) => ['contract', 'entryPrice', 'liqPrice', 'size'].some(field =>
  (a[field] && !b[field]) ||
  (!a[field] && b[field]) ||
  (a[field] && b[field] && a[field] != b[field])
)

const realTimePositionService = {
  presets: () => presets,
  changeNotification: {
    delete: id => {
      const idx = notifiedPositionHistories.findIndex(o => o.id === id)
      if (idx >= 0) notifiedPositionHistories.splice(idx, 1)
    },
    all: () => notifiedPositionHistories,
    create: async (c: IContext) => {
      const found = cachedPositions.data.find(o => o.id === c.req.body['id'])
      if (found && !found.editable) return Promise.reject({ message: '수정이 불가능한 포지션입니다.' })

      const payload = c.req.body

      if (!positionHasChanged(found, payload)) return Promise.reject({ message: '제출하신 포지션이 기존 포지션과 동일합니다.' })

      try {
        await realTimePositionService.validate(payload)
        const acceptable = {
          ip: c.req.ip,
          requestedAt: now(),
        }
        const keys = ['id', 'liqPrice', 'entryPrice', 'size', 'contract', 'name', 'image', 'link', 'onAir', 'token']
        keys.filter(key => payload[key]).forEach(key => acceptable[key] = payload[key])
        notifiedPositionHistories.push(acceptable)
        notifiedPositionHistories = notifiedPositionHistories.slice(-5) // 최근 5개까지만 유지
        const u = await chatService.getUser(payload['token'])
        slackService.postMessage({
          text: `
            포지션 수정 요청이 들어왔습니다
            요청자: ${u.profile.nickname} (${c.req.ip} / ${u.token})\n
            스트리머: *${payload['name']}*
            진입: ${payload['entryPrice']}
            청산: ${payload['liqPrice']}
            규모: ${payload['size']}
            계약: ${payload['contract']}
            방송: ${payload['onAir']}
          `,
          channel: 'coinsect-api',
        })
        return notifiedPositionHistories
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
      removeNotifiedPositionHistoriesOf(found.id)

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
      model: 'gemini-flash-latest',
      config: {
        responseMimeType: 'application/json',
      },
      contents,
    })
    return result.text
  },
  // 채널 URL만으로 라이브 화면을 직접 떠서 인식한다. 프레임마다 따로 인식시키고
  // 판정은 하지 않는다 — 후보를 나란히 보여주고 관리자가 고른다.
  autoCapture: async ({
    channelUrl,
    prompt,
    frames,
    interval,
  }: {
    channelUrl: string,
    prompt?: string,
    frames?: number,
    interval?: number,
  }) => {
    const count = Math.min(Math.max(parseInt(String(frames)) || 3, 1), 5)
    const intervalSeconds = Math.min(Math.max(parseInt(String(interval)) || 4, 1), 10)

    const { videoId, hlsUrl } = await resolveLiveStream(channelUrl)
    const images = await captureFrames(hlsUrl, count, intervalSeconds)
    if (images.length === 0) throw { message: '화면을 캡처하지 못했습니다.' }

    const candidates = await Promise.all(images.map(async base64 => {
      const image = `data:image/jpeg;base64,${base64}`
      try {
        const parsed = JSON.parse(await realTimePositionService.autoParse({ base64, mimeType: 'image/jpeg', prompt }))
        return { image, position: parsed, failed: false }
      } catch (e) {
        return { image, position: null, failed: true }
      }
    }))

    if (candidates.every(o => o.failed)) throw { message: '화면에서 포지션을 찾지 못했습니다.' }

    return { videoId, candidates }
  },
  autoCrawl: async ({
    youtubeHandle,
    channelTitle,
  }: {
    youtubeHandle: string,
    channelTitle?: string,
  }) => {
    const apikey = store.state.serverConfig.GOOGLE_AI_STUDIO
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${youtubeHandle}&type=channel&key=${apikey}`
      const resp = await axios.get(url)
      const found = resp['items'].find(item => item.snippet.channelTitle === channelTitle) || resp['items'][0]
      if (!found) return

      const channelId = found.id.channelId
      const resp2 = await axios.get(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&eventType=live&type=video&key=${apikey}`)
      const videoId = resp2['items'][0].id.videoId
      return videoId
    } catch (e) {
      return Promise.reject(e)
    }
  },
}

export default realTimePositionService
