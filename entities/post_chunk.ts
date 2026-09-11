import { Entity, Column, Index } from 'typeorm'
import BaseModel from './base_model'

// 글 하나가 청크 여럿이 된다.
//
// embedding 칸은 여기 없다. TypeORM이 pgvector의 vector 타입을 모르기 때문이다.
// 벡터의 읽기와 쓰기는 services/rag의 raw SQL이 담당하고, 이 엔티티는 잡 관리와
// 청크 정리처럼 벡터를 건드리지 않는 일에 쓴다.
@Entity({ name: 'post_chunks' })
@Index(['postId', 'chunkIndex'], { unique: true })
export class PostChunk extends BaseModel {
  @Column()
  postId: number

  // posts 조인 없이 보드로 거르기 위해 중복해 둔다. 글이 보드를 옮기는 일은
  // 없다시피 하고, 있다면 재인덱싱이 같이 고친다.
  @Column()
  @Index()
  boardId: number

  @Column({ default: 0 })
  chunkIndex: number

  @Column({ type: 'text' })
  content: string

  @Column({ length: 64 })
  contentHash: string

  @Column({ length: 64 })
  model: string
}
