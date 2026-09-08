import axios from 'axios'
import helpers from '../core/helpers'
import { log } from '../core/logger'
import IContext from '../core/interfaces/context'
import useService from '../services'
import bitcoinQuotes from '../constants/bitcoin_quotes'
import countries from '../constants/countries'
import prices from '../constants/prices'

const service = useService()

const contentController = {
  // goapi(kispi/goapi)에서 넘어온 정적 데이터 3종이다. 원본은 Go 서버가 기동 시 data/*.json을
  // 읽어 메모리에 캐시해두고 그대로 뱉는 구조였는데, TS 모듈 상수가 되면서 그 캐시 계층 자체가
  // 필요 없어졌다. 서비스 계층을 두지 않은 것도 같은 이유로, config/reaction 컨트롤러가
  // constants/emojis를 직접 쓰는 것과 같은 방식이다.
  bitcoinQuotes: (c: IContext) => c.res.asJSON(bitcoinQuotes),
  countries: (c: IContext) => c.res.asJSON(countries),
  prices: (c: IContext) => c.res.asJSON(prices),
  realTimePositions: {
    presets: (c: IContext) => c.res.asJSON(service.content.realTimePosition.presets()),
    autoParse: async (c: IContext) => {
      try {
        const data = await service.content.realTimePosition.autoParse({
          url: c.req.body['url'],
          prompt: c.req.body['prompt'],
        })
        c.res.asJSON(data)
      } catch (e) {
        c.res.failed(e)
      }
    },
    desktopTargets: async (c: IContext) => {
      try {
        c.res.asJSON(await service.content.realTimePosition.desktopTargets())
      } catch (e) {
        c.res.failed(e)
      }
    },
    desktopReport: async (c: IContext) => {
      try {
        c.res.asJSON(await service.content.realTimePosition.desktopReport({
          positionId: c.req.body['positionId'],
          videoId: c.req.body['videoId'],
          isLive: !!c.req.body['isLive'],
          images: c.req.body['images'],
        }))
      } catch (e) {
        c.res.failed(e)
      }
    },
    // 슬랙 버튼 클릭. 슬랙은 3초 안의 응답을 요구하므로 먼저 200을 주고,
    // 실제 반영과 메시지 갱신은 response_url로 이어서 한다.
    slackInteraction: async (c: IContext) => {
      c.res.success()

      try {
        const payload = JSON.parse(c.req.body['payload'])
        const action = (payload.actions || [])[0]
        if (!action) return

        const { id, reportedAt } = JSON.parse(action.value)
        const result = await service.content.realTimePosition.resolveReport({
          id,
          reportedAt,
          approve: action.action_id === 'position_approve',
        })

        const who = ((payload.user || {}).name) || '누군가'
        await axios.post(payload.response_url, {
          replace_original: true,
          text: `${result.message} — ${who}, ${helpers.dayjs().format('MM-DD HH:mm')}`,
        })
      } catch (e) {
        log.error('slackInteraction failed:', e)
      }
    },
    changeNotification: {
      all: (c: IContext) => c.res.asJSON(service.content.realTimePosition.changeNotification.all()),
      create: async (c: IContext) => {
        try {
          c.res.success(await service.content.realTimePosition.changeNotification.create(c))
        } catch (e) {
          c.res.failed(e)
        }
      },
    },
    all: async (c: IContext) => {
      try {
        c.res.asJSON(helpers.crypto.encryptAPIResponse(await service.content.realTimePosition.all()))
      } catch (e) {
        c.res.failed(e)
      }
    },
    set: async (c: IContext) => {
      try {
        await service.content.realTimePosition.set(c.req.body)
        c.res.success()
      } catch (e) {
        c.res.failed(e)
      }
    },
    delete: async (c: IContext) => {
      try {
        await service.content.realTimePosition.delete(c.req.params['id'])
        c.res.success()
      } catch (e) {
        c.res.failed(e)
      }
    },
  },
  news: {
    upbit: async (c: IContext) => {
      try {
        const data = await service.content.news.upbit()
        c.res.success(data)
      } catch (e) {
        c.res.failed({ message: '업비트 뉴스를 가져오는 중 문제가 발생했습니다' })
      }
    },
  },
}

export default contentController