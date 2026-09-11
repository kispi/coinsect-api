import { AiUsage, TypeAiTask } from '../entities/ai_usage'
import { AiUsageDaily } from '../entities/ai_usage_daily'
import { costOf } from './content/model_usage'
import { dataSource } from '../database'
import { log } from '../core/logger'

export type IRecordInput = {
  task: TypeAiTask,
  model: string,
  // 생성 호출은 SDK가 이걸 준다. 임베딩 호출은 주지 않으므로 아래 토큰을 직접 넘긴다.
  usageMetadata?: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number },
  inputTokens?: number,
  outputTokens?: number,
  thinkingTokens?: number,
  latencyMs?: number,
  ok?: boolean,
  error?: string,
  ref?: { type: string, id: string | number },
  requester?: string,
}

// USD를 micros로. 소수를 그대로 쌓으면 오차가 누적되므로 적는 순간 정수로 만든다.
const toMicros = (usd: number) => Math.round(usd * 1e6)

const aiUsage = {
  // DB를 타는 유일한 지점. 테스트가 이걸 갈아끼운다.
  insert: async (row: Partial<AiUsage>) => {
    await dataSource.getRepository(AiUsage).insert(row)
  },
  // 절대 던지지 않고, 부르는 쪽은 기다리지 않아도 된다.
  // 계측이 본래 동작을 막거나 늦추면 안 된다.
  record: async (o: IRecordInput) => {
    try {
      const m = o.usageMetadata || {}
      const inputTokens = o.inputTokens ?? m.promptTokenCount ?? 0
      const outputTokens = o.outputTokens ?? m.candidatesTokenCount ?? 0
      const thinkingTokens = o.thinkingTokens ?? m.thoughtsTokenCount ?? 0

      await aiUsage.insert({
        task: o.task,
        model: o.model,
        inputTokens,
        outputTokens,
        thinkingTokens,
        costMicros: toMicros(costOf(o.model, inputTokens, outputTokens, thinkingTokens)),
        latencyMs: o.latencyMs || 0,
        ok: o.ok !== false,
        error: o.error || null,
        refType: (o.ref || {} as never).type || null,
        refId: o.ref ? String(o.ref.id) : null,
        requester: o.requester || null,
      })
    } catch (e) {
      log.error('aiUsage.record 실패', e)
    }
  },

  // UTC 'YYYY-MM-DD'. 서버 로케일에 흔들리면 집계 경계가 날마다 달라진다.
  utcDay: (offsetDays = 0) => {
    const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    return d.toISOString().slice(0, 10)
  },

  // 하루치 원본을 (모델, 태스크)로 접는다. DB를 타는 지점.
  aggregate: async (day: string) => {
    const rows = await dataSource.getRepository(AiUsage)
      .createQueryBuilder('u')
      .select('u.model', 'model')
      .addSelect('u.task', 'task')
      .addSelect('count(*)', 'requests')
      .addSelect('sum(u.input_tokens)', 'tokensIn')
      .addSelect('sum(u.output_tokens)', 'tokensOut')
      .addSelect('sum(u.thinking_tokens)', 'tokensThinking')
      .addSelect('sum(u.cost_micros)', 'costMicros')
      // 실패도 requests에는 섞여 있다. 장애가 나도 요청 수는 그대로라, 실패만 따로
      // 세지 않으면 '평소와 같은 트래픽인데 비용만 평평하다'가 장애의 흔적을 지운다.
      .addSelect('sum(case when u.ok then 0 else 1 end)', 'failures')
      .where(`u.created_at >= :day::date AND u.created_at < (:day::date + interval '1 day')`, { day })
      // createQueryBuilder는 리포지터리 find와 달리 소프트 삭제를 자동으로 거르지 않는다.
      // 지금은 AiUsage를 소프트 삭제하는 경로가 없지만, 생기는 순간 지운 행이 집계에
      // 섞여 들어가면 안 되므로 미리 막아 둔다.
      .andWhere('u.deleted_at IS NULL')
      .groupBy('u.model')
      .addGroupBy('u.task')
      .getRawMany()

    // pg 드라이버는 bigint와 count(*)를 문자열로 돌려준다. 숫자로 못 박아 둔다.
    return rows.map(r => ({
      day,
      model: r.model,
      task: r.task,
      requests: Number(r.requests),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      tokensThinking: Number(r.tokensThinking),
      costMicros: Number(r.costMicros),
      failures: Number(r.failures),
    }))
  },

  // 덮어쓴다. 더하지 않는다 - 같은 날을 두 번 집계해도 값이 두 배가 되면 안 된다.
  upsertDaily: async (rows: Partial<AiUsageDaily>[]) => {
    if (!rows.length) return
    await dataSource.getRepository(AiUsageDaily)
      .upsert(rows, { conflictPaths: ['day', 'model', 'task'], skipUpdateIfNoValuesChanged: false })
  },

  rollup: async (day?: string) => {
    const target = day || aiUsage.utcDay(-1)
    try {
      const rows = await aiUsage.aggregate(target)
      await aiUsage.upsertDaily(rows)
      log.info(`aiUsage.rollup: ${target} — ${rows.length}행`)
      return rows.length
    } catch (e) {
      log.error('aiUsage.rollup 실패', e)
      return 0
    }
  },

  // 90일 지난 원본을 지운다. 그 이전 기간은 daily가 답한다.
  prune: async (days = 90) => {
    try {
      const result = await dataSource.getRepository(AiUsage)
        .createQueryBuilder()
        .delete()
        .where(`created_at < now() - (:days || ' days')::interval`, { days })
        .execute()
      return result.affected || 0
    } catch (e) {
      log.error('aiUsage.prune 실패', e)
      return 0
    }
  },

  // 기간의 daily 행. 기본은 최근 30일이다.
  daily: async (from?: string, to?: string) => {
    const start = from || aiUsage.utcDay(-30)
    const end = to || aiUsage.utcDay()

    const rows = await dataSource.getRepository(AiUsageDaily)
      .createQueryBuilder('d')
      .where('d.day >= :start AND d.day <= :end', { start, end })
      .orderBy('d.day', 'DESC')
      .addOrderBy('d.cost_micros', 'DESC')
      .getMany()

    // aggregate()와 같은 이유. bigint 칼럼(tokensIn/Out/Thinking, costMicros)은
    // getMany로도 문자열로 오는데 requests(integer)는 숫자로 온다. 한 행에 타입이
    // 섞인 채로 내보내면, 이 행들을 다시 합산하는 소비자가 문자열 이어붙이기를 하게 된다.
    const data = rows.map(o => ({
      ...o,
      tokensIn: Number(o.tokensIn),
      tokensOut: Number(o.tokensOut),
      tokensThinking: Number(o.tokensThinking),
      costMicros: Number(o.costMicros),
    }))

    return {
      data,
      total: data.length,
      totalCostMicros: data.reduce((sum, o) => sum + Number(o.costMicros), 0),
    }
  },
}

export default aiUsage
