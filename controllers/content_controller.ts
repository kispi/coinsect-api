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

        // <@U…> 멘션으로 넣으면 슬랙이 표시 이름으로 렌더해주지만, ID를 못 찾으면 빈 칩이
        // 그려져 기록 한가운데 정체불명의 막대가 남는다. 평문으로 적는다.
        // name은 워크스페이스에 따라 사람 이름이 아니라 도메인('coinsect.io')이 오므로 뒤로 뺀다.
        const user = payload.user || {}
        const who = user.username || user.name || user.id || '누군가'
        // 서버가 UTC라 그대로 찍으면 아홉 시간 어긋난다. 앱 전역의 타임존 설정을 건드리는
        // 대신 이 문구에서만 옮긴다. 한국은 서머타임이 없어 +9가 항상 맞다.
        const kst = new Date(Date.now() + 1000 * 60 * 60 * 9).toISOString()
        const when = `${kst.slice(5, 10)} ${kst.slice(11, 16)}` // MM-DD HH:mm

        const { id, reportedAt } = JSON.parse(action.value)
        // 어떤 스트리머의 무슨 포지션이었는지는 제보에만 있다. 그래서 기록 문구는
        // 서비스가 만들어 돌려주고, 여기서는 슬랙에서만 알 수 있는 승인자와 시각을 넘긴다.
        const result = await service.content.realTimePosition.resolveReport({
          id,
          reportedAt,
          approve: action.action_id === 'position_approve',
          who,
          when,
        })

        await axios.post(payload.response_url, {
          replace_original: true,
          text: result.text,
        })
      } catch (e) {
        log.error('slackInteraction failed:', e)
      }
    },
    changeNotification: {
      // 제보함이 Redis로 옮겨가며 all()이 async가 됐다. await 없이 넘기면 fastify가
      // Promise를 그대로 {}로 직렬화해, 어드민이 배열인 줄 알고 filter를 부르다 죽는다.
      all: async (c: IContext) => {
        try {
          c.res.asJSON(await service.content.realTimePosition.changeNotification.all())
        } catch (e) {
          c.res.failed(e)
        }
      },
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