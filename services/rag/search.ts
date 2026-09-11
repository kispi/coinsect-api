import { dataSource } from '../../database'
import { log } from '../../core/logger'
import embedding from './embedding'
import keyword, { IKeywordHit } from './keyword'
import { fuseRRF } from './fusion'
import { INDEXED_BOARD_IDS } from './indexer'

// 결과로 인정할 최소 유사도.
//
// 임베딩 공간은 비등방적이라 코사인 유사도가 0 근처로 내려가지 않는다. 컷오프가
// 없으면 검색은 언제나 "가장 덜 먼" K개를 돌려주고, 화면은 그걸 그럴듯한 숫자로
// 보여준다 - 엉뚱한 결과가 확신에 차서 뜨는 셈이다.
//
// 값은 감이 아니라 실측으로 정한다. tools/calibrate_search.ts로 재고 아래 기록을
// 갱신할 것. 모델이나 차원이 바뀌면 점수 분포가 통째로 이동한다.
//
// (백필 뒤 실측값을 여기에 날짜와 함께 적는다. 그 전까지는 scheduly의 측정에서
//  빌려온 잠정값이다 - 그쪽 코퍼스는 업무 노트라 우리와 분포가 다르다.)
export const MIN_SCORE = 0.71

export interface IRetrieved {
  postId: number
  boardId: number
  content: string
  // 벡터 매칭이 있을 때만 코사인 유사도(0~1). 키워드 전용이면 null이다.
  score: number | null
  matchType: 'vector' | 'keyword' | 'both'
}

interface IVectorHit {
  postId: number
  boardId: number
  content: string
  score: number
}

const search = {
  // SQL을 타는 지점. 테스트가 갈아끼운다.
  vectorSearch: async (
    vector: number[],
    boardId: number | null,
    minScore: number,
    limit: number,
  ): Promise<IVectorHit[]> => {
    const rows = await dataSource.query(
      `SELECT c.post_id, c.board_id, c.content, (c.embedding <=> $1::vector) AS distance
       FROM post_chunks c
       WHERE c.embedding IS NOT NULL
         AND c.board_id = ANY($2)
         -- 살아 있는 글만 돌려준다. 삭제 경로와 훑기가 청크를 걷지만, 그 사이의
         -- 짧은 틈 때문에 "눌러보면 없는 글"이 뜨면 안 된다. 마지막 방어선이다.
         AND EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.deleted_at IS NULL)
         AND (c.embedding <=> $1::vector) <= $3
       ORDER BY (c.embedding <=> $1::vector) ASC
       LIMIT $4`,
      [`[${vector.join(',')}]`, boardId ? [boardId] : INDEXED_BOARD_IDS, 1 - minScore, limit],
    )

    return rows.map(r => ({
      postId: Number(r.post_id),
      boardId: Number(r.board_id),
      content: r.content,
      score: Math.max(0, 1 - Number(r.distance)),
    }))
  },

  retrieve: async ({ q, boardId, limit = 20, minScore = MIN_SCORE }: {
    q: string,
    boardId?: number | null,
    limit?: number,
    minScore?: number,
  }): Promise<IRetrieved[]> => {
    const trimmed = (q || '').trim()
    if (!trimmed) return []

    // 융합은 순위만 쓰므로 후보가 얕으면 합칠 것이 없다. 넉넉히 뽑아 놓고 자른다.
    const depth = Math.max(limit * 3, 30)

    // 키워드 검색은 임베딩을 기다릴 이유가 없다. 둘을 병렬로 돌려 지연을 겹친다.
    //
    // 두 경로는 각자 자신의 실패를 잡는다. Promise.all은 하나라도 던지면 통째로
    // reject하므로, 여기서 안 잡으면 벡터 SQL의 타임아웃 하나가 이미 돌아온
    // 키워드 결과까지 물귀신처럼 끌고 내려가 검색 전체가 500으로 죽는다.
    // "장애로 벡터를 포기해도 검색이 통째로 죽으면 안 된다"는 계약은 임베딩
    // 실패(embed가 null을 줌)뿐 아니라 SQL 자체의 예외에도 지켜져야 한다.
    const [vectorHits, keywordHits] = await Promise.all([
      (async (): Promise<IVectorHit[]> => {
        const [vector] = await embedding.embed([trimmed], 'RETRIEVAL_QUERY', 'embed_query')
        if (!vector || !vector.length) return []
        return search.vectorSearch(vector, boardId || null, minScore, depth)
      })().catch(e => {
        log.error('하이브리드 검색: 벡터 경로 실패', e)
        return []
      }),
      keyword.search(trimmed, boardId || null, depth).catch(e => {
        log.error('하이브리드 검색: 키워드 경로 실패', e)
        return []
      }),
    ])

    // 융합 전에 글 단위로 접는다. RRF는 리스트당 한 항목이 한 번 등장한다고
    // 전제한다. 가장 앞선 청크(=가장 유사한 청크)만 남겨 그 전제를 지킨다.
    const bestPerPost: IVectorHit[] = []
    const seen = new Set<number>()
    for (const hit of vectorHits) {
      if (seen.has(hit.postId)) continue
      seen.add(hit.postId)
      bestPerPost.push(hit)
    }

    // 벡터 결과를 첫 리스트로 넘긴다 - 동점일 때 본문과 코사인 점수를 함께 가진
    // 쪽이 살아남게 하려는 것이다(fuseRRF는 최초 등장 객체를 유지한다).
    const fused = fuseRRF<IVectorHit | IKeywordHit>(
      [bestPerPost, keywordHits],
      hit => String(hit.postId),
    )

    return fused.slice(0, limit).map(({ item, sources }) => {
      const inVector = sources.includes(0)
      const inKeyword = sources.includes(1)

      return {
        postId: item.postId,
        boardId: item.boardId,
        content: inVector ? (item as IVectorHit).content : '',
        // RRF 점수를 여기 넣지 마라 - 화면이 백분율로 표시하는 코사인 유사도 자리다.
        score: inVector ? (item as IVectorHit).score : null,
        matchType: inVector && inKeyword ? 'both' : inVector ? 'vector' : 'keyword',
      }
    })
  },
}

export default search
