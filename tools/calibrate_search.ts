// 유사도 컷오프를 실측으로 정한다.
//
//   GOOGLE_AI_STUDIO=<키> npx ts-node tools/calibrate_search.ts
//
// 무관한 질의의 최고점과 관련 있는 질의의 최저점 사이가 벌어져 있어야 컷오프를
// 그을 자리가 있다. 겹치면 이 코퍼스에서는 벡터 단독으로 가를 수 없다는 뜻이고,
// 그때는 컷오프를 낮추고 키워드 경로에 더 기대야 한다.
//
// 백필(tools/backfill_post_embeddings.ts)을 먼저 돌려 청크가 실제로 채워진
// 뒤에 실행할 것 - 인덱스가 비어 있으면 모든 점수가 0에 가깝게 나와 컷오프가
// 근거 없이 후하게 잡힌다.
import { dataSource } from '../database'
import search from '../services/rag/search'

// 코퍼스에 답이 있을 질의와 없을 질의. 아래는 "비트코인 자유게시판 + 코인 블로그
// 두 곳"이라는 설명만 보고 고른 자리표시자다 - 실제로 인덱싱된 글 제목을 몇 개
// 훑어보고 그 코퍼스에 진짜 있을 법한 질의/없을 법한 질의로 바꿔 쓸 것.
// IRRELEVANT를 아무나 봐도 명백히 무관한 항목으로만 채우면(예: 전부 육아나
// 여행 얘기) 무관 최고점이 실제보다 낮게 나와 컷오프가 실제보다 후하게 측정된다
// - 코인 얘기와 헷갈릴 법한(투자/재테크/차트 등 인접 주제) 질의도 몇 개 섞을 것.
const RELEVANT = [
  '비트코인 반감기가 뭐야',
  '채굴 난이도는 어떻게 정해져',
  '콜드월렛 추천',
  '김치프리미엄이 왜 생겨',
  '레버리지 청산 당했다',
  '반감기 이후 가격',
]
const IRRELEVANT = [
  '오늘 점심 메뉴 추천',
  '자동차 보험 갱신 방법',
  '초등학교 입학 준비물',
  '무릎 통증 스트레칭',
  '엑셀 피벗테이블 만들기',
  '제주도 3박 4일 일정',
]

const topScore = async (q: string) => {
  // 컷오프를 0으로 두고 뽑아야 분포 전체가 보인다.
  const hits = await search.retrieve({ q, limit: 5, minScore: 0 })
  const scored = hits.filter(h => h.score !== null)
  return scored.length ? Math.max(...scored.map(h => h.score)) : 0
}

const run = async () => {
  await dataSource.initialize()

  const startedAt = Date.now()

  // 질의마다 임베딩 API를 한 번씩 부르므로 12개라도 몇 초 걸릴 수 있다. 끝날 때
  // 한꺼번에 보여주면 멈춘 것처럼 보이므로 진행 중에 바로바로 찍는다.
  const relevant: { q: string, score: number }[] = []
  for (const q of RELEVANT) {
    const score = await topScore(q)
    console.log(`[관련 있음] ${(score * 100).toFixed(1)}%  ${q}`)
    relevant.push({ q, score })
  }

  const irrelevant: { q: string, score: number }[] = []
  for (const q of IRRELEVANT) {
    const score = await topScore(q)
    console.log(`[무관함]     ${(score * 100).toFixed(1)}%  ${q}`)
    irrelevant.push({ q, score })
  }

  const relevantMin = Math.min(...relevant.map(r => r.score))
  const irrelevantMax = Math.max(...irrelevant.map(r => r.score))

  console.log(`\n관련 최저 ${(relevantMin * 100).toFixed(1)}% / 무관 최고 ${(irrelevantMax * 100).toFixed(1)}%`)
  if (relevantMin <= irrelevantMax) {
    console.log('두 분포가 겹친다. 벡터 단독으로 가를 수 없다 - 컷오프를 낮추고 키워드에 기댈 것.')
  } else {
    console.log(`제안 컷오프: ${((relevantMin + irrelevantMax) / 2).toFixed(3)}`)
  }

  console.log(`\n${Math.round((Date.now() - startedAt) / 1000)}초 걸림.`)
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
