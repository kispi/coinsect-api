import useCache from './cache'
import { log } from './logger'

const cache = useCache()

// 창 단위 카운터. 창이 바뀌면 키가 바뀌어 자연히 0에서 다시 센다.
//
// 정확한 슬라이딩 윈도가 아니다. 창 경계에서 한도의 두 배까지 통과할 수 있지만,
// 이 엔드포인트가 막으려는 것은 정밀한 형평이 아니라 비용 폭주다.
//
// 캐시가 죽으면 통과시킨다. 속도 제한 때문에 검색이 통째로 죽는 것보다 낫다.
export const rateLimit = async (key: string, limit: number, windowSeconds: number): Promise<boolean> => {
  try {
    const window = Math.floor(Date.now() / 1000 / windowSeconds)
    const cacheKey = `ratelimit:${key}:${window}`

    const current = Number(await cache.get(cacheKey)) || 0
    if (current >= limit) return false

    await cache.set(cacheKey, current + 1, windowSeconds * 2)
    return true
  } catch (e) {
    log.error('rateLimit 실패. 통과시킨다.', e)
    return true
  }
}
