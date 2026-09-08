import IContext from './interfaces/context'
import helpers from './helpers'
import store from '../store'
import { TypeUserAuth } from '../entities/user'

const errorUnauthorized = {
  message: 'unauthorized',
  status: 401,
}

const foo = async (
  c: IContext,
  authArray: Array<TypeUserAuth>,
) => {
  if ((authArray || []).length === 0) return Promise.reject({ message: 'invalid request', status: 400 })

  try {
    const adminUser = await helpers.jwt.getPayload(c)
    if (adminUser['role'] !== 'admin' || authArray.indexOf(adminUser['auth']) < 0) return Promise.reject(errorUnauthorized)
  } catch (e) {
    return Promise.reject(e)
  }
}

const middlewares = {
  auth: {
    admin: {
      super: async (c: IContext) => foo(c, [TypeUserAuth.TypeSuper]),
      manager: async (c: IContext) => foo(c, [TypeUserAuth.TypeSuper, TypeUserAuth.TypeManager]),
      position: async (c: IContext) => foo(c, [TypeUserAuth.TypeSuper, TypeUserAuth.TypeManager, TypeUserAuth.TypePosition]),
    },
    user: (c: IContext) => helpers.jwt.getPayload(c),
    // 집에서 도는 capture_desktop을 식별한다. 방어보다는 요청자 표기와 제보 레인
    // 분기에 쓰이는 신원 확인에 가깝다.
    desktop: async (c: IContext) => {
      const secret = store.state.serverConfig.DESKTOP_SECRET
      if (!secret || c.req.headers['x-desktop-secret'] !== secret) return Promise.reject(errorUnauthorized)
    },
  },
}

export default middlewares