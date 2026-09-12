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
// 2026-09-11 백필(청크 6,101개) 직후 프로덕션에서 실측했다.
//
//   관련 질의 6종  67.1% ~ 78.6%
//   무관 질의 6종  61.0% ~ 79.3%
//
// **두 분포가 겹친다.** scheduly에서는 6.2%p 간격으로 갈렸는데 여기서는 안 갈린다.
// 이 코퍼스가 통째로 암호화폐 이야기라서다 - 무관한 질의를 넣어도 가장 가까운 글이
// 여전히 코인 글이고, 그 거리가 멀지 않다. 주제가 좁은 코퍼스에서는 코사인이 높은
// 쪽에 몰리므로, 중간에 선을 그어 관련/무관을 가르는 방식 자체가 성립하지 않는다.
//
// 그래서 "무관을 전부 막는 값"이 아니라 "관련을 최대한 살리면서 무관을 최소로 들이는
// 값"으로 골랐다. 네 후보를 실제로 대봤다:
//
//   0.70  관련 5/6, 무관 1/6   <- 채택
//   0.72  관련 4/6, 무관 1/6
//   0.75  관련 2/6, 무관 1/6
//   0.78  관련 2/6, 무관 1/6
//
// 0.70 위로 올려봐야 무관은 줄지 않고 관련만 잘려나간다. 남은 무관 1건은 "오늘 점심
// 메뉴 추천"인데, 잡담 게시판이라 실제로 관련 글이 있을 수 있어 무관 질의로 고른 것이
// 잘못이었다. 다음에 보정할 때 질의 목록부터 실제 글을 보고 다시 짤 것.
//
// 벡터가 놓치는 것은 키워드 경로가 받는다. 하이브리드로 만든 이유가 이것이고,
// 이 코퍼스에서는 그 판단이 특히 값을 한다.
export const MIN_SCORE = 0.70

// 관련 글의 최소 유사도. MIN_SCORE를 그대로 쓰면 안 된다 - 저건 질의와 청크 사이의
// 거리로 잰 값이고, 여기는 청크와 청크 사이다. 같은 공간이라도 분포가 통째로 다르다.
//
// 2026-09-12 프로덕션에서 실측했다(표본 60글, 같은 보드 안에서 자기 글 제외).
//
//   이웃 순위별 유사도    1위 중앙 0.841   10위 중앙 0.818   10위 최소 0.748
//
// 상위 10위가 0.023 폭 안에 뭉쳐 있다. 0.70으로는 아무것도 걸러지지 않고, 순위
// 자체도 의미를 갖기 어렵다. 코퍼스가 통째로 암호화폐 이야기라서다.
//
// 그래서 "관련을 살리는 값"이 아니라 "관련이라고 부를 만한 것만 남기는 값"으로
// 골랐다. 임계값별로 이웃을 하나라도 가진 글의 비율을 봤다.
//
//   0.85  60글 중 33글   걸린 이웃 평균 126개
//   0.88  60글 중 24글   걸린 이웃 평균 39개   <- 채택
//   0.90  60글 중 15글
//
// 이웃 평균 개수가 저렇게 큰 것은 같은 작성자가 같은 형식으로 매일 쓴 시장
// 코멘터리들이 임베딩 공간에서 서로 거의 같은 글이기 때문이다. 그래서 컷오프만으로는
// 부족하고 작성자당 한 건으로 묶는 단계가 함께 필요하다(related가 그 일을 한다).
//
// 절반 넘는 글이 관련 글을 아예 갖지 못한다. 그게 맞다 - 억지로 채우면 "날짜만 다른
// 같은 글"을 관련 글이라고 내보이게 된다. 없으면 섹션을 숨기는 쪽이 옳다.
export const RELATED_MIN_SCORE = 0.88

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

interface IRelatedHit {
  postId: number
  boardId: number
  // 작성자당 한 건으로 묶는 데 쓴다. userId가 없는 글이 230건 있어서 nickname을 함께 든다.
  userId: number | null
  nickname: string | null
  score: number
}

// 한 작성자를 가리키는 키들. 하나라도 이미 나왔으면 같은 사람으로 본다.
//
// userId만으로는 안 된다. 실측에서 관련 글 상위를 통째로 차지한 '[09/14] 비트코인 시황'
// 연작이 전부 userId가 없는 글이었다 - 크롤링으로 들어온 글에는 앱 사용자가 없다.
// userId로만 묶으면 그 글들은 서로 다른 작성자로 취급돼 묶이지 않고, 장치가 정작
// 필요한 자리에서 아무 일도 하지 않는다.
//
// 둘 중 하나를 고르는 것으로도 부족하다. userId를 우선하면 같은 사람이 회원 글과
// 익명 글로 각각 한 칸씩 차지한다(실측: '베스트코인'이 userId 있는 글과 없는 글로
// 두 번 올라왔다). 그래서 가진 키를 모두 등록하고, 하나라도 겹치면 접는다.
//
// 대가는 서로 다른 사람이 같은 닉을 쓸 때 한 명으로 접히는 것이다. nickname은 익명
// 글에서 사람이 직접 적는 값이라 그런 일이 생길 수 있다. 잃는 것은 관련 글 목록의
// 한 칸이고, 얻는 것은 '날짜만 다른 같은 글' 열세 줄을 막는 것이다.
const authorKeysOf = (hit: IRelatedHit): string[] => {
  const keys: string[] = []
  if (hit.userId !== null) keys.push(`u:${hit.userId}`)
  if (hit.nickname) keys.push(`n:${hit.nickname}`)
  // 둘 다 없으면 묶을 근거가 없다. 접지 않고 통과시킨다.
  return keys
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

  // 그 글의 청크 벡터를 읽는다. SQL을 타는 지점.
  //
  // 첫 청크만 쓴다. 청크 전체의 평균을 내는 방법도 있지만, 평균 벡터는 색인된
  // 어떤 청크와도 다른 지점이라 실측해 둔 컷오프가 그 자리에서는 의미를 잃는다.
  // 첫 청크는 색인된 청크들과 같은 성격의 점이므로 잰 값을 그대로 쓸 수 있다.
  sourceVector: async (postId: number): Promise<number[] | null> => {
    const rows = await dataSource.query(
      `SELECT c.embedding::text AS embedding
       FROM post_chunks c
       WHERE c.post_id = $1 AND c.embedding IS NOT NULL
       ORDER BY c.chunk_index
       LIMIT 1`,
      [postId],
    )

    if (!rows.length) return null

    // pgvector의 텍스트 표현이 '[0.1,0.2,...]'라 그대로 JSON이다.
    try {
      return JSON.parse(rows[0].embedding)
    } catch (e) {
      log.error('관련 글: 청크 벡터를 읽지 못했다', e)
      return null
    }
  },

  // SQL을 타는 지점. vectorSearch와 나눠 둔 이유는 두 가지다 - 자기 글을 빼야 하고,
  // 작성자당 한 건으로 묶기 위해 user_id가 필요하다.
  relatedSearch: async (
    vector: number[],
    boardId: number,
    excludePostId: number,
    minScore: number,
    limit: number,
  ): Promise<IRelatedHit[]> => {
    const rows = await dataSource.query(
      `SELECT c.post_id, c.board_id, p.user_id, p.nickname, (c.embedding <=> $1::vector) AS distance
       FROM post_chunks c
       -- 살아 있는 글만. vectorSearch의 EXISTS와 같은 이유이고, 여기서는 작성자도
       -- 함께 필요하므로 JOIN으로 겸한다.
       JOIN posts p ON p.id = c.post_id AND p.deleted_at IS NULL
       WHERE c.embedding IS NOT NULL
         AND c.post_id <> $2
         -- 보드를 넘지 않는다. web과 nuxt가 서로 다른 보드를 읽는 별개의 사이트라,
         -- 넘어가면 한쪽 사이트의 글이 다른 쪽 화면에 관련 글로 올라간다.
         AND c.board_id = $3
         AND (c.embedding <=> $1::vector) <= $4
       ORDER BY (c.embedding <=> $1::vector) ASC
       LIMIT $5`,
      [`[${vector.join(',')}]`, excludePostId, boardId, 1 - minScore, limit],
    )

    return rows.map(r => ({
      postId: Number(r.post_id),
      boardId: Number(r.board_id),
      userId: r.user_id === null ? null : Number(r.user_id),
      nickname: r.nickname ?? null,
      score: Math.max(0, 1 - Number(r.distance)),
    }))
  },

  // 관련 글. 질의 임베딩을 만들지 않는다 - 그 글의 청크 벡터가 이미 저장돼 있으므로
  // 그것으로 최근접 이웃만 찾으면 된다. 이 경로의 AI 비용은 0이다.
  related: async ({ postId, boardId, limit = 5, minScore = RELATED_MIN_SCORE }: {
    postId: number,
    boardId: number,
    limit?: number,
    minScore?: number,
  }): Promise<IRelatedHit[]> => {
    const vector = await search.sourceVector(postId)
    // 아직 색인되지 않았거나 색인 대상 보드가 아닌 글이다. 관련 글이 없는 것과
    // 같게 다룬다 - 화면은 어느 쪽이든 섹션을 숨긴다.
    if (!vector || !vector.length) return []

    // 한 글이 청크 여러 개로 색인되고 작성자당 한 건으로 묶으므로, limit만큼만
    // 뽑으면 접은 뒤에 남는 것이 거의 없다. 넉넉히 뽑아 놓고 자른다.
    const depth = Math.max(limit * 10, 50)
    const hits = await search.relatedSearch(vector, boardId, postId, minScore, depth)

    // 글 단위로 접고, 이어서 작성자 단위로 접는다. 순서가 중요하다 - 같은 글의
    // 청크 둘이 작성자 슬롯을 먼저 먹으면 그 작성자의 다른 글이 통째로 밀린다.
    //
    // 작성자로 접는 이유는 실측이다. 프로덕션에서 한 글의 이웃을 뽑아 보니 상위
    // 열세 줄이 같은 사람이 쓴 '[09/14] 비트코인 시황', '[09/16] 비트코인 시황'
    // 연작이었다. 접지 않으면 관련 글이 '날짜만 다른 같은 글' 목록이 된다.
    const seenPosts = new Set<number>()
    const seenAuthors = new Set<string>()
    const picked: IRelatedHit[] = []

    for (const hit of hits) {
      if (picked.length >= limit) break
      if (seenPosts.has(hit.postId)) continue
      seenPosts.add(hit.postId)

      const authorKeys = authorKeysOf(hit)
      if (authorKeys.some(key => seenAuthors.has(key))) continue
      authorKeys.forEach(key => seenAuthors.add(key))

      picked.push(hit)
    }

    return picked
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
