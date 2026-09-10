import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyFormbody from '@fastify/formbody'
import useRoutes from './routes'
import axios from 'axios'
import store from './store'
import helpers from './core/helpers'
import useChat from './chat/server'
import marketInfoService from './services/market_info'
import { dataSource } from './database'
import { log, createHttpLog } from './core/logger'

axios.defaults.timeout = 1000 * 10

axios.interceptors.response.use(
  res => res.data,
  err => {
    if (!err.response) {
      throw err
    }

    throw err.response
  },
)

const checkServerConfig = () => {
  const requiredFields = [
    'API_PORT',
    'JWT_SECRET',
    'KAKAO_APP_ID',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_BUCKET',
    'AWS_S3_CDN',
    'USE_REDIS',
    'COINSECT_CHAT',
  ]

  const c = store.state.serverConfig
  requiredFields.forEach(field => {
    if (!c[field]) {
      log.error(`[.env] missing required field: ${field}`)
      process.exit()
    }
  })

  if (!c['SLACK_COINSECT_API'] || !c['SLACK_IMAGE_MODERATION']) {
    log.warn(`[.env] missing field SLACK_COINSECT_API, SLACK_IMAGE_MODERATION: Slackbot posting won't work`)
  }

  if (!c['WHALE_ALERT']) {
    log.warn(`[.env] missing field WHALE_ALERT: Whale alert won't work`)
  }

  if (!c['GOOGLE_AI_STUDIO']) {
    log.warn(`[.env] missing field GOOGLE_AI_STUDIO: Google AI Studio won't work`)
  }
}

const o = {}
const handleNotFound = (req: FastifyRequest, res: FastifyReply) => {
  res.status(404)

  const k = `${req.url}:${req.ip}`
  if (o[k]) o[k]++
  else o[k] = 1

  // 같은 IP가 존재하지 않는 같은 url로 100번 때릴때마다 한번씩 로그를 찍음
  if (o[k] % 100 === 0) {
    const l = createHttpLog(req, res)
    l['missingCount'] = o[k]
    log.error(JSON.stringify(l))
  }

  res.send({ message: 'Not Found' })
}

const allowedOriginDomains = ['coinsect.io', 'gravex.app']
const allowedOriginDevHosts = ['localhost', '127.0.0.1', '[::1]']

/*
  origin은 hostname을 파싱해서 정확히 비교한다.
  substring 비교를 쓰면 `https://coinsect.io.attacker.com`이나 `https://localhost.attacker.com`처럼
  공격자가 소유한 도메인도 통과해버린다.
*/
const isAllowedOrigin = (origin: string) => {
  let hostname: string

  try {
    hostname = new URL(origin).hostname
  } catch (e) {
    return false
  }

  if (allowedOriginDevHosts.indexOf(hostname) >= 0) return true

  return allowedOriginDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

export const initApp = async (app: FastifyInstance) => {
  checkServerConfig()

  // 슬랙 인터랙션은 application/x-www-form-urlencoded로 온다. fastify는 이 타입의
  // 파서를 기본으로 갖고 있지 않아서, 없으면 415로 튕긴다.
  app.register(fastifyFormbody)

  app.register(fastifyCors, {
    // @fastify/cors의 기본값은 'GET,HEAD,POST'라서 지정하지 않으면
    // 어드민 콘솔의 수정(PUT)/삭제(DELETE)가 preflight 단계에서 전부 막힌다.
    methods: 'GET,HEAD,POST,PUT,DELETE',
    origin: (origin, cb) => {
      if (
        !origin || // 나중엔 삭제될 조건인데 일단 동일 서버에서 호출하는 경우도 허용해줌 (origin 없음)
        isAllowedOrigin(origin)
      ) {
        cb(null, true)
        return
      }
      cb(new Error('Not allowed'), false)
    },
  })
  app.addHook('onRequest', (req, res, next) => {
    req['$$startTime'] = helpers.now()
    next()
  })
  // 4xx는 클라이언트가 잘못 보낸 것이고 5xx만 우리 잘못이다. 둘을 같이 취급해 스택을
  // 찍으면, 옛 클라이언트 하나가 계속 두드리는 것만으로 에러 로그가 채워진다.
  // 실제로 구 프론트가 MySQL XOR 필터를 분당 9회 보내며 하루 17MB를 만들고 있었다.
  //
  // 4xx도 로그는 남긴다 - 어떤 요청이 왜 거절됐는지는 봐야 하고, 그게 급증하면 그것대로
  // 신호다. 스택트레이스만 뺀다.
  app.addHook('onError', (req, res, error, next) => {
    const status = (error as { status?: number, statusCode?: number }).status
      || (error as { statusCode?: number }).statusCode
      || res.statusCode

    if (status >= 400 && status < 500) {
      log.error(`${error.name || 'ClientError'}: ${error.message} ${JSON.stringify(createHttpLog(req, res))}`)
      return next()
    }

    log.error('fastify onError hook:', error)
    log.error(JSON.stringify(createHttpLog(req, res)))
    next()
  })
  await dataSource.initialize()

  app.setNotFoundHandler(handleNotFound)
  const routeMaker = useRoutes(app)
  routeMaker.admin()
  routeMaker.service()

  Promise.all([
    store.actions.loadBadWords(),
    store.actions.loadBannedUsers(),
    marketInfoService.symbols(),
    marketInfoService.markets(),
  ])

  // 나중에 따로 떼서 걔는 얘만 실행하는것도 가능
  useChat(app)
}

export const app = fastify({
  trustProxy: true,
  // capture_desktop이 보내는 프레임 3장이 base64로 부풀면 기본값 1MB를 넘긴다.
  bodyLimit: 1024 * 1024 * 16,
  // fastify 5부터 라우터 옵션은 routerOptions 아래로 옮겨졌다. (최상위 지정은 fastify 6에서 제거됨)
  routerOptions: {
    ignoreTrailingSlash: true,
  },
})

export const backendGitHash = () => new Promise((resolve, reject) => {
  const exec = require('child_process').exec
  exec('git rev-parse --short HEAD', (err, stdout) => {
    if (stdout) return resolve(stdout.trim())
    if (err) return reject(err)
  })
})