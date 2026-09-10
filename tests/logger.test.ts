import test from 'node:test'
import assert from 'node:assert'
import { createLogger } from '../core/logger'

// console을 가로채 실제로 찍힌 줄을 본다. 형식이 계약이기 때문이다 -
// 여기가 깨지면 그라파나 쿼리가 에러 없이 조용히 빈다.
const capture = async (fn: (log: ReturnType<typeof createLogger>) => void) => {
  const out: string[] = []
  const err: string[] = []
  const [origLog, origErr] = [console.log, console.error]

  console.log = (line: string) => out.push(line)
  console.error = (line: string) => err.push(line)
  try {
    fn(createLogger())
  } finally {
    console.log = origLog
    console.error = origErr
  }

  return { out, err }
}

test('logger: 모든 줄이 통째로 JSON이다', async () => {
  const { out } = await capture(log => log.info('안녕'))

  assert.equal(out.length, 1)
  // 접두사가 붙으면 여기서 던진다. Loki의 | json이 실패하는 것과 같은 이유다.
  const parsed = JSON.parse(out[0])
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.message, '안녕')
  assert.ok(parsed.time, 'time 필드가 있어야 한다')
})

test('logger: Error는 스택까지 같은 줄에 담는다', async () => {
  const { err } = await capture(log => log.error('터짐:', new Error('boom')))

  assert.equal(err.length, 1, '스택이 여러 줄로 쏟아지면 안 된다')
  const parsed = JSON.parse(err[0])
  assert.equal(parsed.message, '터짐:')
  assert.equal(parsed.error, 'Error')
  assert.equal(parsed.errorMessage, 'boom')
  assert.match(parsed.stack, /boom/)
})

test('logger: 접근 로그 필드는 최상위에 편다', async () => {
  // message 안에 문자열로 말아 넣으면 | status >= 500 같은 필터를 못 쓴다.
  const { out } = await capture(log => log.http({ method: 'GET', url: '/x', status: 200, ms: 1.5 }))

  const parsed = JSON.parse(out[0])
  assert.equal(parsed.status, 200)
  assert.equal(parsed.method, 'GET')
  assert.equal(parsed.ms, 1.5)
})

test('logger: 심각도는 상태 코드가 정한다', async () => {
  const ok = await capture(log => log.http({ status: 200 }))
  assert.equal(ok.out.length, 1, '2xx는 stdout')
  assert.equal(ok.err.length, 0)

  // 4xx도 error 스트림에 남긴다. 이상 트래픽을 그 파일에서 찾아왔다.
  const client = await capture(log => log.http({ status: 404 }))
  assert.equal(client.err.length, 1, '4xx는 stderr')
  assert.equal(JSON.parse(client.err[0]).level, 'warn')

  const server = await capture(log => log.http({ status: 500 }))
  assert.equal(JSON.parse(server.err[0]).level, 'error')
})
