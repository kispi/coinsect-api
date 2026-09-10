import { SelectQueryBuilder } from 'typeorm'
import { log } from '../../core/logger'
import { WhaleAlert } from '../../entities/whale_alert'
import { dataSource } from '../../database'
import axios from 'axios'
import store from '../../store'
import orm, { QueryOverrides } from '../../core/orm'
import IContext from '../../core/interfaces/context'

const apiKey = store.state.serverConfig.WHALE_ALERT

// https://docs.whale-alert.io/
// Rate Limit for Free Plan: 10 per minute.

// coinsect-nuxt의 excludeBetweenSameExchange 필터. 한쪽만 알려진 주체인 거래를 남긴다.
// 구 프론트는 MySQL 전용 XOR을 직접 보냈는데, PostgreSQL에는 XOR이 없고 화이트리스트
// DSL로 표현할 수도 없어서 서버가 이름으로 받는다.
export const applyExcludeBetweenSameExchange = (qb: SelectQueryBuilder<any>) => {
  qb.andWhere(
    `((WhaleAlert.from_owner_type <> :unknown) <> (WhaleAlert.to_owner_type <> :unknown))`,
    { unknown: 'unknown' },
  )
}

// 구 프론트가 보내는 where를 알아본다.
//
// 새로고침으로 갈아치울 수 없는 클라이언트가 남아 있다. 탭을 아주 오래 열어둔 브라우저인데
// 채팅 웹소켓이 끊긴 뒤 재연결을 못 해서, 어드민의 '전체 새로고침'이 닿지 않는다
// (2026-09-10 확인: nginx 로그 1,935건 전체에 웹소켓 업그레이드도 에셋 요청도 0건이고
// 두 API만 정확히 10초 간격으로 두드린다). 그 상태로 400을 돌려주면 그쪽 화면은 깨진 채로
// 남고, 재시도하며 URL을 계속 다시 인코딩해 %2520 같은 것이 쌓인다.
//
// 그런데 저 where가 요구하는 것은 지금 서버가 excludeBetweenSameExchange로 이미 하는
// 바로 그 동작이다. 뜻이 같으니 이름만 바꿔 받아준다. 그러면 그쪽 화면도 정상으로 돌아오고
// 400도 재시도 루프도 같이 사라진다.
//
// 넓게 열지 않는다. '파싱 실패하면 필터를 무시'로 두면 진짜 클라이언트 버그까지 조용히
// 삼킨다. 이 한 가지 형태만 알아본다.
const LEGACY_EXCLUDE_SAME_EXCHANGE = /from_owner_type\s*!=\s*"?unknown"?\s+XOR\s+to_owner_type\s*!=\s*"?unknown"?/i

export const usesLegacyExcludeFilter = (where: unknown): boolean => {
  if (typeof where !== 'string') return false

  // 재시도하며 이중, 삼중으로 인코딩된 것들이 온다. 더 이상 안 바뀔 때까지 푼다.
  let decoded = where
  for (let i = 0; i < 3; i++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch (e) {
      break // 인코딩이 깨진 문자열. 여기까지 푼 것으로 판단한다.
    }
    if (next === decoded) break
    decoded = next
  }

  return LEGACY_EXCLUDE_SAME_EXCHANGE.test(decoded)
}

const whaleAlertService = {
  transactions: async (c: IContext, overrides?: QueryOverrides) => {
    const query = overrides || c.req.query

    if (query['limit'] > 20) return Promise.reject({ message: 'limit exceeded 20', status: 400 })

    // 구 where는 파서에 넘기기 전에 걷어낸다. 넘기면 화이트리스트 DSL이 아니라 400이 된다.
    const legacyExclude = usesLegacyExcludeFilter(query['where'])
    if (legacyExclude) delete query['where']

    const qb = orm.querySetter(c, WhaleAlert, overrides).orderBy('timestamp', 'DESC')
    if (!query['limit']) qb.limit(20)
    if (legacyExclude || query['excludeBetweenSameExchange'] === 'true') applyExcludeBetweenSameExchange(qb)

    const [data, total] = await qb.getManyAndCount()
    return {
      data,
      total,
    }
  },
  crawl: async (minValue: number = 500000) => {
    if (!apiKey) {
      log.error('whaleAlert.crawl: .env WHALE_ALERT is missing')
      return
    }

    try {
      const data = await axios.get(`https://api.whale-alert.io/v1/transactions?api_key=${apiKey}&min_value=${minValue}`) as any
      const whaleAlerts = (data.transactions || []).filter(t => t.transaction_count === 1).map(t => ({
        hash: t.hash,
        amount: t.amount,
        amountUsd: t.amount_usd,
        fromAddress: t.from.address,
        fromOwner: t.from.owner,
        fromOwnerType: t.from.owner_type,
        toAddress: t.to.address,
        toOwner: t.to.owner,
        toOwnerType: t.to.owner_type,
        blockchain: t.blockchain,
        symbol: t.symbol,
        transactionCount: t.transaction_count,
        transactionType: t.transaction_type,
        timestamp: t.timestamp,
      }))
      dataSource.createQueryBuilder().insert().orIgnore().into(WhaleAlert).values(whaleAlerts).execute()
    } catch (e) {
      return Promise.reject(e)
    }
  },
}

export default whaleAlertService