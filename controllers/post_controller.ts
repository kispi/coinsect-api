import { Post } from '../entities/post'
import { dataSource } from '../database'
import IContext from '../core/interfaces/context'
import orm from '../core/orm'
import helpers from '../core/helpers'
import postService from '../services/post'
import ragIndexer from '../services/rag/indexer'
import { log } from '../core/logger'
import { rateLimit } from '../core/rate_limit'

// 자유게시판 id
const freeBoardId = 1

const postController = {
  create: async (c: IContext) => {
    if (!c.req.ip) {
      c.res.failed()
      return
    }

    const bannedUser = helpers.useBannedUser({ ip: c.req.ip })
    if (bannedUser) return c.res.failed({ message: 'BANNED_USER', extra: { bannedUser } })

    const payload = c.req.body
    // if (!payload['board']) payload['board'] = { id : freeBoardId }
    payload['board'] = { id: freeBoardId }

    try {
      await Post.validate(payload as Post)
    } catch (e) {
      return c.res.failed(e)
    }

    payload['ip'] = c.req.ip
    payload['title'] = payload['title']
    payload['content'] = helpers.sanitize.html(payload['content'])

    const user = await helpers.jwt.mustUser(c)
    if (user) {
      payload['user'] = user
      delete payload['password']
    } else {
      if (!payload['password']) return c.res.failed({ message: 'password is required' })
      payload['password'] = helpers.crypto.hashed(payload['password'])
    }

    try {
      payload['sharingKey'] = helpers.crypto.generateUUID(true)
      const inserted = await orm.querySetter(c, Post).insert().into(Post).values(payload).execute()
      c.res.success()

      // 등록하고 그 자리에서 배수를 깨운다. 기다리지 않는다 - 글쓰기가 임베딩을
      // 기다릴 이유가 없고, 실패해도 훑기가 5분 안에 잡는다.
      //
      // drain()은 enqueue와 달리 자기 오류를 삼키지 않는다(락 획득이나 잡 조회가
      // 죽으면 그대로 던진다). void로 던져둔 프라미스가 거부되면 unhandled
      // rejection이 되어 Node가 프로세스를 내리므로, 글 하나 쓰는 요청이 서버
      // 전체를 죽이는 일이 없도록 여기서 반드시 받아 삼킨다. 응답은 이미 나갔다.
      const postId = ((inserted.identifiers || [])[0] || {}).id
      if (postId) {
        void ragIndexer.enqueue(postId)
          .then(() => ragIndexer.drain())
          .catch(e => log.error('인덱싱 배수 실패', e))
      }
    } catch (e) {
      c.res.failed(e)
    }
  },
  update: async (c: IContext) => {
    if (!c.req.ip) {
      c.res.failed()
      return
    }

    const payload = c.req.body

    try {
      await Post.validate(payload as Post)
    } catch (e) {
      return c.res.failed(e)
    }

    const user = await helpers.jwt.mustUser(c)
    let target: Post
    try {
      const postRepository = dataSource.getRepository(Post)
      target = await postRepository.findOneOrFail({ where: { sharingKey: c.req.params['sharingKey'] } })
      if (target.userId) {
        // 자기 자신의 글을 수정하기 때문에 비밀번호가 필요 없는 경우
        if (user['id'] !== target.userId) return c.res.failed()
      } else {
        // 익명 글을 수정하기 때문에 비밀번호가 필요한 경우
        await Post.checkPassword(c.req.params['sharingKey'], payload['$$originalPassword'])
      }
    } catch (e) {
      return c.res.failed(e)
    }

    if (!target) return c.res.failed({ message: 'NOT_FOUND' }, 404)

    target.ip = c.req.ip
    target.board = payload['board']
    target.nickname = helpers.sanitize.strict(payload['nickname'])
    target.title = payload['title']
    target.content = helpers.sanitize.html(payload['content'])

    if (user) {
      target.userId = user['id']
      delete payload['password']
    } else {
      target.password = helpers.crypto.hashed(payload['password'])
    }

    try {
      target.lastEdit = new Date()
      await Post.save(target)
      c.res.success()
      // create와 같은 이유로 drain()의 거부를 여기서 받아 삼킨다.
      void ragIndexer.enqueue(target.id)
        .then(() => ragIndexer.drain())
        .catch(e => log.error('인덱싱 배수 실패', e))
    } catch (e) {
      c.res.failed(e)
    }
  },
  sitemap: async (c: IContext) => {
    try {
      const data = await postService.sitemap(c)
      c.res.asJSON(data)
    } catch (e) {
      c.res.failed(e)
    }
  },
  allWithLLM: async (c: IContext) => {
    try {
      const { data, total, answer } = await postService.allWithLLM(c)
      c.res.asJSON({ data, total, answer })
    } catch (e) {
      c.res.failed({ message: 'NOT_FOUND' }, 404)
    }
  },
  all: async (c: IContext) => {
    try {
      const { data, total } = await postService.all(c)
      c.res.asJSON({ data, total })
    } catch (e) {
      c.res.failed(e)
    }
  },
  detail: async (c: IContext) => {
    try {
      const post = await orm.querySetter(c, Post)
        .leftJoinAndSelect('Post.board', 'board')
        .leftJoinAndSelect('Post.reactions', 'reactions')
        .withDeleted()
        .leftJoinAndSelect('Post.replies', 'replies')
        .leftJoinAndSelect('replies.user', 'rUser')
        .leftJoinAndSelect('rUser.profile', 'rProfile')
        .leftJoinAndSelect('Post.user', 'user')
        .leftJoinAndSelect('user.profile', 'profile')
        .leftJoinAndSelect('replies.parent', 'parent')
        .leftJoinAndSelect('replies.reactions', 'rReactions')
        .where('Post.sharing_key = :sharingKey', { sharingKey: c.req.params['sharingKey'] })
        .andWhere('Post.deleted_at IS NULL')
        .getOneOrFail() as Post

      post.mutatePostToBeSecure(c.req.ip)
      await post.increaseViews(c)
      c.res.asJSON(post)
    } catch (e) {
      c.res.failed({ message: 'NOT_FOUND' }, 404)
    }
  },
  delete: async (c: IContext) => {
    const user = await helpers.jwt.mustUser(c)
    if (!user && !c.req.body['password']) return c.res.failed()

    try {
      const postRepository = dataSource.getRepository(Post)
      const target = await postRepository.findOneOrFail({ where: { sharingKey: c.req.params['sharingKey'] } })
      if (target.userId) {
        // 자기 자신의 게시글을 삭제하기 때문에 비밀번호가 필요 없는 경우
        if (user['id'] !== target.userId) return c.res.failed()
      } else {
        // 익명 게시글을 삭제하기 때문에 비밀번호가 필요한 경우
        if (!helpers.crypto.compare(target.password, c.req.body['password'])) return c.res.failed({ message: 'INCORRECT_PASSWORD' })
      }

      await postRepository.softRemove(target)
      // 지워진 글이 검색에 남아 있는 시간을 만들면 안 된다. 눌러보면 없는 글로 간다.
      void ragIndexer.removeChunks(target.id)
      c.res.success()
    } catch (e) {
      c.res.failed()
      return
    }
  },
  search: async (c: IContext) => {
    // 인증이 없는 공개 경로다. 질의 임베딩이 IP당 비용을 만든다.
    //
    // IP 기준 제한은 실수로 두드리는 경우를 거르는 보조 층일 뿐, 악의적인 우회의
    // 방어선이 아니다. 이 서버는 trustProxy가 켜져 있어 c.req.ip가 클라이언트가
    // 보낸 X-Forwarded-For를 그대로 받는다 - 헤더 한 줄만 바꾸면 IP가 매번 달라져
    // 한도가 통째로 무의미해진다. services/content/desktop_jobs.ts가 2026-09-10에
    // 프로덕션에서 같은 문제를 겪고 자원 기준 제한으로 바꾼 사례가 있다.
    //
    // 그래서 아래에 IP와 무관한 전역 한도를 하나 더 둔다. 헤더를 아무리 바꿔도
    // 전역 바구니는 하나뿐이라 피할 수 없고, 이것이 실질적인 비용 방어선이다.
    if (!c.req.ip) return c.res.failed()

    if (!await rateLimit(`search:${c.req.ip}`, 30, 60)) {
      return c.res.failed({ message: 'TOO_MANY_REQUESTS' }, 429)
    }

    // 분당 120회. 채팅 기준 이 서비스의 실사용 트래픽(최근 30일 302건 수준)에서
    // 정상 사용자가 닿을 값이 아니다. 여기 걸리면 헤더 위조로 IP 층을 우회한
    // 폭주일 가능성이 높으므로 사람이 알아채도록 로그를 남긴다.
    if (!await rateLimit('search:global', 120, 60)) {
      log.warn('search: 전역 속도 제한 도달. IP 층 우회 가능성', { ip: c.req.ip })
      return c.res.failed({ message: 'TOO_MANY_REQUESTS' }, 429)
    }

    try {
      c.res.asJSON(await postService.search(c))
    } catch (e) {
      c.res.failed(e)
    }
  },
  checkPassword: async (c: IContext) => {
    if (!c.req.body['password']) return c.res.failed({ message: 'MISSING_REQUIRED_FIELD_PASSWORD' })

    try {
      await Post.checkPassword(c.req.params['sharingKey'], c.req.body['password'])
      c.res.success()
    } catch (e) {
      c.res.failed(e)
    }
  },
}

export default postController