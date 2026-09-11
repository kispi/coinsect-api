import { dataSource } from './database'
import { BadWord } from './entities/bad_word'
import { BannedUser } from './entities/banned_user'
import * as dotenv from 'dotenv'

const state = {
  // save users last action timestamp to prevent too frequent DB insert.
  lastUserActions: {
    viewPost: {},
    writePost: {},
    writeReply: {},
  },
  badWords: [] as Array<BadWord>,
  bannedUsers: [] as Array<BannedUser>,
  globalVariables: {
    // unit: ms
    lastUserActionTimeouts: {
      viewPost: 1000 * 60,
      writePost: 1000 * 10,
      writeReply: 1000 * 10,
    },
    maxlength: {
      nickname: 10,
      postTitle: 100,
      // 글 본문. 글자 수다.
      //
      // 상한이 없으면 익명 글쓰기가 그대로 임베딩 비용 주입 통로가 된다. 글을 쓰거나
      // 고치면 그 자리에서 인덱싱이 돌기 때문에, 1MB짜리 본문 하나가 약 1,250청크 ·
      // 약 83만 토큰 · 약 $0.12이고 수정할 때마다 다시 든다. embed_index는 일일 비용
      // 상한(services/post.ts)에서 빠져 있으므로 - 운영자가 한 번 돌리는 백필이 공개
      // 답변을 하루 종일 끄면 안 되기 때문이다 - 이 경로는 입구에서 막아야 한다.
      //
      // 10만 자로 둔 근거: 자유게시판 글은 평균 약 2,200자, 블로그 글이 평균 약
      // 5,700자다(2026-09-11 코퍼스 실측). 10만 자는 그 45배와 18배라 이미 쓰인 글이
      // 걸려 수정이 막힐 여지가 없고, 1MB(약 105만 자)는 확실히 거른다. 상한까지 꽉
      // 채운 글도 약 125청크 · 약 8만 토큰 · 약 $0.012이라, 아래 글쓰기 속도 제한과
      // 곱해도 한 시간 최악이 한 자릿수 달러다.
      //
      // 어드민 경로는 Post.validate를 타지 않아(admin_controller의 routesPost.update가
      // Post.save를 직접 부른다) 긴 블로그 글은 이 상한과 무관하다.
      postContent: 100000,
      profileImageUrl: 255, // varchar(255)
      replyContent: 1000,
    },
    version: {
      frontend: null,
      backend: null,
    },
  },
  // .env가 없는 환경(테스트, env를 직접 주입하는 배포)에서도 undefined가 되지 않아야
  // 이 값을 모듈 최상단에서 읽는 곳들이 기동 중에 터지지 않는다.
  serverConfig: dotenv.config().parsed || process.env,
}

const actions = {
  loadBadWords: async () => {
    try {
      const data = await dataSource
        .getRepository(BadWord)
        .createQueryBuilder()
        .getMany()
  
      const json = JSON.parse(JSON.stringify(data))
      store.state.badWords = json
      return store.state.badWords
    } catch (e) {
      return Promise.reject(e)
    }
  },
  loadBannedUsers: async () => {
    try {
      const data = await dataSource
        .getRepository(BannedUser)
        .createQueryBuilder()
        .getMany()
  
      const json = JSON.parse(JSON.stringify(data))
      store.state.bannedUsers = json
      return store.state.bannedUsers
    } catch (e) {
      return Promise.reject(e)
    }
  },
}

const store = {
  state,
  actions,
}

export default store