import axios from 'axios'
import store from '../store'
import helpers from '../core/helpers'
import { log } from '../core/logger'

const endpoint = {
  'coinsect-api': store.state.serverConfig.SLACK_COINSECT_API,
  'image-moderation': store.state.serverConfig.SLACK_IMAGE_MODERATION,
}

const postMessage = async ({
  text,
  blocks,
  channel,
}: {
  text: string,
  // 버튼이 달린 메시지는 blocks로 보낸다. 이때 text는 알림 미리보기로만 쓰인다.
  blocks?: unknown[],
  channel: 'coinsect-api' | 'image-moderation',
}) => {
  if (!endpoint[channel]) {
    log.error('slack.postMessage: .env SLACK is missing')
    return
  }

  try {
    // blocks 안의 문단은 이미 정돈된 상태로 오므로 여기서 다시 손대지 않는다.
    await axios.post(endpoint[channel], blocks
      ? { text, blocks }
      : { text: helpers.allNewlineTrimmed(text) })
  } catch (e) {
    return Promise.reject(e)
  }
}

export default {
  postMessage,
}