import { IMessage } from './types'
import { log } from '../core/logger'
import coreHelpers from '../core/helpers'
import useService from '../services'
import helpers from './helpers'
import store from './store'

const service = useService()

// broadcast하기 적절하지 않은 메시지인 경우 reject
const challengeSoundnessOfMessage = async (text: string) => {
  const url = coreHelpers.retrieveUrlFromString(text)
  if (!url) return

  if (!coreHelpers.isImageUrl(url)) return

  const allowedImageExts = ['.jpg', '.jpeg', '.png']
  if (!allowedImageExts.some(ext => url.toLowerCase().endsWith(ext))) {
    return Promise.reject({ message: `${allowedImageExts.join(' / ')} 이미지만 사용할 수 있습니다 😢` })
  }

  try {
    if (await service.aws.rekognition.imageModeration.isGraphic(url)) {
      return Promise.reject({ message: '타인에게 불쾌감을 주는 이미지를 업로드하면 채팅 이용이 제한됩니다.', code: 'ERR_GRAPHIC_IMAGE' })
    }
  } catch (e) {
    // AWS Rekognition에서 reject된 경우인데, 일반적으로 이게 보일 일은 없을듯. (AWS Credential이 잘못됐다거나?)
    return Promise.reject({ message: '이미지를 처리하는 과정에서 오류가 발생했습니다 😢' })
  }
}

const messageHandlers = ({ message, ip, token }:  { message: IMessage, ip: string, token: string }) => ({
  image: () => {
    if (!store.getters.config().allowImageMessage) {
      return helpers.alertUser({ token, text: '현재 이미지 업로드 기능을 사용할 수 없습니다 😢' })
    }

    messageHandlers({ message, ip, token }).text()
  },
  text: async () => {
    const bannedUser = coreHelpers.useBannedUser({ ip, token })
    if (bannedUser) {
      return helpers.alertUser({
        text: `
          채팅이 제한되었습니다
          해제: ${helpers.formatWithAdd({ date: bannedUser.until })}
          사유: ${bannedUser.reason}
        `, token
      })
    }

    const t = store.getters.bannedUntil(ip)
    if (t) {
      return helpers.alertUser({
        text: helpers.dayjs(t).diff(helpers.dayjs(), 'second') < store.getters.config().allowedChatFrequency ?
        '너무 빠른 채팅은 타인에게 피해를 줄 수 있습니다 🙂' :
        `채팅 제한 해제: ${helpers.formatWithAdd({ date: t })}`,
        // 정확한 로직은 아니지만, 관리자에게 채금먹은 사람이 하필 남은 채금시간이 0.5초 미만일 때 채팅을 시도할 확률은 드물기 때문에 그냥 이렇게 간단히 처리해둠.,
        token,
      })
    }
  
    // 마지막 메시지 이후 무조건 0.2초는 밴
    store.actions.banIP(ip, store.getters.config().allowedChatFrequency)
    if (!(message.text || '').trim() || message.text.length > store.getters.config().messageMaxLength) {
      return helpers.alertUser({ text: '입력하신 메시지가 너무 깁니다. 만약 이미지를 업로드하신 경우라면 파일명을 짧게 해주세요.', token })
    }

    try {
      await challengeSoundnessOfMessage(message.text)
    } catch (e) {
      helpers.saveMessage({ message, ip, softDelete: true })
      if (e.code === 'ERR_GRAPHIC_IMAGE') {
        const user = store.getters.user(token)
        service.slack.postMessage({
          text: `
            부적절한 채팅 메시지 전송이 시도되었습니다.

            ${message.text}

            ${user.profile.nickname} / ${ip} / ${token}
          `,
          channel: 'coinsect-api',
        })
      }
      if (e.message) helpers.alertUser({ text: e.message, token })
      return
    }

    try {
      if (message.user.jwt) message.user.id = (await coreHelpers.jwt.decode(message.user.jwt))['id']
    } catch (e) {
      return helpers.sendMessage({ message: { type: 'sessionExpired' }, token })
    }

    try {
      const savedMessage = await helpers.saveMessage({ message, ip })
      if (savedMessage) message['id'] = savedMessage.id
    } catch (e) {
      log.error('failed to save message:', e)
    }

    if (message.type === 'text') message.text = service.badWord.filtered(message.text)

    helpers.broadcast(message)
  },
  users: () => {
    const o = {}
    const users = store.getters.connections().map(conn => conn.user)
    users.forEach(user => o[user.token] = user)
    const meta = Object.values(o)

    helpers.sendMessage({
      message: {
        type: 'users',
        meta,
      }, token,
    })
  },
  ping: () => {
    const user = store.getters.user(token)
    if (user && user.profile.sentiment && helpers.dayjs(user.profile.sentiment.expireAt).isBefore(helpers.dayjs())) {
      delete user.profile.sentiment
    }

    if (user && message.user) user.path = message.user.path

    store.actions.refreshUserState({ user, ip })
    helpers.sendMessage({
      message: {
        type: 'pong'
      },
      token,
    })
  },
})

export default messageHandlers
