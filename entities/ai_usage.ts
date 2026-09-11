import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

// AI 호출 한 건이 한 행이다. 90일 뒤에 지운다 - 되짚을 일이 없는 데이터를
// 영원히 들고 있을 이유가 없고, 그 이전 기간은 ai_usage_daily가 답한다.
export type TypeAiTask = 'position_read' | 'post_answer' | 'embed_index' | 'embed_query'

@Entity({ name: 'ai_usage' })
@Index(['task', 'createdAt'])
export class AiUsage extends BaseModel {
  @Column({ length: 32 })
  task: TypeAiTask

  @Column({ length: 64 })
  model: string

  @Column({ default: 0 })
  inputTokens: number

  @Column({ default: 0 })
  outputTokens: number

  @Column({ default: 0 })
  thinkingTokens: number

  // USD의 100만분의 1, 정수. 부동소수를 누적하면 오차가 쌓이고, 원화로 적으면
  // 환율이 움직인 뒤 과거 기록이 조용히 틀린 값이 된다.
  @Column({ default: 0 })
  costMicros: number

  @Column({ default: 0 })
  latencyMs: number

  // 토큰이 0인 실패 호출도 행을 남긴다. 어느 날 실패가 치솟는 것이 이상 징후인데,
  // 행이 없으면 그게 보이지 않는다.
  @Column({ default: true })
  ok: boolean

  @Column({ type: 'text', nullable: true })
  error: string

  @Column({ length: 32, nullable: true })
  refType: string

  @Column({ length: 64, nullable: true })
  refId: string

  @Column({ length: 64, nullable: true })
  requester: string
}
