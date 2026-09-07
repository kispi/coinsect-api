import IContext from '../core/interfaces/context'
import helpers from '../core/helpers'
import useService from '../services'
import { log } from '../core/logger'
import { AuthToken, TypeProvider } from '../entities/auth_token'
import { TypeUserRole, User,  } from '../entities/user'
import { Profile } from '../entities/profile'

const service = useService()

const afterSignIn = (c: IContext, user: User) => {
  user.lastSignIn = new Date()
  user.lastSignInIp = c.req.ip
  user.signInCount += 1
  c.orm.getRepository(User).save(user)
  c.res.success({ token: User.jwt(user) })
}

const mustAuthToken = async (c: IContext, kakaoId: string) => {
  const existingToken = await c.orm.getRepository(AuthToken).findOne({
    // provider까지 걸어야 다른 소셜의 동일한 ID 문자열과 겹치지 않는다.
    where: { token: kakaoId, provider: TypeProvider.TypeKakao },
    relations: ['user', 'user.profile'],
  })
  if (existingToken) return existingToken

  const newToken = await c.orm.getRepository(AuthToken).save({
    token: kakaoId,
    provider: TypeProvider.TypeKakao,
  })
  if (newToken) return newToken

  return Promise.reject({ message: 'ERR_TOKEN_NOT_CREATED' })
}

const mustUser = async (c: IContext, email: string) => {
  const existingUser = await c.orm.getRepository(User)
    .createQueryBuilder()
    .where('email = :email', { email })
    .leftJoinAndSelect('User.profile', 'profile')
    .getOne()
  if (existingUser) return existingUser

  const newUser = await c.orm.getRepository(User).save({
    email,
    role: TypeUserRole.TypeUser,
  })
  if (newUser) return newUser

  return Promise.reject({ message: 'ERR_USER_NOT_CREATED' })
}

const mustProfile = async (c: IContext, user: User) => await c.orm.getRepository(Profile).save({
  user,
  nickname: await service.profile.generateUnique(),
})

const authController = {
  signIn: async (c: IContext) => {
    try {
      const user = await c.orm.getRepository(User).findOne({ where: { email: c.req.body['email'] } })
      if (!user) return c.res.failed({ message: 'user not found' })

      if (!helpers.crypto.compare(user.password, c.req.body['password'])) return c.res.failed({ message: 'password not match' })
      c.res.success({ token: User.jwt(user) })
    } catch (e) {
      c.res.failed(e)
    }
  },
  // 예전에는 클라이언트가 보낸 kakaoId/email을 그대로 신원으로 썼다. 아무나 원하는
  // 값으로 POST하면 계정이 생기거나 남의 계정에 로그인됐다. 이제 액세스 토큰만 받고
  // 신원은 전부 카카오에 확인해서 얻는다.
  signInKakao: async (c: IContext) => {
    if (!c.validate.requiredFields(['accessToken'])) return c.res.failed({ message: 'invalid payload' })

    let identity: { kakaoId: string, email: string }
    try {
      identity = await service.kakao.verifyAccessToken(c.req.body['accessToken'])
    } catch (e) {
      log.error('signInKakao: token verification failed:', e)
      return c.res.failed(e)
    }

    try {
      let authToken = await mustAuthToken(c, identity.kakaoId)
      if (authToken?.user?.profile) return afterSignIn(c, authToken.user)

      authToken.user = await mustUser(c, identity.email)
      authToken.user.profile = await mustProfile(c, authToken.user)
      c.orm.getRepository(AuthToken).save(authToken)
      return afterSignIn(c, authToken.user)
    } catch (e) {
      log.error('signInKakao:', e)
      service.slack.postMessage(({
        text: `
          실패한 카카오 계정 생성 시도가 있습니다.
          email: ${identity.email}
          kakaoId: ${identity.kakaoId}
        `,
        channel: 'coinsect-api',
      }))
      c.res.failed(e)
    }
  },
}

export default authController