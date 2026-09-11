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
const LOCK_STALE_MS = 1000 * 60 * 5

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
           OR (j.status = 'failed' AND p.updated_at > j.failed_at)
         )
       LIMIT $2
       ON CONFLICT (post_id) DO UPDATE SET status = 'pending', attempts = 0, failed_at = NULL, updated_at = now()
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
  runJob: async (job: { id: number, post_id: number, attempts: number }) => {
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
    const chunks = chunkText(source)
    const vectors = await embedding.embed(chunks, 'RETRIEVAL_DOCUMENT', 'embed_index')

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
      [job.id, computeHash(source)],
    )
  },

  drain: async (limit = 20) => {
    const ran = await indexer.withLock(async () => {
      const jobs = await indexer.query(
        `SELECT id, post_id, attempts FROM embedding_jobs
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
          await indexer.query(
            `UPDATE embedding_jobs SET attempts = $2, last_error = $3,
             status = $4, failed_at = $5, updated_at = now() WHERE id = $1`,
            [job.id, attempts, (e || {}).message || String(e), failed ? 'failed' : 'pending', failed ? new Date() : null],
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
