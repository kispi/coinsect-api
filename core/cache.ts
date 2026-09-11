import { createClient } from 'redis'
import { log } from './logger'
import ICacheClient from './interfaces/cache_client'
import store from '../store'

const localState = {}

// 해시 계열은 로컬에서도 같은 계약을 지켜야 한다. 테스트와 개발이 레디스 없이 도는데
// 여기서 동작이 갈리면 그 차이는 배포한 뒤에야 드러난다.
const localHash = (key: string): { [field: string]: unknown } => {
  if (!localState[key]) localState[key] = {}
  return localState[key]
}

const localCacheClient: ICacheClient = {
  set: (key: string, value: unknown, seconds?: number) => {
    localState[key] = value
    // unref: 이 타이머는 만료 청소일 뿐이고 USE_REDIS가 꺼졌을 때(로컬/테스트)만 돈다.
    // 실제 서버는 Fastify 소켓이 이벤트 루프를 붙잡고 있으니 상관없지만, unref가
    // 없으면 이 타이머 하나 때문에 `node --test`가 만료 시각까지 종료를 미룬다.
    if (seconds) setTimeout(() => localCacheClient.del(key), seconds * 1000).unref()
  },
  get: (key: string) => localState[key],
  del: (key: string) => delete localState[key],
  hGetAll: async (key: string) => ({ ...localHash(key) }),
  hSet: async (key: string, field: string, value: unknown) => { localHash(key)[field] = value },
  hSetNX: async (key: string, field: string, value: unknown) => {
    if (field in localHash(key)) return false

    localHash(key)[field] = value
    return true
  },
  hDel: async (key: string, field: string) => { delete localHash(key)[field] },
}

let usedClient

const useCache = (): ICacheClient => {
  if (store.state.serverConfig.USE_REDIS !== 'yes') return localCacheClient

  const client = usedClient || createClient({ url: `redis://localhost:6379` })

  if (!usedClient) {
    client.on('error', err => log.error('Redis Client Error', err))

    client.connect()

    usedClient = client
  }

  return {
    get: async (key: string) => {
      const raw = await client.get(key)
      return JSON.parse(raw)
    },
    set: (key: string, value: unknown, seconds?: number) => {
      if (seconds) return client.setEx(key, seconds, JSON.stringify(value))

      return client.set(key, JSON.stringify(value))
    },
    del: (key: string) => client.del(key),
    // 값은 get/set과 같은 방식으로 JSON을 거친다. 레디스 해시의 값은 문자열뿐이다.
    hGetAll: async (key: string) => {
      const raw = await client.hGetAll(key)
      return Object.fromEntries(Object.entries(raw || {}).map(([field, value]) => [field, JSON.parse(value as string)]))
    },
    hSet: (key: string, field: string, value: unknown) => client.hSet(key, field, JSON.stringify(value)),
    hSetNX: (key: string, field: string, value: unknown) => client.hSetNX(key, field, JSON.stringify(value)),
    hDel: (key: string, field: string) => client.hDel(key, field),
  }
}

export default useCache