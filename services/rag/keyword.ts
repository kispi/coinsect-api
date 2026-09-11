import { dataSource } from '../../database'
import { INDEXED_BOARD_IDS } from './indexer'

// 한 질의에서 뽑아 쓸 최대 토큰 수. 넘기면 SQL의 OR 가지가 무의미하게 늘어난다.
const MAX_TOKENS = 8
// 이보다 짧은 토큰은 부분일치에서 잡음만 만든다(조사, 관형사 등).
//
// 2글자 토큰은 trigram 인덱스를 쓰지 못한다. gin_trgm_ops는 패턴을 3글자 조각으로
// 쪼개 후보를 찾는데, 2글자에서는 조각이 하나도 안 나와 플래너가 순차 스캔으로
// 떨어진다. 그래도 3으로 올리지 않는다 - 채굴, 반감, 상장처럼 뜻이 온전한 두 글자
// 한국어 단어가 통째로 버려지고, 그렇게 잃는 회수는 되찾을 방법이 없다.
// 1,713글 · 본문 3.94MB 규모에서 순차 스캔 한 번은 감당할 수 있는 비용이라
// 회수를 택한다. 코퍼스가 한 자릿수 배로 커지면 이 판단을 다시 재야 한다.
const MIN_TOKEN_LENGTH = 2

// 값에 든 %와 _를 리터럴로 만든다. 이스케이프하지 않으면 조건이 임의로 넓어진다.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, ch => `\\${ch}`)

export const buildPatterns = (q: string): string[] => {
  const seen = new Set<string>()
  const patterns: string[] = []

  for (const raw of (q || '').split(/\s+/)) {
    const token = raw.trim()
    if (token.length < MIN_TOKEN_LENGTH) continue

    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    patterns.push(`%${escapeLike(token)}%`)
    if (patterns.length >= MAX_TOKENS) break
  }

  return patterns
}

export interface IKeywordHit {
  postId: number
  boardId: number
}

const keyword = {
  // post_chunks가 아니라 posts 원본을 본다. 아직 인덱싱되지 않은 글(방금 쓴 글,
  // 임베딩 실패분)은 청크가 없어 벡터 검색에 절대 잡히지 않는데, 이 경로는
  // 그것들을 첫 검색부터 찾아낸다.
  search: async (q: string, boardId: number | null, limit: number): Promise<IKeywordHit[]> => {
    const patterns = buildPatterns(q)
    if (!patterns.length) return []

    // 패턴 자리표시자는 $1..$N, 그 다음이 board 배열, 마지막이 limit이다.
    // 리터럴 번호를 직접 세지 않도록 params 배열의 길이로부터 다음 번호를
    // 매번 계산한다 - 패턴 개수가 바뀌어도 어긋나지 않는다.
    const params: unknown[] = [...patterns]
    // 컬럼을 함수로 감싸지 않는다. posts_content_trgm_idx는 content 자체에 걸린
    // 인덱스라 인덱싱된 식과 조건의 식이 글자 그대로 같아야 매칭되고,
    // coalesce(p.content, '')로 감싸는 순간 플래너에게는 다른 식이 되어
    // 인덱스가 통째로 무시된다 - 매 검색이 전 글 순차 스캔이 되고, 그것도
    // 패턴 수(최대 8)만큼 반복된다.
    //
    // content는 NOT NULL이라(entities/post.ts) coalesce가 바꾸는 것도 없었다.
    // title은 nullable이지만 감싸지 않는다. NULL ILIKE는 NULL이고 OR에서 NULL은
    // 참이 아니라, 감싸지 않아도 제목 없는 글이 잘못 걸리는 일은 없다.
    const clauses = patterns
      .map((_, i) => `(p.title ILIKE $${i + 1} ESCAPE '\\' OR p.content ILIKE $${i + 1} ESCAPE '\\')`)
      .join(' OR ')

    const boardParamIndex = params.length + 1
    params.push(boardId ? [boardId] : INDEXED_BOARD_IDS)

    const limitParamIndex = params.length + 1
    params.push(limit)

    const rows = await dataSource.query(
      `SELECT p.id AS post_id, p.board_id FROM posts p
       WHERE p.deleted_at IS NULL AND p.board_id = ANY($${boardParamIndex}) AND (${clauses})
       ORDER BY p.id DESC LIMIT $${limitParamIndex}`,
      params,
    )

    return rows.map(r => ({ postId: Number(r.post_id), boardId: Number(r.board_id) }))
  },
}

export default keyword
