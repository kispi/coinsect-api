import { Brackets } from 'typeorm'
import { Post } from '../entities/post'
import { loadChildren } from '../core/controller'
import { Reply } from '../entities/reply'
import { Reaction } from '../entities/reaction'
import { GoogleGenAI } from '@google/genai'
import { log } from '../core/logger'
import store from '../store'
import IContext from '../core/interfaces/context'
import orm, { QueryOverrides } from '../core/orm'
import aiUsage from './ai_usage'
import ragSearch from './rag/search'

// 떠다니는 별칭(gemini-flash-latest)을 쓰지 않는다. 구글이 별칭을 다음 티어로
// 옮기면 배포도 하지 않았는데 단가와 응답 성향이 함께 바뀌고, 단가표에 그 이름이
// 없어 비용이 미상으로 기록된다. 판독 쪽이 같은 이유로 이미 고정돼 있다.
//
// 이 모델은 2027-01-01에 $1.50 / $7.50으로 두 배가 된다. 그날이 오면
// model_usage.ts의 MODEL_PRICING을 함께 고쳐야 한다 - 표를 안 고치면 기록된
// 원가만 절반으로 남고 청구서는 두 배로 온다.
const ANSWER_MODEL = 'gemini-3.8-flash'

const postService = {
  sitemap: async (c: IContext) => {
    try {
      const queryResult = await orm.querySetter(c, Post)
        .where('board_id = :boardId', { boardId: c.req.params['boardId'] })
        .select(['sharing_key'])
        .getRawMany()
      return { data: queryResult.map(r => r.sharing_key), total: queryResult.length }
    } catch (e) {
      return Promise.reject(e)
    }
  },
  all: async (c: IContext, overrides?: QueryOverrides) => {
    const query = overrides || c.req.query

    if (query['limit'] > 20) return Promise.reject({ message: 'limit exceeded 20', status: 400 })

    try {
      const qb = orm.querySetter(c, Post, overrides)
        .leftJoinAndSelect('Post.user', 'user')
        .leftJoinAndSelect('user.profile', 'profile')
        .leftJoinAndSelect('Post.board', 'board')

      // LIKE 검색이 너무 많아서 나중에 규모가 커지면 ES등 튜닝 필요함
      const keyword = query['keyword']
      if (keyword) {
        // 값에 든 %와 _를 리터럴로 만든다. 이스케이프하지 않으면 조건이 임의로 넓어진다.
        const pattern = `%${keyword.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
        qb.andWhere(new Brackets(subQb => subQb
          .where('Post.nickname ILIKE :pattern', { pattern })
          .orWhere('profile.nickname ILIKE :pattern', { pattern })
          .orWhere('Post.title ILIKE :pattern', { pattern })
          .orWhere('Post.content ILIKE :pattern', { pattern })
        ))
      }

      if (!query['limit']) qb.limit(20)

      const [data, total] = await qb.getManyAndCount()
      await Promise.all([
        loadChildren({ c, model: Post, childModel: Reply, items: data }),
        loadChildren({ c, model: Post, childModel: Reaction, items: data }),
      ])
      data.forEach((post: Post) => post.mutatePostToBeSecure(c.req.ip))
      return { data, total }
    } catch (e) {
      return Promise.reject(e)
    }
  },
  allWithLLM: async (c: IContext) => {
    const boardId = c.req.query['boardId']
    const q = c.req.query['question']
    if (!boardId || !q) return Promise.reject({ message: 'boardId or question is missing', status: 400 })

    log.info(`allWithLLM: query "${q}" (IP: ${c.req.ip})`)

    try {
      const [data, _] = await c.orm.getRepository(Post).createQueryBuilder()
        .leftJoinAndSelect('Post.user', 'user')
        .leftJoinAndSelect('user.profile', 'profile')
        .leftJoinAndSelect('Post.board', 'board')
        .where('Post.board = :boardId', { boardId })
        .getManyAndCount()
      await Promise.all([
        loadChildren({ c, model: Post, childModel: Reply, items: data }),
        loadChildren({ c, model: Post, childModel: Reaction, items: data }),
      ])
      data.forEach((post: Post) => post.mutatePostToBeSecure(c.req.ip))

      const genAI = new GoogleGenAI({ apiKey: store.state.serverConfig.GOOGLE_AI_STUDIO })
      const generate = async (parts: Array<{ text: string }>) => {
        const startedAt = Date.now()
        try {
          const result = await genAI.models.generateContent({
            model: ANSWER_MODEL,
            contents: parts,
            config: { responseMimeType: 'application/json' },
          })
          void aiUsage.record({
            task: 'post_answer',
            model: ANSWER_MODEL,
            usageMetadata: result.usageMetadata,
            latencyMs: Date.now() - startedAt,
            requester: c.req.ip,
          })
          return result
        } catch (e) {
          // 실패한 호출도 남긴다. 실패가 치솟는 것이 이상 징후인데 행이 없으면 안 보인다.
          void aiUsage.record({
            task: 'post_answer',
            model: ANSWER_MODEL,
            latencyMs: Date.now() - startedAt,
            ok: false,
            error: (e || {}).message || String(e),
            requester: c.req.ip,
          })
          throw e
        }
      }

      const prompt1 = `
User is asking a question: "${q}" about bitcoin.
Choose the most appropriate 3 (at most) posts within the list below.
Response should be an array of number.
If you can't find any, please respond with an empty array.
You don't need to fill 3, just return 0~3 posts.

${data.map((post: Post) => `post.id: ${post.id} / post.title: ${post.title}`).join('\n')}
      `.trim()

      const result1 = await generate([{ text: prompt1 }])
      const selectedPosts = data.filter((post: Post) => JSON.parse(result1.text).includes(post.id))

      const prompt2 = `
OK, you have chosen the following posts:
${selectedPosts.map((post: Post) => `post.id: ${post.id} / post.title: ${post.title} / post.content: ${post.content}`).join('\n')}
Using the information above, provide a answer to the user's question: "${q}" about bitcoin.
The result JSON should be a form of { "kr": String, "en": String }
      `
      const result2 = await generate([{ text: prompt2 }])
      return { data: selectedPosts, total: selectedPosts.length, answer: JSON.parse(result2.text) }
    } catch (e) {
      log.error('allWithLLM:', e)
      return Promise.reject(e)
    }
  },
  // 하이브리드 검색. 기존 /posts?keyword= 는 손대지 않는다 - 어드민과 목록이
  // 같이 쓰고 limit/offset 페이지네이션을 전제로 돌기 때문이다.
  search: async (c: IContext) => {
    const q = (c.req.query['q'] || '').trim()
    if (!q) return Promise.reject({ message: 'q is missing', status: 400 })
    if (q.length > 200) return Promise.reject({ message: 'q is too long', status: 400 })

    const boardId = c.req.query['boardId'] ? Number(c.req.query['boardId']) : null
    // 정수로 내리고 1~20 사이로 묶는다. Number(...)만으로는 음수나 소수가 그대로
    // SQL의 LIMIT까지 흘러가 500을 낸다.
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query['limit'])) || 20, 1), 20)

    const retrieved = await ragSearch.retrieve({ q, boardId, limit })
    if (!retrieved.length) return { data: [], total: 0 }

    const posts = await c.orm.getRepository(Post).createQueryBuilder('Post')
      .leftJoinAndSelect('Post.user', 'user')
      .leftJoinAndSelect('user.profile', 'profile')
      .leftJoinAndSelect('Post.board', 'board')
      .where('Post.id IN (:...ids)', { ids: retrieved.map(o => o.postId) })
      .getMany()

    posts.forEach((post: Post) => post.mutatePostToBeSecure(c.req.ip))

    // 회수 순서가 곧 랭킹이다. DB가 돌려준 순서가 아니라 이 순서를 지켜야 한다.
    //
    // { ...post, ... }로 펼치면 안 된다. Post 인스턴스를 펼치면 프로토타입이
    // 떨어져 나간 평범한 객체가 되고, 그러면 Post.toJSON()이 다시는 불리지
    // 않는다 - password는 mutatePostToBeSecure가 아니라 toJSON()이 지우므로,
    // 그 결과 익명 글의 비밀번호 해시가 그대로 응답에 실려 나간다. 반드시
    // post.toJSON()을 먼저 불러 password가 지워진 평범한 객체를 만든 뒤에 펼친다.
    const byId = new Map(posts.map(p => [p.id, p]))
    const data = retrieved
      .map(hit => {
        const post = byId.get(hit.postId)
        return post && { ...post.toJSON(), score: hit.score, matchType: hit.matchType }
      })
      .filter(Boolean)

    return { data, total: data.length }
  },
}

export default postService