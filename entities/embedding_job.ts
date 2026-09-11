import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

export type TypeJobStatus = 'pending' | 'running' | 'done' | 'failed'

// 글 하나에 행 하나. 처리한 뒤에도 지우지 않는다 - 이 행이 "언제 무엇으로
// 인덱싱했는가"의 유일한 기록이고, 훑기가 그것을 근거로 다시 집을지 정한다.
@Entity({ name: 'embedding_jobs' })
@Index(['status', 'createdAt'])
export class EmbeddingJob extends BaseModel {
  @Column({ unique: true })
  postId: number

  @Column({ length: 64, nullable: true })
  contentHash: string

  @Column({ type: 'timestamptz', nullable: true })
  indexedAt: Date

  @Column({ length: 20, default: 'pending' })
  status: TypeJobStatus

  @Column({ default: 0 })
  attempts: number

  @Column({ type: 'text', nullable: true })
  lastError: string

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date

  @Column({ length: 100, nullable: true })
  lockedBy: string
}
