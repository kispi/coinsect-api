import axios from 'axios'
import helpers from '../core/helpers'
import { log } from '../core/logger'
import IContext from '../core/interfaces/context'
import useService from '../services'
import { kstStamp } from '../services/content/position_reports'
import { isLimitedRequest } from '../services/content/desktop_jobs'
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
    // '지금 캡처'. 집 PC가 다음 폴링(5초)에 집어간다. 어드민과 사용자가 같은 경로를 쓴다 -
    // 하는 일이 같은데 라우트를 둘로 두면 한쪽만 고치는 실수가 생긴다.
    //
    // 다른 건 제한을 받느냐뿐이고, 그건 토큰으로 갈린다. 운영자에게 면제를 주는 이유는
    // 오인식을 발견하고 다시 긁으려 할 때 방금 그 오인식 때문에 쿨다운에 걸리기 때문이다.
    // mustUser는 토큰이 없거나 깨졌으면 조용히 undefined를 준다 - 즉 기본이 '제한 받음'이다.
    enqueueCapture: async (c: IContext) => {
      try {
        const user = await helpers.jwt.mustUser(c)
        const byUser = isLimitedRequest(user, c.req.body)

        const { data } = await service.content.realTimePosition.all()
        const found = data.find(o => o.id === c.req.params['id'])
        if (!found) return c.res.failed({ message: '해당 스트리머를 찾을 수 없습니다.' })
        if (!found.channelUrl) return c.res.failed({ message: '채널 핸들이 없어 자동 캡처 대상이 아닙니다.' })

        const result = await service.content.desktopJobs.enqueue(found, { byUser })

        // 막힌 경우도 200으로 준다. 실패가 아니라 '조금 뒤에 다시'라는 뜻이고,
        // 화면에서 남은 시간을 보여주려면 본문을 읽어야 한다.
        c.res.asJSON({
          ...result,
          // 집 PC가 꺼져 있으면 눌러도 아무 일이 없다. 그걸 눌러본 사람이 알 수 있어야 한다.
          desktopAlive: await service.content.desktopJobs.alive(),
        })
      } catch (e) {
        c.res.failed(e)
      }
    },
    desktopJobs: async (c: IContext) => {
      try {
        c.res.asJSON(await service.content.desktopJobs.status())
      } catch (e) {
        c.res.failed(e)
      }
    },
    // 집 PC의 폴링. 하트비트와 잡 인수를 한 번에 한다.
    pollDesktopJobs: async (c: IContext) => {
      try {
        c.res.asJSON(await service.content.desktopJobs.poll(c.req.body['done']))
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
    // 슬랙 인터랙션. 슬랙은 3초 안의 응답을 요구하므로 먼저 200을 주고,
    // 실제 반영과 메시지 갱신은 response_url로 이어서 한다.
    slackInteraction: async (c: IContext) => {
      c.res.success()

      try {
        const payload = JSON.parse(c.req.body['payload'])
        const action = (payload.actions || [])[0]
        if (!action) return

        // 체크박스를 토글할 때도 여기로 온다. 선택만 적어두고 메시지는 그대로 둔다.
        // 이걸 걸러내지 않으면 토글 한 번이 승인으로 처리된다.
        if (action.action_id === 'position_select') {
          const { id } = JSON.parse(action.block_id || '{}')
          await service.content.realTimePosition.selectReported(
            id,
            (action.selected_options || []).map(o => o.value),
          )
          return
        }

        if (action.action_id !== 'position_approve' && action.action_id !== 'position_reject') return

        // <@U…> 멘션으로 넣으면 슬랙이 표시 이름으로 렌더해주지만, ID를 못 찾으면 빈 칩이
        // 그려져 기록 한가운데 정체불명의 막대가 남는다. 평문으로 적는다.
        // name은 워크스페이스에 따라 사람 이름이 아니라 도메인('coinsect.io')이 오므로 뒤로 뺀다.
        const user = payload.user || {}
        const who = user.username || user.name || user.id || '누군가'
        const { id, reportedAt } = JSON.parse(action.value)
        // 어떤 스트리머의 무슨 포지션이었는지는 제보에만 있다. 그래서 기록 문구는
        // 서비스가 만들어 돌려주고, 여기서는 슬랙에서만 알 수 있는 승인자와 시각을 넘긴다.
        const result = await service.content.realTimePosition.resolveReport({
          id,
          reportedAt,
          approve: action.action_id === 'position_approve',
          who,
          when: kstStamp(),
        })

        // 반영하지 못한 경우(체크가 비었음)는 원본을 남겨야 다시 눌러볼 수 있다.
        await axios.post(payload.response_url, result.ok
          ? { replace_original: true, text: result.text }
          : { replace_original: false, response_type: 'ephemeral', text: result.text })
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