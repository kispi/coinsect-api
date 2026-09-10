import test from 'node:test'
import assert from 'node:assert'
import fastify, { FastifyInstance } from 'fastify'
import store from '../store'
import { useMetrics } from '../core/metrics'

// ready() 뒤에는 라우트를 더할 수 없다. 라벨을 확인하려면 요청을 태울 라우트가
// 필요하므로 부팅 전에 끼워 넣을 자리를 열어둔다.
const withToken = async (token: string, setup?: (app: FastifyInstance) => void) => {
  store.state.serverConfig.METRICS_TOKEN = token

  const app = fastify()
  await useMetrics(app)
  setup?.(app)
  await app.ready()

  return app
}

test('metrics: 토큰이 없으면 엔드포인트 자체를 열지 않는다', async () => {
  // 설정을 안 한 서버가 조용히 메트릭을 공개하는 것보다, 아예 없는 편이 안전하다.
  const app = await withToken('')
  const res = await app.inject({ method: 'GET', url: '/metrics' })

  assert.equal(res.statusCode, 404)
  await app.close()
})

test('metrics: 토큰이 맞을 때만 내려준다', async () => {
  const app = await withToken('s3cr3t')

  const denied = await app.inject({ method: 'GET', url: '/metrics' })
  // 401이 아니라 404다. "여기 뭔가 있다"를 알려주지 않는다.
  assert.equal(denied.statusCode, 404)

  const wrong = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer nope' },
  })
  assert.equal(wrong.statusCode, 404)

  const ok = await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer s3cr3t' },
  })
  assert.equal(ok.statusCode, 200)
  // 프로세스 기본 메트릭이 실려야 Prometheus가 파싱할 것이 생긴다.
  assert.ok(ok.body.includes('process_cpu_seconds_total'), '기본 메트릭이 있어야 한다')

  await app.close()
})

test('metrics: 쿼리스트링이 붙어도 토큰 검사를 지나치지 않는다', async () => {
  const app = await withToken('s3cr3t')
  const res = await app.inject({ method: 'GET', url: '/metrics?format=text' })

  assert.equal(res.statusCode, 404)
  await app.close()
})

test('metrics: 지표 이름과 라벨이 gukto-api와 같다', async () => {
  // 이게 이 모듈의 존재 이유다. 그라파나 대시보드 하나가 job만 바꿔 두 서버를 보려면
  // 이름과 라벨이 글자 단위로 같아야 한다. gukto-api core/monitoring.go 기준이다.
  // 라벨이 붙은 시계열이 나오도록 요청을 하나 태운다.
  const app = await withToken('s3cr3t', a => a.get('/streamers/:id', async () => ({ ok: true })))
  await app.inject({ method: 'GET', url: '/streamers/42' })

  const body = (await app.inject({
    method: 'GET',
    url: '/metrics',
    headers: { authorization: 'Bearer s3cr3t' },
  })).body

  assert.match(body, /^# TYPE http_requests_total counter$/m)
  assert.match(body, /^# TYPE http_request_duration_seconds histogram$/m)

  // 실제 URL이 아니라 등록된 패턴이어야 한다. /streamers/42가 라벨로 새면
  // id마다 시계열이 생긴다.
  assert.match(body, /^http_requests_total\{path="\/streamers\/:id",method="GET",status="200"\} 1$/m)
  assert.ok(!body.includes('/streamers/42'), '실제 URL이 라벨로 새면 안 된다')

  // fastify-metrics가 쓰던 이름으로 되돌아가면 대시보드가 조용히 빈다.
  assert.ok(!body.includes('route="'), 'route가 아니라 path여야 한다')
  assert.ok(!body.includes('status_code="'), 'status_code가 아니라 status여야 한다')

  await app.close()
})

test('metrics: 스크레이프 자신은 요청 수에 포함하지 않는다', async () => {
  // 15초마다 오는 자기 관측이라 정보가 없고, 총량을 읽을 때 배경 잡음이 된다.
  const app = await withToken('s3cr3t')
  const headers = { authorization: 'Bearer s3cr3t' }

  await app.inject({ method: 'GET', url: '/metrics', headers })
  const body = (await app.inject({ method: 'GET', url: '/metrics', headers })).body

  assert.ok(!/http_requests_total\{path="\/metrics"/.test(body), '/metrics는 세지 않는다')
  await app.close()
})
