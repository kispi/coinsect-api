import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { log, createHttpLog } from './logger'
import { dataSource } from '../database'
import useCache from './cache'
import useResponse from './response'
import IContext from './interfaces/context'

const createContext = (req: FastifyRequest, reply: FastifyReply): IContext => ({
  orm: dataSource,
  cache: useCache(),
  req,
  res: useResponse(reply),
  validate: {
    requiredFields: (fields: string[]) => fields.every(field => req.body[field]),
  },
})

const useMiddleware = async (
  req: FastifyRequest,
  res: FastifyReply,
  handler: Function,
  middleware?: Function,
) => {
  const c = createContext(req, res)

  const hl = () => createHttpLog(req, res)

  if (middleware) {
    try {
      await middleware(c)
    } catch (e) {
      c.res.failed(e, (e || {}).code)
      log.error(hl())
      return
    }
  }

  try {
    await handler(c)
  } catch (e) {
    // e.code가 있으면 서버개발자의 커스텀 에러이고, 없는 경우는 500으로 처리한다.
    if ((e || {}).code) c.res.failed(e, e.code)
    else c.res.error()
    log.http(hl(), [e])
    return
  }

  // 특별할 것 없는 매번 앱 새로고침될때마다 콜되는 API들 스킵함.
  // 폴링 라우트. 정상 응답이 초 단위로 쌓이는데 그 한 줄 한 줄에 정보가 없다.
  // (집 PC가 5초, 어드민 화면이 열려 있는 동안 5초)
  const routesSkipLog = [
    '/config',
    '/notifications',
    '/market_info/indices',
    '/market_info/symbols',
    '/market_info/markets',
    '/contents/real_time_positions/desktop_jobs',
    '/admin/contents/real_time_positions/desktop_jobs',
  ]
  if (routesSkipLog.includes(req.routeOptions.url)) return

  log.http(hl())
}

export const useRouter = (app: FastifyInstance) => ({
  get: (path: string, handler: Function, middleware?: Function) => {
    app.get(path, (req, res) => useMiddleware(req, res, handler, middleware))
  },
  post: (path: string, handler: Function, middleware?: Function) => {
    app.post(path, (req, res) => useMiddleware(req, res, handler, middleware))
  },
  put: (path: string, handler: Function, middleware?: Function) => {
    app.put(path, (req, res) => useMiddleware(req, res, handler, middleware))
  },
  delete: (path: string, handler: Function, middleware?: Function) => {
    app.delete(path, (req, res) => useMiddleware(req, res, handler, middleware))
  },
})

export default {
  useRouter,
}