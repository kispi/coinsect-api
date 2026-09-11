import { AiUsage, TypeAiTask } from '../entities/ai_usage'
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
}

export default aiUsage
