import { dataSource } from '../../database'
import { log } from '../../core/logger'
import useCache from '../../core/cache'
import { chunkText } from './chunker'
import embedding, { computeHash, EMBEDDING_MODEL } from './embedding'

const cache = useCache()

// 인덱싱 대상 보드. 자유게시판(1), 비트코인 블로그(3), 코인섹트 블로그(4).
export const INDEXED_BOARD_IDS = [1, 3, 4]

const LOCK_KEY = 'rag:locks'
const LOCK_FIELD = 'drain'
// 해시 필드에는 개별 만료가 없다. 값에 시작 시각을 적어두고 이만큼 지난 잠금은
// 죽은 프로세스가 남긴 것으로 보고 뺏는다. desktop_jobs.ts가 잡을 잡는 방식과 같다.
//
// cron 주기(5분)보다 넉넉히 잡는다. 배수 한 번이 API 지연 등으로 5분을 살짝
// 넘기기만 해도 값이 cron 주기와 같으면 바로 다음 틱이 "죽었다"고 보고 뺏어,
// 두 배수가 같은 pending 행을 동시에 집어 같은 임베딩을 두 번 사게 된다.
const LOCK_STALE_MS = 1000 * 60 * 15

const MAX_ATTEMPTS = 5
const vectorLiteral = (v: number[]) => `[${v.join(',')}]`

const indexer = {
  // raw SQL을 타는 유일한 지점. 테스트가 갈아끼운다.
  query: (text: string, params?: unknown[]) => dataSource.query(text, params),

  // 이미 돌고 있으면 null을 준다. 던지지 않는다.
  withLock: async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const now = Date.now()
    let got = await cache.hSetNX(LOCK_KEY, LOCK_FIELD, new Date(now).toISOString())

    if (!got) {
      const held = (await cache.hGetAll(LOCK_KEY))[LOCK_FIELD]
      const startedAt = held ? Date.parse(String(held)) : 0
      if (!startedAt || now - startedAt > LOCK_STALE_MS) {
        await cache.hSet(LOCK_KEY, LOCK_FIELD, new Date(now).toISOString())
        got = true
      }
    }

    if (!got) return null

    try {
      return await fn()
    } finally {
      // 안 풀면 다음 배수가 영원히 못 돈다. fn이 던져도 이 줄은 실행된다.
      await cache.hDel(LOCK_KEY, LOCK_FIELD)
    }
  },

  // 지연을 줄이는 최적화다. 빠뜨려도 훑기가 잡으므로 결과는 달라지지 않는다.
  enqueue: async (postId: number) => {
    try {
      await indexer.query(
        `INSERT INTO embedding_jobs (post_id, status) VALUES ($1, 'pending')
         ON CONFLICT (post_id) DO UPDATE SET status = 'pending', attempts = 0, failed_at = NULL, updated_at = now()`,
        [postId],
      )
    } catch (e) {
      log.error('indexer.enqueue 실패', e)
    }
  },

  // 인덱싱이 필요한 글을 잡으로 만든다. 정합성의 근거는 쓰기 경로가 아니라 여기다.
  // posts.updated_at은 @UpdateDateColumn이라 어느 경로로 고쳐도 TypeORM이 올려준다.
  //
  // 'failed' 잡은 일반 잡과 다르게 취급한다. indexed_at이 NULL인 채로 남아 있어서
  // (j.indexed_at IS NULL OR ...) 조건만 쓰면 5분마다 도는 훑기가 매번 되살려
  // 실패가 확정된 글에 임베딩 API 비용을 계속 태운다. failed_at을 별도로 찍어두고,
  // 글이 그 뒤에 실제로 바뀐 경우(p.updated_at > j.failed_at)에만 되살린다.
  // failed_at이 비어 있는 옛 행(이 컬럼이 생기기 전에 실패한 행)은 j.updated_at을
  // 대신 기준으로 삼는다 - NULL과의 비교는 항상 거짓이라 영영 안 살아나기 때문이다.
  //
  // attempts는 ON CONFLICT에서도 무조건 0으로 두지 않는다. pending 잡은 이
  // 문장에 매번 다시 걸리므로(indexed_at이 아직 NULL이라) 무조건 0으로 두면
  // drain이 올린 시도 횟수를 훑기가 주기마다 지워, 잡이 영원히 failed에
  // 도달하지 못한다 - 애초에 고치려던 비용 누수가 그대로 재현된다. failed였던
  // 잡이 되살아날 때만 0으로 되돌린다.
  sweep: async (limit = 500) => {
    const rows = await indexer.query(
      `INSERT INTO embedding_jobs (post_id, status)
       SELECT p.id, 'pending' FROM posts p
       LEFT JOIN embedding_jobs j ON j.post_id = p.id
       WHERE p.deleted_at IS NULL
         AND p.board_id = ANY($1)
         AND (
           j.id IS NULL
           OR (j.status <> 'failed' AND (j.indexed_at IS NULL OR p.updated_at > j.indexed_at))
           OR (j.status = 'failed' AND p.updated_at > COALESCE(j.failed_at, j.updated_at))
         )
       LIMIT $2
       ON CONFLICT (post_id) DO UPDATE SET
         status = 'pending',
         attempts = CASE WHEN embedding_jobs.status = 'failed' THEN 0 ELSE embedding_jobs.attempts END,
         failed_at = NULL,
         updated_at = now()
       RETURNING post_id`,
      [INDEXED_BOARD_IDS, limit],
    )

    // 지워진 글의 청크를 함께 걷어낸다. 삭제 경로가 이미 지우지만 마지막 방어선이다.
    await indexer.query(
      `DELETE FROM post_chunks c WHERE NOT EXISTS (
         SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.deleted_at IS NULL
       )`,
    )

    return rows.length
  },

  removeChunks: async (postId: number) => {
    try {
      await indexer.query('DELETE FROM post_chunks WHERE post_id = $1', [postId])
      await indexer.query('DELETE FROM embedding_jobs WHERE post_id = $1', [postId])
    } catch (e) {
      log.error('indexer.removeChunks 실패', e)
    }
  },

  // 청크를 넣고 남는 꼬리를 지운다. 글이 짧아졌을 때 옛 청크가 남으면 지워진
  // 내용이 검색에 계속 걸린다.
  replaceChunks: async (
    postId: number,
    boardId: number,
    rows: { content: string, hash: string, vector: number[] | null }[],
  ) => {
    for (let i = 0; i < rows.length; i += 1) {
      const { content, hash, vector } = rows[i]
      await indexer.query(
        `INSERT INTO post_chunks (post_id, board_id, chunk_index, content, content_hash, model, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
         ON CONFLICT (post_id, chunk_index) DO UPDATE
         SET board_id = $2, content = $4, content_hash = $5, model = $6, embedding = $7::vector, updated_at = now()`,
        [postId, boardId, i, content, hash, EMBEDDING_MODEL, vector ? vectorLiteral(vector) : null],
      )
    }

    await indexer.query('DELETE FROM post_chunks WHERE post_id = $1 AND chunk_index >= $2', [postId, rows.length])
  },

  // 잡 하나를 처리한다.
  runJob: async (job: { id: number, post_id: number, attempts: number, content_hash: string | null }) => {
    const [post] = await indexer.query(
      'SELECT id, board_id, title, content FROM posts WHERE id = $1 AND deleted_at IS NULL',
      [job.post_id],
    )

    if (!post) {
      await indexer.removeChunks(job.post_id)
      return
    }

    // 제목을 본문 앞에 붙여 임베딩한다. 자유게시판 글은 짧아 본문만으로는 무엇에
    // 관한 글인지 모르는 경우가 많고, 제목이 그 글에서 가장 압축된 주제 신호다.
    const source = `${post.title || ''}\n\n${post.content || ''}`
    const newHash = computeHash(source)

    // 조회수가 오를 때마다 posts.updated_at도 올라간다(TypeORM 쿼리빌더의 update가
    // @UpdateDateColumn을 자동으로 건드린다). 그래서 내용이 그대로인 인기 글도 훑기가
    // 5분마다 다시 잡는다. 임베딩 캐시 덕에 API 비용은 안 나가지만, 청킹·해시 계산과
    // replaceChunks의 DELETE/UPSERT가 조회수 많은 글 수만큼 매 주기 돈다 - 2 vCPU에
    // 스왑까지 쓰는 상자에서 공짜가 아니다.
    //
    // 해시가 같다고 곧바로 건너뛰면 안 된다. 임베딩이 전부 실패해 던진 뒤 재시도로
    // 들어온 잡은 해시는 이전과 같아도(글은 안 바뀌었으니까) 청크가 없거나 벡터가
    // 비어 있다. 그때 건너뛰면 그 글은 영원히 인덱싱되지 않고 조용히 검색에서
    // 빠진다. 그래서 청크가 실제로 있고 전부 벡터가 채워져 있을 때만 건너뛴다.
    if (job.content_hash && job.content_hash === newHash) {
      // model도 함께 본다. EMBEDDING_MODEL이나 차원을 바꾸면 옛 공간의 벡터를 가진
      // 청크가 여전히 "완전함"으로 세어져, 모델을 바꿔도 인덱스가 안 갈리는
      // 상태가 된다.
      const [state] = await indexer.query(
        `SELECT count(*)::int AS total, (count(*) FILTER (WHERE embedding IS NULL))::int AS missing
         FROM post_chunks WHERE post_id = $1 AND model = $2`,
        [post.id, EMBEDDING_MODEL],
      )

      if (state && Number(state.total) > 0 && Number(state.missing) === 0) {
        await indexer.query(
          `UPDATE embedding_jobs SET status = 'done', indexed_at = now(),
           last_error = NULL, failed_at = NULL, updated_at = now() WHERE id = $1`,
          [job.id],
        )
        return
      }
    }

    const chunks = chunkText(source)
    const vectors = await embedding.embed(chunks, 'RETRIEVAL_DOCUMENT', 'embed_index')

    // embedding.embed는 설계상 던지지 않고 실패한 자리에 null을 채운다 - 검색의
    // 키워드 경로는 임베딩 없이도 동작해야 하기 때문이다. 하지만 그 null을 그대로
    // 받아 done으로 찍으면 두 가지가 어긋난다. (1) 실패한 청크의 해시는 캐시에
    // 없으므로, 조회수만 올라도 도는 다음 훑기가 done인 이 잡을 다시 통째로
    // 돌리다 그 청크에서 또 실패해 진짜 API 호출이 5분마다 영원히 나간다.
    // (2) done으로 남으면 attempts가 안 올라가 영영 failed로도 접히지 않는다 -
    // failed_at으로 막으려던 무한 재시도가 글 하나 단위 대신 청크 하나 단위로
    // 되살아나는 셈이다. 그래서 청크 하나라도 비면(전부든 일부든) 던져서 drain의
    // 기존 재시도 기계(attempts 증가 → 상한이면 failed + failed_at)를 그대로
    // 태운다. replaceChunks를 부르기 전에 던지므로, 이전에 이미 성공해 쌓여 있던
    // 청크는 손대지 않고 그대로 검색에 남는다.
    const nullCount = vectors.filter(v => !v).length
    if (nullCount > 0) {
      throw new Error(`글 ${post.id}의 청크 ${nullCount}/${chunks.length}개가 임베딩되지 않았다`)
    }

    await indexer.replaceChunks(post.id, post.board_id, chunks.map((content, i) => ({
      content,
      hash: computeHash(content),
      vector: vectors[i],
    })))

    // 내용이 안 바뀌어 임베딩을 한 번도 치지 않았어도 indexed_at은 갱신한다.
    // 안 그러면 훑기가 같은 글을 영원히 다시 집는다. failed_at도 여기서 지운다 -
    // 이번에 성공했으므로 예전 실패 흔적이 다음 훑기 판단에 끼면 안 된다.
    await indexer.query(
      `UPDATE embedding_jobs SET status = 'done', content_hash = $2, indexed_at = now(),
       last_error = NULL, failed_at = NULL, updated_at = now() WHERE id = $1`,
      [job.id, newHash],
    )
  },

  drain: async (limit = 20) => {
    const ran = await indexer.withLock(async () => {
      const jobs = await indexer.query(
        `SELECT id, post_id, attempts, content_hash FROM embedding_jobs
         WHERE status = 'pending' AND attempts < $2
         ORDER BY created_at ASC LIMIT $1`,
        [limit, MAX_ATTEMPTS],
      )

      for (const job of jobs) {
        try {
          await indexer.runJob(job)
        } catch (e) {
          const attempts = job.attempts + 1
          const failed = attempts >= MAX_ATTEMPTS
          // 조용히 무한 재시도하면 API 비용만 태운다. failed로 확정되는 순간
          // failed_at을 찍어, 다음 훑기가 글이 실제로 바뀌기 전엔 되살리지 않게 한다.
          // failed_at은 앱 서버의 시계가 아니라 DB의 now()로 찍는다 - 이 값은
          // posts.updated_at(역시 DB에서 찍힌 값)과 비교되는데, 앱 호스트와 DB의
          // 시계가 어긋나면 그 비교 기준 자체가 밀린다.
          await indexer.query(
            `UPDATE embedding_jobs SET attempts = $2, last_error = $3,
             status = $4, failed_at = CASE WHEN $4 = 'failed' THEN now() END, updated_at = now() WHERE id = $1`,
            [job.id, attempts, (e || {}).message || String(e), failed ? 'failed' : 'pending'],
          )
          log.error(`indexer: 잡 ${job.id}(post ${job.post_id}) 실패`, e)
        }
      }

      return jobs.length
    })

    return ran || 0
  },
}

export default indexer
