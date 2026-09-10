// Prometheus 스크레이프용 /metrics.
//
// 로그(Loki)와 메트릭(Prometheus)은 목적이 다르다. 로그는 "이 요청 하나에 무슨 일이
// 있었나"를 남기고, 메트릭은 "지금 5xx 비율이 얼마인가"를 남긴다. 장애 감지는 후자가
// 훨씬 싸다 - 요청 한 건마다 한 줄을 쓰는 대신 카운터 하나를 올리기 때문이다.
//
// 그래서 로그에서 폴링 라우트를 빼도 그 트래픽이 안 보이게 되지는 않는다. 메트릭에는
// 그대로 남는다.
//
// 지표 이름과 라벨은 gukto-api(core/monitoring.go)와 **정확히 같게** 맞춘다. 그래야
// 그라파나 대시보드 하나가 job만 바꿔서 두 서버를 다 본다. fastify-metrics 플러그인을
// 쓰다 걷어낸 이유가 이것이다 - 그쪽은 route/status_code라는 다른 이름을 쓰는데
// 라벨 '이름'은 옵션으로 바꿀 수 없다(값만 바꾼다).
import { FastifyInstance } from 'fastify'
import { register, Counter, Histogram, collectDefaultMetrics } from '@platformatic/prom-client'
import { log } from './logger'
import store from '../store'

// 이 서버는 4100 포트가 인터넷에서 직접 닿는다(nginx를 거치지 않고도 열려 있었다).
// 그래서 'X-Forwarded-For가 없으면 내부 호출'이라는 판별은 쓸 수 없다 - 밖에서 직접
// 때리면 그 헤더가 없다. 공유 토큰으로 막는다.
//
// 메트릭 자체에 비밀은 없지만 라우트 목록과 트래픽 규모가 그대로 드러나고, 무엇보다
// 아무나 긁어갈 수 있는 엔드포인트를 열어둘 이유가 없다.
const ENDPOINT = '/metrics'

// 등록된 라우트 패턴만 라벨로 쓴다. 실제 URL을 쓰면 id마다 시계열이 생겨
// (카디널리티 폭발) Prometheus가 감당하지 못한다. 스캐너가 없는 주소를 두드리면
// 패턴이 없으므로 전부 unknown 하나로 접힌다.
const UNKNOWN_PATH = 'unknown'

// 레지스트리가 프로세스 전역이라 같은 프로세스에서 두 번 등록하면 "already registered"로
// 죽는다. 운영에서는 useMetrics가 한 번만 불리지만 테스트는 앱을 여러 번 세운다.
// 기본 메트릭은 되돌릴 방법이 없어 플래그로 막고, 우리 것은 이미 있으면 그것을 쓴다.
let defaultsCollected = false

const counterOf = () => (register.getSingleMetric('http_requests_total') as Counter<string>)
  || new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['path', 'method', 'status'],
  })

const histogramOf = () => (register.getSingleMetric('http_request_duration_seconds') as Histogram<string>)
  || new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['path', 'method'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
  })

export const useMetrics = async (app: FastifyInstance) => {
  const token = store.state.serverConfig.METRICS_TOKEN

  if (!token) {
    log.warn(`[.env] missing field METRICS_TOKEN: ${ENDPOINT}을 열지 않는다`)
    return
  }

  if (!defaultsCollected) {
    collectDefaultMetrics()
    defaultsCollected = true
  }

  const requests = counterOf()
  const duration = histogramOf()

  app.get(ENDPOINT, async (req, res) => {
    // 토큰이 틀리면 401이 아니라 404로 답한다 - 401은 "여기 뭔가 있다"고 알려주는 셈이다.
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.status(404).send({ message: 'Not Found' })
    }

    res.header('Content-Type', register.contentType)
    return res.send(await register.metrics())
  })

  app.addHook('onResponse', (req, res, next) => {
    // 스크레이프 자신은 세지 않는다. 15초마다 오는 자기 관측이라 정보가 없고,
    // 요청 총량을 읽을 때 배경 잡음이 된다.
    if (req.url.split('?')[0] === ENDPOINT) return next()

    const path = req.routeOptions?.url || UNKNOWN_PATH

    requests.labels(path, req.method, String(res.statusCode)).inc()
    // fastify가 재준 값이라 우리가 따로 시계를 들 필요가 없다. 단위는 ms이므로 초로 바꾼다.
    duration.labels(path, req.method).observe(res.elapsedTime / 1000)

    next()
  })
}
