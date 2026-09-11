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
      // 2만 자로 둔 근거: 자유게시판 글은 평균 약 2,200자, 블로그 글이 평균 약
      // 5,700자다(2026-09-11 코퍼스 실측). 2만 자는 그 9배와 3.5배라 실사용이 닿지
      // 않으면서, 1MB(약 105만 자)는 확실히 거른다.
      //
      // 처음에 10만 자로 뒀다가 내렸다. 겹침(800자 청크, 120자 겹침)까지 세면 10만
      // 자는 약 76,700토큰이라 글 하나에 $0.0115이고, 이걸 전역 분당 10회와 곱하면
      // 하루 $166이 된다. 다른 공개 경로를 전부 합친 최악이 하루 $6이고 답변에는 $2
      // 상한이 걸려 있는데, embed_index는 그 상한 밖이라 이걸 멈출 스위치가 없다.
      // 2만 자면 약 15,300토큰 · 글당 $0.0023으로 다섯 배가 줄어든다.
      //
      // 돌릴 손잡이가 속도 제한이 아니라 길이인 이유: 제한을 조이면 정상 글쓰기가
      // 먼저 아프지만, 비용은 길이에 선형이라 길이를 줄이면 정상 사용자는 아무것도
      // 잃지 않는다.
      //
      // 어드민 경로는 Post.validate를 타지 않아(admin_controller의 routesPost.update가
      // Post.save를 직접 부른다) 긴 블로그 글은 이 상한과 무관하다.
      postContent: 20000,
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