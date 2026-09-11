import useCache from './cache'
import { log } from './logger'

const cache = useCache()

// 창 단위 카운터. 창이 바뀌면 키가 바뀌어 자연히 0에서 다시 센다.
//
// 정확한 슬라이딩 윈도가 아니다. 창 경계에서 한도의 두 배까지 통과할 수 있지만,
// 이 엔드포인트가 막으려는 것은 정밀한 형평이 아니라 비용 폭주다.
//
// 증가는 원자적이어야 한다. get으로 읽고 set으로 쓰면 두 호출 사이의 await 동안
// 들어온 요청이 전부 같은 값을 읽어 전부 통과하고, 카운터는 1만 오른다. 동시에
// 100건이 들어오면 한도가 5여도 100건이 다 지나간다는 뜻이다.
//
// 이게 특히 중요한 이유는 IP 층이 이미 뚫려 있어서다. trustProxy: true라 c.req.ip는
// 클라이언트가 보낸 X-Forwarded-For를 그대로 받고, 헤더 한 줄이면 IP별 바구니가
// 매번 새로 생긴다(2026-09-10 프로덕션 확인, services/content/desktop_jobs.ts).
// 헤더로 못 피하는 전역 바구니만이 실질적인 방어선이고, 그 바구니가 느슨하면
// 남는 방어선이 없다.
//
// 캐시가 죽으면 통과시킨다. 속도 제한 때문에 검색이 통째로 죽는 것보다 낫다.
export const rateLimit = async (key: string, limit: number, windowSeconds: number): Promise<boolean> => {
  try {
    const window = Math.floor(Date.now() / 1000 / windowSeconds)
    const cacheKey = `ratelimit:${key}:${window}`

    // 만료를 창 길이의 두 배로 두는 이유: 창 키는 어차피 다음 창에서 바뀌므로
    // 한 창만 살아 있으면 되지만, 시계가 살짝 어긋나도 지워지지 않게 여유를 준다.
    const current = await cache.incr(cacheKey, windowSeconds * 2)
    return current <= limit
  } catch (e) {
    log.error('rateLimit 실패. 통과시킨다.', e)
    return true
  }
}
