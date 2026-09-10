import test from 'node:test'
import assert from 'node:assert'
import fastify from 'fastify'
import store from '../store'
import { useMetrics } from '../core/metrics'

const withToken = async (token: string) => {
  store.state.serverConfig.METRICS_TOKEN = token

  const app = fastify()
  await useMetrics(app)
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
