import { Entity, Column, OneToMany, ManyToOne, Index } from 'typeorm'
import { Board } from './board'
import { summarizedReactions, Reaction } from './reaction'
import { Reply } from './reply'
import { User } from './user'
import { dataSource } from '../database'
import IContext from '../core/interfaces/context'
import helpers from '../core/helpers'
import store from '../store'
import BaseModel from './base_model'

enum TypePostType {
  Normal = 'normal',
}

@Entity({ name: 'posts' })
export class Post extends BaseModel {
  @OneToMany(() => Reaction, reaction => reaction.post)
  reactions: Reaction[]

  @OneToMany(() => Reply, reply => reply.post)
  replies: Reply[]

  @ManyToOne(() => Board, board => board.posts, { onDelete: 'SET NULL' })
  board: Board

  @Column({ nullable: true })
  boardId: number

  @Column({ length: 255, nullable: true })
  title: string

  @Column({ type: 'text' })
  content: string

  @Column({ default: TypePostType.Normal })
  postType: TypePostType

  // 태그. 쉼표로 구분. ex) '비트코인,vue,react'
  @Column({ nullable: true })
  tags: string

  @Column({ default: 0 })
  views: number

  @ManyToOne(() => User, { onDelete: 'SET NULL', createForeignKeyConstraints: false })
  user: User

  @Column({ nullable: true })
  userId: number

  @Column()
  nickname: string

  @Column({ nullable: true })
  ip: string

  @Column({ nullable: true })
  lastEdit: Date

  @Column({ nullable: true })
  @Index()
  sharingKey: string

  @Column({ nullable: true })
  password: string

  async increaseViews(c: IContext) {
    const views = store.state.lastUserActions.viewPost[c.req.ip] || {}
    if (views[this.id]) return

    views[this.id] = helpers.dayjs().add(store.state.globalVariables.lastUserActionTimeouts.viewPost, 'milliseconds')
    store.state.lastUserActions.viewPost[c.req.ip] = views
    setTimeout(
      () => delete store.state.lastUserActions.viewPost[c.req.ip][this.id],
      store.state.globalVariables.lastUserActionTimeouts.viewPost,
    )

    this.views += 1
    try {
      // repository.update()도, 쿼리빌더의 update()도 @UpdateDateColumn을 자동으로
      // 건드린다. 조회는 글을 고치는 게 아니므로 updated_at이 움직이면 그 자체로
      // 뜻이 틀리고, RAG 인덱서가 "글이 실제로 바뀌었는가"를 오직 이 컬럼으로만
      // 판단한다(services/rag/indexer.ts의 sweep/훑기). 조회수만 raw SQL로 올려
      // updated_at을 그대로 둔다 - 안 그러면 조회수가 계속 오르는 인기 글은
      // 내용이 그대로인데도 훑기가 매 주기 다시 잡고, 청크 하나가 영구히 실패하는
      // 글은 failed로 접혔다가도 조회 한 번에 되살아나 영원히 재시도를 돈다.
      await dataSource.query('UPDATE posts SET views = $1 WHERE sharing_key = $2', [this.views, this.sharingKey])
    } catch (e) {}
    return this
  }

  static async validate(post: Post) {
    const requiredFields = ['title', 'content', 'nickname']
    if (!helpers.trimAndValidateRequiredFields(post, requiredFields)) {
      return Promise.reject()
    }

    if (post.title.length > store.state.globalVariables.maxlength.postTitle) {
      return Promise.reject({ message: 'TITLE_TOO_LONG' })
    }

    // 본문 길이는 그대로 임베딩 비용이다. 글을 쓰거나 고치면 인덱서가 청킹해서
    // 임베딩을 치므로, 상한이 없으면 익명 글 하나가 원하는 만큼 돈을 태울 수 있다.
    // 값의 근거는 store.ts의 maxlength.postContent 주석에 있다.
    //
    // sanitize 전 원문을 잰다. 태그가 섞여 부풀려진 입력도 여기서 먼저 걸러야
    // sanitize가 헛일을 하지 않는다.
    if (post.content.length > store.state.globalVariables.maxlength.postContent) {
      return Promise.reject({ message: 'CONTENT_TOO_LONG' })
    }

    if (post.nickname.length > store.state.globalVariables.maxlength.nickname) {
      return Promise.reject({ message: 'NICKNAME_TOO_LONG' })
    }
  }

  static async checkPassword(sharingKey: string, password: string) {
    if (!password) Promise.reject({ message: 'INCORRECT_PASSWORD' })

    try {
      const target = await dataSource.getRepository(Post).findOneOrFail({ where: { sharingKey }})
      if (!helpers.crypto.compare(target.password, password)) {
        return Promise.reject({ message: 'INCORRECT_PASSWORD' })
      }
      return Promise.resolve()
    } catch (e) {
      return Promise.reject({ message: 'NOT_FOUND' })
    }
  }

  static async save(post: Post) {
    delete post.views // Post.views는 저장하지 않는다.
    try {
      return await dataSource.getRepository(Post).save(post)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  mutatePostToBeSecure(ip: string) {
    this.user = User.sensitiveAuthInfoFilteredUser(this.user) as any
    if ((this.replies || []).length > 0) this.replies.forEach(reply => {
      reply['summary'] = { reactions: summarizedReactions(reply.reactions, ip) }
      delete reply.reactions
    })
    this['summary'] = {
      reactions: summarizedReactions(this.reactions, ip),
      numReplies: (this.replies || []).filter(reply => !reply.deletedAt).length
    }
    this.replies = helpers.organizeReplies(this.replies)
    delete this.reactions
    delete this.ip
  }

  toJSON() {
    delete this.password
    return this
  }
}