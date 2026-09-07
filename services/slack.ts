import axios from 'axios'
import store from '../store'
import helpers from '../core/helpers'
import { log } from '../core/logger'

const endpoint = {
  'coinsect-api': store.state.serverConfig.SLACK_COINSECT_API,
  'image_moderation': store.state.serverConfig.SLACK_IMAGE_MODERATION,
}

const postMessage = async ({
  text,
  channel,
}: {
  text: string,
  channel: 'coinsect-api' | 'image_moderation',
}) => {
  if (!endpoint[channel]) {
    log.error('slack.postMessage: .env SLACK is missing')
    return
  }

  try {
    await axios.post(endpoint[channel], { text: helpers.allNewlineTrimmed(text) })
  } catch (e) {
    return Promise.reject(e)
  }
}

export default {
  postMessage,
}