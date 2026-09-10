// Prometheus 스크레이프용 /metrics.
//
// 로그(Loki)와 메트릭(Prometheus)은 목적이 다르다. 로그는 "이 요청 하나에 무슨 일이
// 있었나"를 남기고, 메트릭은 "지금 5xx 비율이 얼마인가"를 남긴다. 장애 감지는 후자가
// 훨씬 싸다 - 요청 한 건마다 한 줄을 쓰는 대신 카운터 하나를 올리기 때문이다.
//
// 그래서 로그에서 폴링 라우트를 빼도 그 트래픽이 안 보이게 되지는 않는다. 메트릭에는
// 그대로 남는다.
import { FastifyInstance } from 'fastify'
import fastifyMetrics from 'fastify-metrics'
import { log } from './logger'
import store from '../store'

// 이 서버는 4100 포트가 인터넷에서 직접 닿는다(nginx를 거치지 않고도 열려 있다).
// 그래서 'X-Forwarded-For가 없으면 내부 호출'이라는 판별은 쓸 수 없다 - 밖에서 직접
// 때리면 그 헤더가 없다. 공유 토큰으로 막는다.
//
// 메트릭 자체에 비밀은 없지만 라우트 목록과 트래픽 규모가 그대로 드러나고, 무엇보다
// 아무나 긁어갈 수 있는 엔드포인트를 열어둘 이유가 없다.
const ENDPOINT = '/metrics'

export const useMetrics = async (app: FastifyInstance) => {
  const token = store.state.serverConfig.METRICS_TOKEN

  if (!token) {
    log.warn(`[.env] missing field METRICS_TOKEN: ${ENDPOINT}을 열지 않는다`)
    return
  }

  await app.register(fastifyMetrics, {
    endpoint: ENDPOINT,
    // prom-client의 기본 레지스트리는 프로세스 전역이라, 같은 프로세스에서 두 번 등록하면
    // "already been registered"로 죽는다. 운영에서는 한 번뿐이지만 테스트에서는 앱을
    // 여러 번 세운다. 우리가 이 레지스트리에 따로 담는 것이 없으므로 지우고 시작한다.
    clearRegisterOnInit: true,
    // 라우트별 히스토그램은 등록된 경로 패턴(/contents/:id)으로 묶인다. 실제 URL로
    // 묶으면 id마다 시계열이 생겨 Prometheus가 터진다.
    routeMetrics: { enabled: true },
  })

  // 등록 순서상 fastify-metrics가 만든 라우트에도 걸린다. 토큰이 틀리면 404로 답한다 -
  // 401은 "여기 뭔가 있다"고 알려주는 셈이라 굳이 알려주지 않는다.
  app.addHook('onRequest', (req, res, next) => {
    if (req.url.split('?')[0] !== ENDPOINT) return next()
    if (req.headers.authorization === `Bearer ${token}`) return next()

    res.status(404).send({ message: 'Not Found' })
  })
}
