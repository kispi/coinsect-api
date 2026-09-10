import { FastifyReply, FastifyRequest } from 'fastify'
import helpers from './helpers'

// 한 줄이 통째로 JSON이어야 한다.
//
// 예전에는 `[2026-09-10T02:16:36+00:00] {"method":...}` 처럼 시각을 접두사로 붙였다.
// 사람이 tail로 볼 때는 읽기 좋지만, 그 줄은 더 이상 JSON이 아니라서 Loki의 | json이
// 파싱에 실패한다(JSONParserErr). 그러면 그라파나에서 `| status >= 500`이나 `| ms > 1000`
// 같은 필드 단위 필터가 전부 막히고, 남는 건 문자열 검색뿐이다.
//
// 시각은 접두사가 아니라 time 필드로 넣는다. 정보는 그대로 있고 줄은 파싱된다.
const write = (level: 'info' | 'debug' | 'warn' | 'error', args: unknown[], extra?: object) => {
  // Error는 message만 찍으면 5xx를 추적할 수 없고, 그대로 넣으면 JSON.stringify가
  // 빈 객체로 만든다(name/message/stack이 열거되지 않는 속성이라서). 꺼내 담는다.
  const error = args.find(a => a instanceof Error) as Error | undefined
  const message = args
    .filter(a => a !== error)
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')

  const line = JSON.stringify({
    time: helpers.dayjs().format(),
    level,
    ...(message ? { message } : {}),
    // 스택은 줄바꿈이 이스케이프되어 한 줄 안에 들어간다. 예전처럼 여러 줄로 쏟아지지
    // 않으므로 promtail에 multiline 단계를 둘 필요가 없다.
    ...(error ? { error: error.name, errorMessage: error.message, stack: error.stack } : {}),
    ...extra,
  })

  if (level === 'error' || level === 'warn') return console.error(line)

  console.log(line)
}

export const createLogger = () => ({
  info: (...args: unknown[]) => write('info', args),
  debug: (...args: unknown[]) => write('debug', args),
  error: (...args: unknown[]) => write('error', args),
  warn: (...args: unknown[]) => write('warn', args),
  // 접근 로그. http 필드를 message 안에 문자열로 말아 넣지 않고 최상위에 편다 -
  // 그래야 status나 ms로 바로 거를 수 있다.
  // 심각도는 상태 코드가 정한다. 4xx도 error 스트림에 남긴다 - 클라이언트 잘못이지만
  // 급증하면 그것대로 신호이고, 예전부터 그 파일을 보고 이상 트래픽을 찾아왔다.
  http: (fields: object, args: unknown[] = []) => {
    const status = Number(fields['status']) || 0

    return write(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', args, fields)
  },
})

export const createHttpLog = (req: FastifyRequest, res: FastifyReply): {
  method?: string,
  url?: string,
  status?: number,
  ms?: number,
  ip?: string | string[],
  userAgent: string,
} => {
  const log = {
    method: req.method,
    url: req.url,
    status: (res || {}).statusCode,
    ms: Math.round(100 * (helpers.now() - req['$$startTime'])) / 100,
    ip: req.headers['ssr-proxy-from'] || req.headers['x-forwarded-for'] ||  req.socket.remoteAddress, // ssr-proxy-from은 ssr 서버에서 그리로 들어오는 x-forwarded-for를 넘겨준 것.
    userAgent: req.headers['user-agent'],
  }

  if (req.headers['is-ssr']) log['is-ssr'] = true

  return log
}

export const log = createLogger()

export default {
  log,
  createLogger,
  createHttpLog,
}