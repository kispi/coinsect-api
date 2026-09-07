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

const whaleAlertService = {
  transactions: async (c: IContext, overrides?: QueryOverrides) => {
    const query = overrides || c.req.query

    if (query['limit'] > 20) return Promise.reject({ message: 'limit exceeded 20', status: 400 })

    const qb = orm.querySetter(c, WhaleAlert, overrides).orderBy('timestamp', 'DESC')
    if (!query['limit']) qb.limit(20)
    if (query['excludeBetweenSameExchange'] === 'true') applyExcludeBetweenSameExchange(qb)

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