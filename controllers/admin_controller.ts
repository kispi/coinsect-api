import { BadWord } from '../entities/bad_word'
import { BannedUser } from '../entities/banned_user'
import { Blockchain } from '../entities/blockchain'
import { Board } from '../entities/board'
import { Image } from '../entities/image'
import { Message } from '../entities/message'
import { Notification } from '../entities/notification'
import { Person } from '../entities/person'
import { Post } from '../entities/post'
import { Profile } from '../entities/profile'
import { Reaction } from '../entities/reaction'
import { Reply } from '../entities/reply'
import { User } from '../entities/user'
import { Wallet } from '../entities/wallet'
import { WhaleAlert } from '../entities/whale_alert'
import { useCRUD } from '../core/controller'
import IContext from '../core/interfaces/context'
import { dataSource } from '../database'
import useService from '../services'
import store from '../store'
import orm, { joinIfAbsent } from '../core/orm'
import cron from '../core/cron'
import helpers from '../core/helpers'
import chatService from '../services/chat'
import aiUsageService from '../services/ai_usage'
import ragIndexer from '../services/rag/indexer'

const service = useService()

const routesChat = {
  banIP: async (c: IContext) => {
    if (!c.req.body['ip'] || !c.req.body['timeout']) {
      c.res.failed({ message: 'missing params: ip, timeout' })
      return
    }

    const until = await service.chat.banIP(c.req.body['ip'], c.req.body['timeout'])
    c.res.asJSON({ data: until })
  },
  createBannedUser: async (c: IContext) => {
    if (!c.req.body['ip'] || !c.req.body['timeout']) {
      c.res.failed({ message: 'missing params: ip, timeout' })
      return
    }

    const date = helpers.dayjs().add(c.req.body['timeout'], 'milliseconds')
    try {
      await c.orm.createQueryBuilder()
        .insert().into(BannedUser).values([{
          ip: c.req.body['ip'],
          token: c.req.body['token'],
          reason: '운영 정책 위반',
          until: date.format(),
        }]).execute()

      if (c.req.body['deleteMessages'] === 'ok') {
        await c.orm.createQueryBuilder()
          .where('ip = :ip', { ip: c.req.body['ip'] })
          .softDelete().from(Message).execute()
      }
      chatService.invalidate()
      c.res.success()
    } catch (e) {
      c.res.failed(e)
    }
  },
  sendMessage: (c: IContext) => {
    service.chat.sendMessage({
      message: {
        type: 'admin',
        text: c.req.body['text'],
      },
      token: c.req.body['token'],
      ip: c.req.body['ip'],
    })
  },
}

const routesStore = {
  badWord: {
    all: (c: IContext) => c.res.asJSON(store.state.badWords),
    invalidate: (c: IContext) => store.actions.loadBadWords().then(c.res.asJSON)
  },
  bannedUser: {
    all: (c: IContext) => c.res.asJSON(store.state.bannedUsers),
    invalidate: (c: IContext) => store.actions.loadBannedUsers().then(c.res.asJSON)
  },
  message: {
    invalidate: async (c: IContext) => {
      try {
        await service.chat.invalidate()
        c.res.success()
      } catch (e) {
        c.res.failed(e)
      }
    }
  },
}

const routesPost = useCRUD({ model: Post, useSoftDelete: true, withDeleted: true })
routesPost.detail = async (c: IContext) => {
  try {
    const data = await orm.querySetter(c, Post)
      .withDeleted()
      .leftJoinAndSelect('Post.board', 'board')
      .leftJoinAndSelect('Post.replies', 'replies')
      .leftJoinAndSelect('replies.parent', 'parent')
      .where('Post.id = :id', { id: c.req.params['id'] }).getOneOrFail()
      c.res.asJSON(data)
  } catch (e) {
    c.res.failed(e)
  }
}
routesPost.update = async (c: IContext) => {
  try {
    await Post.save(c.req.body as Post)
    c.res.success()
  } catch (e) {
    c.res.failed(e)
  }
}
// 어드민 삭제도 청크를 걷어야 한다. 제네릭 useCRUD는 글을 모르므로 여기서 덮는다.
const genericDelete = routesPost.delete
routesPost.delete = async (c: IContext) => {
  const id = Number(c.req.params['id'])
  await genericDelete(c)
  if (!id) return

  // genericDelete(useCRUD의 delete)는 실패해도 오류를 안에서 삼키고 c.res.failed만
  // 부를 뿐 되던지지 않는다. 그래서 여기까지 항상 정상적으로 도착하고, 그걸
  // "지워졌다"는 신호로 쓸 수 없다. 삭제가 실제로 반영됐는지 deletedAt으로 다시
  // 확인한 뒤에만 청크를 걷는다 - 안 그러면 삭제가 실패해도 살아 있는 글의 청크가
  // 사라져, 다음 훑기(최대 5분)까지 그 글이 검색에서 조용히 빠진다.
  const target = await dataSource.getRepository(Post).findOne({ where: { id }, withDeleted: true })
  if (target?.deletedAt) void ragIndexer.removeChunks(id)
}

const routesUser = useCRUD({ model: User, useSoftDelete: true, withDeleted: true })
routesUser.all = async (c: IContext) => {
  try {
    // ?join=User.profile을 보내야 where/sort가 profile.nickname을 쓸 수 있고, 그때 이
    // 체이닝과 별칭이 겹친다. joinIfAbsent가 그 중복을 막는다.
    const qb = joinIfAbsent(orm.querySetter(c, User), 'User.profile', 'profile')
    const [data, total] = await qb.withDeleted().getManyAndCount()
    c.res.asJSON({ data, total })
  } catch (e) {
    c.res.failed(e)
  }
}

const adminController = {
  cron: {
    all: (c: IContext) => c.res.success(cron.stats()),
  },
  aiUsage: {
    all: async (c: IContext) => {
      try {
        c.res.asJSON(await aiUsageService.daily(c.req.query['from'], c.req.query['to']))
      } catch (e) {
        c.res.failed(e)
      }
    },
  },
  chat: routesChat,
  store: routesStore,
  badWord: useCRUD({ model: BadWord }),
  bannedUser: useCRUD({ model: BannedUser }),
  blockchain: useCRUD({ model: Blockchain }),
  board: useCRUD({ model: Board, useSoftDelete: true }),
  image: useCRUD({ model: Image }),
  message: useCRUD({ model: Message, useSoftDelete: true, withDeleted: true }),
  notification: useCRUD({ model: Notification }),
  person: useCRUD({ model: Person, useSoftDelete: true }),
  post: routesPost,
  profile: useCRUD({ model: Profile }),
  reaction: useCRUD({ model: Reaction }),
  reply: useCRUD({ model: Reply, useSoftDelete: true }),
  user: routesUser,
  wallet: useCRUD({ model: Wallet }),
  whaleAlert: useCRUD({ model: WhaleAlert }),
  forceRefresh: async (c: IContext) => {
    const ip = c.req.body['ip']
    if (ip) {
      chatService.sendMessage({ message: { type: 'forceRefresh' }, ip })
      return
    }

    chatService.broadcast({ type: 'forceRefresh' })
  },
}

export default adminController