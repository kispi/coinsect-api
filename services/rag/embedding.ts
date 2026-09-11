import { createHash } from 'crypto'
import { GoogleGenAI } from '@google/genai'
import { dataSource } from '../../database'
import { log } from '../../core/logger'
import store from '../../store'
import aiUsage from '../ai_usage'

// 3072이 원본이지만 pgvector의 HNSW 인덱스는 2000차원이 상한이라 1536으로 뽑는다.
// 768로 줄이면 미세한 구분이 먼저 사라지고 굵은 주제 축만 남아, 무관한 문서끼리도
// 점수가 붙는다.
export const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMS = 1536

// 한 요청에 묶어 보낼 청크 수. embedContent의 contents는 배열을 받고 embeddings를
// 넣은 순서 그대로 돌려준다. 하나씩 치면 6,000청크가 6,000요청이다.
//
// 이 값은 모델마다 다른 상한에 걸릴 수 있다. 400이 나면 줄일 것.
// 2026-09-11: API 키가 없는 환경이라 실제 호출로 상한을 확인하지 못했다. 32는
// 검증되지 않은 값이다 - 백필을 돌리기 전에 반드시 실제 호출로 확인할 것.
export const EMBED_BATCH_SIZE = 32

export type TypeEmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

// 문서와 질의는 다른 벡터를 만든다. 섞으면 관련·무관의 점수 간격이 좁아진다.
export const cacheTaskOf = (task: TypeEmbedTask) => (task === 'RETRIEVAL_QUERY' ? 'q' : 'd')

export const computeHash = (text: string) => createHash('sha256').update((text || '').trim()).digest('hex')

// 축소 차원은 사전 정규화가 되어 있지 않다. 안 하면 코사인 거리 연산이 어긋난다.
export const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? v : v.map(x => x / norm)
}

// 임베딩 응답에는 생성 호출과 달리 usageMetadata가 없다. 비용을 세려면 추정해야 한다.
// 한국어는 대략 1.5자에 1토큰이다. 정확한 값이 아니라 자릿수를 맞추는 용도다.
export const estimateTokens = (text: string) => Math.ceil((text || '').length / 1.5)

const vectorLiteral = (v: number[]) => `[${v.join(',')}]`

const embedding = {
  // API를 타는 유일한 지점. 테스트가 갈아끼운다.
  callApi: async (texts: string[], task: TypeEmbedTask): Promise<number[][]> => {
    const genAI = new GoogleGenAI({ apiKey: store.state.serverConfig.GOOGLE_AI_STUDIO })
    const result = await genAI.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: { outputDimensionality: EMBEDDING_DIMS, taskType: task },
    })

    return (result.embeddings || []).map(e => normalize(e.values || []))
  },

  getCached: async (hashes: string[], task: TypeEmbedTask): Promise<Map<string, number[]>> => {
    if (!hashes.length) return new Map()

    const rows = await dataSource.query(
      `SELECT content_hash, embedding::text AS embedding FROM embedding_cache
       WHERE model = $1 AND dims = $2 AND task = $3 AND content_hash = ANY($4)`,
      [EMBEDDING_MODEL, EMBEDDING_DIMS, cacheTaskOf(task), hashes],
    )

    return new Map(rows.map(r => [
      r.content_hash,
      JSON.parse(r.embedding) as number[],
    ]))
  },

  putCached: async (entries: { hash: string, vector: number[] }[], task: TypeEmbedTask) => {
    for (const { hash, vector } of entries) {
      await dataSource.query(
        `INSERT INTO embedding_cache (content_hash, model, dims, task, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (content_hash, model, dims, task) DO NOTHING`,
        [hash, EMBEDDING_MODEL, EMBEDDING_DIMS, cacheTaskOf(task), vectorLiteral(vector)],
      )
    }
  },

  // 캐시를 먼저 보고, 없는 것만 배치로 친다. 입력 순서 그대로 돌려준다.
  // 실패하면 던지지 않고 그 자리에 null을 둔다 - 임베딩이 안 되어도 검색의
  // 키워드 경로는 계속 동작해야 한다.
  embed: async (texts: string[], task: TypeEmbedTask, aiTask: 'embed_index' | 'embed_query' = 'embed_index') => {
    const hashes = texts.map(computeHash)
    const cached = await embedding.getCached(hashes, task).catch(e => {
      log.error('embedding 캐시 조회 실패', e)
      return new Map<string, number[]>()
    })

    const out: (number[] | null)[] = texts.map((_, i) => cached.get(hashes[i]) || null)
    const missing = texts
      .map((text, i) => ({ text, i, hash: hashes[i] }))
      .filter(o => !out[o.i])

    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE)
      const startedAt = Date.now()

      try {
        const vectors = await embedding.callApi(batch.map(o => o.text), task)

        batch.forEach((o, k) => { out[o.i] = vectors[k] || null })
        await embedding.putCached(
          batch.map((o, k) => ({ hash: o.hash, vector: vectors[k] })).filter(o => o.vector),
          task,
        )

        // 행은 요청당 하나다. 청크마다 남기면 호출 수가 실제와 어긋난다.
        void aiUsage.record({
          task: aiTask,
          model: EMBEDDING_MODEL,
          inputTokens: batch.reduce((sum, o) => sum + estimateTokens(o.text), 0),
          latencyMs: Date.now() - startedAt,
        })
      } catch (e) {
        log.error('embedding 호출 실패', e)
        void aiUsage.record({
          task: aiTask,
          model: EMBEDDING_MODEL,
          latencyMs: Date.now() - startedAt,
          ok: false,
          error: (e || {}).message || String(e),
        })
      }
    }

    return out
  },
}

export default embedding
