import coreHelpers from '../core/helpers'
import IContext from '../core/interfaces/context'
import store from './store'
import helpers from './helpers'
import badWord from '../services/bad_word'
import firebase from '../services/firebase'
import messageHandlers from './message_handler'
import { Message, populateReactions } from '../entities/message'
import { IMessage, IUser, IUserSetting } from './types'
import { WebSocket } from '@fastify/websocket'
import { FastifyRequest } from 'fastify'
import { createHttpLog, log } from '../core/logger'
import { simplifiedReaction } from '../entities/reaction'
import { TypeUserRole, User } from '../entities/user'

const connections = store.getters.connections()

// 너무 짧은 시간에 수많은 소켓에 브로드캐스트하면 부하가 심해서, 특정 계정에 국한되지 않은 업데이트는 디바운스를 줌
//
// 디바운스된 함수는 모듈 스코프에서 한 번만 만들어야 한다. 예전에는 `type => debounce(...)`로
// 접속마다 새 디바운서를 만들어 호출했는데, debounce의 타이머는 클로저마다 따로라서
// 서로 합쳐지지 않았다. 입장 하나당 500ms 뒤에 전체 브로드캐스트가 한 번씩 그대로 나갔고,
// 동접이 몰릴 때 접속 이벤트 수 × 커넥션 수만큼 직렬화가 돌았다.
const broadcastStats = type => () => {
  store.actions.loadStats()
  helpers.broadcast({ type })
}
const debouncedBroadcastEnter = coreHelpers.debounce(broadcastStats('enter'), 500)
const debouncedBroadcastLeave = coreHelpers.debounce(broadcastStats('leave'), 500)

// @fastify/websocket v9+ 부터 핸들러가 SocketStream이 아닌 WebSocket 자체를 넘겨준다.
export const onConnected = (connection: WebSocket, req: FastifyRequest) => {
  // 웹소켓 접속시 토큰이 query param으로 넘어온 경우 그대로 사용, 없으면 만들어줌
  const token = req.query['token'] || helpers.mustToken()

  store.actions.setUser({ token, connection, ip: req.ip })
  store.actions.setUserSetting(token)

  // 유저 접속시 통계 업데이트
  debouncedBroadcastEnter()

  connection.on('close', () => {
    const idx = connections.findIndex(conn => conn.connection === connection)
    if (idx >= 0) connections.splice(idx, 1)

    // 유저 접속 끊길시 통계 업데이트
    debouncedBroadcastLeave()
  })

  connection.on('error', error => {
    log.error('websocket error:', error)
    log.error(JSON.stringify(createHttpLog(req, null)))
  })

  connection.on('message', rawMessage => {
    try {
      const message: IMessage = JSON.parse(rawMessage)
      const handler = messageHandlers({ message, token, ip: req.ip })[message.type]
      // 클라가 잘못된 요청(deprecated된 API 호출이라든지)을 하면 새로고침하도록 요청함.
      if (!handler) {
        // message.type은 클라이언트에서 채팅서버로 보낸 메시지의 타입임.
        log.error(`Invalid request: ${req.ip} requested unknown incoming message type '${message.type}'.`)
        helpers.sendMessage({
          message: {
            type: 'forceRefresh',
          },
          token,
        })
        return
      }

      handler()
    } catch (e) {
      log.error(`websocket error: ${e}\nIP: ${req.ip}}\nrawMessage: ${rawMessage}`)
    }
  })
}

/*
  messages 원본을 변형하면 안되므로 복사본을 사용한다.(메모리에 올라간 recentMessages[].reactions를 삭제하면 안됨)
  state.recentMessages는 100개로 제한되어 있으므로 잦은 복사가 문제가 되진 않을 듯?
*/
const processedMessages = (messages: Array<IMessage>, ip: string) => {
  return JSON.parse(JSON.stringify(messages)).map(message => {
    message.reactions = (message.reactions || []).map(simplifiedReaction)
    return {
      ...message,
      text: (message.type === 'text') ? badWord.filtered(message.text) : message.text,
    }
  })
}

export const chatCtrl = {
  authApiServer: (c: IContext) => {
    // TODO: 채팅서버가 분리된 이후로는 권한 없을 시 (API서버가 아닌 일반 브라우저에서의 호출 등) Promise.reject해야함.
    // 토큰은 API 서버별 env등에 채팅서버 이용권한 토큰같은걸 넣으면 될듯
  },
  config: {
    get: (c: IContext) => c.res.asJSON(store.getters.config()),
    post: (c: IContext) => {
      store.getters.config().allowImageMessage = c.req.body['allowImageMessage']
      c.res.asJSON(store.getters.config())
    },
  },
  sendPushNotification: async (c: IContext) => {
    const notification = c.req.body
    const tokens = Object.values(store.getters.userSettings() || {}).filter((s: IUserSetting) => {
      return s.deviceToken && s.pushPositionChange
    }).map((s: IUserSetting) => s.deviceToken) || []

    if (tokens.length === 0) return c.res.success()

    if (notification['body']) notification['body'] = coreHelpers.allNewlineTrimmed(notification['body'])

    try {
      await firebase.messaging.send({
        tokens,
        webpush: {
          notification,
          fcmOptions: {
            link: notification['link'],
          },
        },
      })
      c.res.success()
    } catch (e) {
      c.res.failed(e)
    }
  },
  user: {
    all: (c: IContext) => {
      try {
        const q = c.req.query

        const users = Object.values(store.getters.users()) as Array<IUser>
        users.forEach(user => user['setting'] = store.getters.userSetting(user.token))
        let filtered = users
        if (q['where']) {
          const stmts = decodeURI(q['where']).split(' AND ')
          const pairs = stmts.map(stmt => {
            const [a, b] = stmt.split(' LIKE ')
            const splitted = a.split('.')
            return {
              key: coreHelpers.case.toCamel(splitted[splitted.length - 1]),
              value: b.replace(/[%"]/g, ''),
            }
          })

          pairs.forEach(pair => {
            if (pair.key === 'nickname') filtered = filtered.filter(u => (u.profile.nickname || '').includes(pair.value))
            if (pair.key === 'image') filtered = filtered.filter(u => (u.profile.image || '').includes(pair.value))
            if (pair.key === 'path') filtered = filtered.filter(u => (u.path || '').includes(pair.value))
            if (pair.key === 'token') filtered = filtered.filter(u => (u.token || '').includes(pair.value))
            if (pair.key === 'deviceToken') filtered = filtered.filter(u => {
              if (!u['setting']) return

              return (u['setting']['deviceToken'] || '').includes(pair.value)
            })
            if (pair.key === 'lastSeen') filtered = filtered.filter(u => (u.lastSeen.toString() || '').includes(pair.value))
            if (pair.key === 'lastIP') filtered = filtered.filter(u => (u.lastIP || '').includes(pair.value))
          })
        }

        if (q['sort']) {
          const sign = q['order'] === 'desc' ? -1 : 1
          const c = q['sort']
          filtered.sort((a, b) => {
            const v1 = c === 'setting.deviceToken' ? (a['setting'] || {}).deviceToken : a[c]
            const v2 = c === 'setting.deviceToken' ? (b['setting'] || {}).deviceToken : b[c]
            if (v1 && v2) return v1 > v2 ? sign : -sign

            if (!v1) return -sign

            if (!v2) return sign
          })
        }

        c.res.asJSON({
          data: filtered.slice(
            parseInt(q['offset']) || 0,
            (parseInt(q['offset']) || 0) + (parseInt(q['limit']) || 0),
          ),
          total: filtered.length,
        })
      } catch (e) {
        c.res.failed()
      }
    },
    one: (c: IContext) => {
      const token = c.req.params['token']
      if (!token) return c.res.failed({ message: 'user token is missing' })

      const user = store.getters.user(token)
      if (user) c.res.asJSON(user)
      else c.res.failed({ message: 'user not found' })
    },
    ban: (c: IContext) => c.res.asJSON(store.actions.banIP(c.req.body['ip'], c.req.body['timeout'])),
    update: async (c: IContext) => {
      const profile = c.req.body['profile']
      const token = c.req.params['token']
      if (!profile || !token) return c.res.failed({ message: 'invalid payload' })

      /*
        헤더에 JWT가 있는 경우는
        1. 코인충에 로그인해서 사용중인 유저의 요청
        2. 어드민이 타인의 닉네임을 수정하는 요청
        인데, 2의 경우 어드민 본인의 닉네임이 업데이트되면 안되기 때문에 조건을 추가해준다.
      */
      const jwt = coreHelpers.jwt.getTokenFromHTTPHeader(c.req.headers)
      if (jwt) {
        const userFromJWT = await User.findWithJWT(jwt)
        if (userFromJWT && userFromJWT.role !== TypeUserRole.TypeAdmin) {
          try {
            await helpers.updateProfile({ user: userFromJWT, nickname: profile.nickname, image: profile.image })
          } catch (e) {
            return c.res.failed(e)
          }
        }
      }

      // 그게 아닌 경우(비로그인 유저) 토큰으로 찾아서 업데이트한다. 토큰을 변조해서 날린 경우 차단.
      const user = store.getters.user(token)
      if (!user) return c.res.failed({ message: 'user not found' })

      const trimmedNickname = coreHelpers.allNewlineTrimmed(coreHelpers.sanitize.strict(profile.nickname))
      if (!trimmedNickname) return c.res.failed({ message: '닉네임은 빈 문자열로 설정할 수 없습니다' })
      user.profile.nickname = trimmedNickname

      if (user.profile.nickname.length > store.getters.config().nicknameMaxLength) return c.res.failed({ message: '닉네임이 너무 깁니다' })

      if (profile.image) {
        const trimmedImageUrl = coreHelpers.sanitize.strict(profile.image)

        const l = store.getters.config().imageUrlMaxLength
        if (trimmedImageUrl.length > l) return c.res.failed({ message: `이미지 URL 길이가 ${trimmedImageUrl.length}입니다. 죄송하지만 ${l}자 이내의 것으로 사용해주세요` })
        user.profile.image = trimmedImageUrl

        if (!profile.image.startsWith('http')) return c.res.failed({ message: '올바른 이미지 URL이 아닙니다. (http로 시작하는 주소를 사용해주세요)' })
      } else {
        delete user.profile.image
      }

      if (profile.sentiment && ['long', 'short'].indexOf(profile.sentiment.type) >= 0) {
        profile.sentiment.expireAt = helpers.dayjs().add(24, 'hours').format()
        user.profile.sentiment = profile.sentiment
        store.actions.loadStats()
      }

      const connections = store.getters.targetConnections({ token })
      connections.forEach(conn => conn.user = user)

      helpers.broadcast({ type: 'update' })

      c.res.asJSON(user)
    },
    updateSetting: (c: IContext) => {
      const payload = c.req.body
      const token = c.req.params['token']
      if (!payload || !token) return c.res.failed({ message: 'invalid payload' })

      const user = store.getters.user(token)
      if (!user) return c.res.failed({ message: 'user not found' })

      const userSetting = store.getters.userSetting(token) || store.actions.createUserSetting(token)
      const updatableFields = ['deviceToken', 'pushChatNewMessage', 'pushPositionChange']
      updatableFields.forEach(field => {
        if (typeof payload[field] !== 'undefined') userSetting[field] = payload[field]
      })

      store.actions.setUserSetting(token)
      c.res.asJSON(userSetting)
    },
    delete: (c: IContext) => {
      const token = c.req.params['token']
      if (!token) return c.res.failed({ message: 'invalid request' })

      store.actions.deleteUser(token)
      c.res.success()
    },
    deleteOld: (c: IContext) => {
      store.actions.deleteOldUsers(c.req.query['hoursPassed'] || 48)
      c.res.success()
    },
  },
  message: {
    all: async (c: IContext) => {
      const limit = c.req.query['limit']
      if (parseInt(limit) >= 1000) {
        c.res.failed({ message: 'limit is too big' })
        return
      }

      const qb = c.orm.getRepository(Message).createQueryBuilder()
        .leftJoinAndSelect('Message.user', 'user')
        .leftJoinAndSelect('user.profile', 'profile')
        .limit(limit || store.getters.config().numLatestMessages)
        .orderBy('Message.id', 'DESC')
      const cursor = c.req.query['firstMessageId']
      if (cursor) qb.where('Message.id < :cursor', { cursor })
      else {
        return c.res.asJSON(processedMessages(store.getters.recentMessages(), c.req.ip))
      }

      try {
        const data = await qb.getMany()
        // .leftJoinAndSelect('Message.reactions', 'reactions')로 하면 너무 느려서 걍 쿼리를 한 번 더 함
        await populateReactions(data)
        const json = JSON.parse(JSON.stringify(data))
        c.res.asJSON(processedMessages(json.map(helpers.asIMessage), c.req.ip))
      } catch (e) {
        log.error('chatCtrl.messages.all:', e)
        c.res.error()
      }
    },
    send: (c: IContext) => {
      const message = c.req.body['message']
      if (!message) return c.res.failed({ message: 'message is required' })

      const ip = c.req.body['ip']
      const token = c.req.body['token']
      if (!message) return c.res.failed({ message: 'message is required' })
      if (!ip && !token) return c.res.failed({ message: 'either ip or token is required to determine who to send the message' })

      helpers.sendMessage({ message, ip, token })
      c.res.success()
    },
    broadcast: (c: IContext) => {
      const message = c.req.body['message']
      if (!message) return c.res.failed({ message: 'message is required' })

      helpers.broadcast(message)
      c.res.success()
    },
    invalidate: async (c: IContext) => {
      try {
        await store.actions.loadRecentMessages()
        c.res.success()
      } catch (e) {
        c.res.failed(e)
      }
    },
    updateReactions: (c: IContext) => {
      const messageId = parseInt(c.req.params['id'])
      const updatedReactions = c.req.body['reactions']
      if (!messageId) return

      helpers.broadcast({
        type: 'updateReaction',
        meta: { messageId, updatedReactions },
      })
    },
    hideMessage: (c: IContext) => {
      const messageId = parseInt(c.req.params['id'])
      if (!messageId) return

      helpers.broadcast({
        type: 'hideMessage',
        meta: { messageId },
      })
    },
  },
}