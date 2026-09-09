import { initializeApp, cert } from 'firebase-admin/app'
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging'
import { log } from '../../core/logger'
import store from '../../store'

// 자격증명은 서버 .env의 FIREBASE_SERVICE_ACCOUNT(서비스 계정 JSON)에서 읽는다.
//
// 예전에는 services/firebase/fcm_cert.ts 파일만 봤다. 그 파일은 개인키가 들어 있어
// .gitignore에 있는데, 빌드가 서버에서 GitHub 러너로 옮겨간 뒤로 러너 체크아웃에는
// 존재하지 않게 됐다. tsc가 dist/services/firebase/fcm_cert.js를 만들지 못했고
// 런타임 require가 실패했으며, 그 실패를 warn으로 삼켜 initializeApp이 통째로
// 건너뛰어졌다. 결과는 푸시를 보낼 때마다 "The default Firebase app does not exist"
// 라는, 원인과 한참 떨어진 에러가 어드민 토스트까지 올라오는 것이었다.
//
// env로 옮기면 산출물에 개인키가 구워지지 않고, 파일이 빌드 경로를 타지 않으므로
// 같은 종류의 누락이 다시 생기지 않는다. 파일 폴백은 이미 fcm_cert.ts를 두고 쓰던
// 개발 환경을 깨지 않으려고 남긴다.
export const MISSING_CREDENTIAL = 'FCM 자격증명이 없다. 서버 .env의 FIREBASE_SERVICE_ACCOUNT를 채우거나 services/firebase/fcm_cert.ts를 두라.'

export const parseServiceAccount = (raw: string) => {
  const trimmed = (raw || '').trim()

  // .env 한 줄에 JSON을 그대로 넣어도 되고, 따옴표가 부담스러우면 base64로 넣어도 된다.
  // JSON 쪽 private_key의 \n은 JSON.parse가 실제 개행으로 되살린다.
  const json = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8')

  const parsed = JSON.parse(json)

  // 셋 중 하나라도 없으면 cert()가 통과시키더라도 첫 전송에서야 터진다. 여기서 막는다.
  const missing = ['project_id', 'private_key', 'client_email'].filter(key => !parsed[key])
  if (missing.length > 0) throw new Error(`서비스 계정에 ${missing.join(', ')}가 없다`)

  return parsed
}

type Resolution = { serviceAccount?: any, error?: string }

export const resolveServiceAccount = (raw: string, readCertFile: () => any): Resolution => {
  if ((raw || '').trim()) {
    try {
      return { serviceAccount: parseServiceAccount(raw) }
    } catch (e) {
      // env에 값이 있는데 못 읽으면 파일로 조용히 넘어가지 않는다. 넘어가면 운영이
      // 어느 자격증명으로 도는지 알 수 없어진다.
      return { error: `FIREBASE_SERVICE_ACCOUNT를 읽지 못했다: ${e.message}` }
    }
  }

  const fromFile = readCertFile()
  if (fromFile) return { serviceAccount: fromFile }

  return { error: MISSING_CREDENTIAL }
}

const readCertFile = () => {
  try {
    return require('./fcm_cert').default
  } catch (e) {
    return null
  }
}

let initError: string = null

const init = () => {
  // store.state.serverConfig는 .env가 있으면 그 파일의 내용'만' 담는다(dotenv.config().parsed).
  // pm2나 셸이 직접 넣어준 값은 거기 없으므로 process.env도 같이 본다.
  const raw = store.state.serverConfig['FIREBASE_SERVICE_ACCOUNT'] || process.env.FIREBASE_SERVICE_ACCOUNT

  const { serviceAccount, error } = resolveServiceAccount(raw, readCertFile)

  if (error) {
    initError = error
    log.error(`firebase.messaging: ${error} 푸시 전송이 전부 실패한다.`)
    return
  }

  try {
    initializeApp({ credential: cert(serviceAccount) })
  } catch (e) {
    initError = `firebase 초기화에 실패했다: ${e.message}`
    log.error(`firebase.messaging: ${initError}`)
  }
}

init()

const messaging = {
  send: (message: MulticastMessage) => {
    if (initError) return Promise.reject(new Error(initError))
    return getMessaging().sendEachForMulticast(message)
  },
}

export default messaging
