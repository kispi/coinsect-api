import { dataSource } from '../../database'
import { INDEXED_BOARD_IDS } from './indexer'

// 한 질의에서 뽑아 쓸 최대 토큰 수. 넘기면 SQL의 OR 가지가 무의미하게 늘어난다.
const MAX_TOKENS = 8
// 이보다 짧은 토큰은 부분일치에서 잡음만 만든다(조사, 관형사 등).
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
    const clauses = patterns
      .map((_, i) => `(p.title ILIKE $${i + 1} ESCAPE '\\' OR coalesce(p.content, '') ILIKE $${i + 1} ESCAPE '\\')`)
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
