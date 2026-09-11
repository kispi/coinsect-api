import { Entity, Column, PrimaryColumn } from 'typeorm'

// 날짜·모델·태스크당 한 행. 영구 보관한다. 하루 몇 행이라 1년에 수천 행이다.
//
// 모델이 키에 들어가는 이유: 단가표가 틀렸던 것이 나중에 드러나도 모델별 토큰이
// 남아 있으면 다시 계산할 수 있다. 한 칸에 합치면 되돌릴 수 없는 숫자가 된다.
@Entity({ name: 'ai_usage_daily' })
export class AiUsageDaily {
  // UTC 'YYYY-MM-DD'. 서버 로케일에 흔들리면 안 되므로 UTC로 못 박는다.
  @PrimaryColumn({ length: 10 })
  day: string

  @PrimaryColumn({ length: 64 })
  model: string

  @PrimaryColumn({ length: 32 })
  task: string

  @Column({ default: 0 })
  requests: number

  // requests와 따로 두는 이유: requests는 성공·실패가 섞인 채 집계된다. 장애 중에도
  // 요청 수는 평소와 같이 보이므로, failures가 없으면 '조용히 실패만 치솟는 날'이
  // daily 집계에서는 평범한 하루로 읽힌다.
  @Column({ default: 0 })
  failures: number

  // 서비스 전체 합이라 integer의 상한($2,147)에 언젠가 닿는다.
  @Column({ type: 'bigint', default: 0 })
  tokensIn: number

  @Column({ type: 'bigint', default: 0 })
  tokensOut: number

  @Column({ type: 'bigint', default: 0 })
  tokensThinking: number

  @Column({ type: 'bigint', default: 0 })
  costMicros: number
}
