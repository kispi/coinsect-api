import { createHash } from 'crypto'
import { GoogleGenAI } from '@google/genai'
import { dataSource } from '../../database'
import { log } from '../../core/logger'
import useCache from '../../core/cache'
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

// 질의 임베딩은 Postgres에 남기지 않는다. 문서 임베딩(task = 'd')만 embedding_cache에
// 영구히 쌓고, 질의(task = 'q')는 core/cache(운영은 레디스, 그 외 메모리)에 짧게 둔다.
//
// 이유는 용량이다. embedding_cache에서 지우는 경로가 없는데 질의는 인증 없는 공개
// 경로에서 들어온다. /posts/search의 전역 한도가 분당 120회이므로 상한까지 두드리면
// 하루 172,800행이고, vector(1536)은 행당 6,152바이트에 오버헤드가 붙어 하루 약 1GB씩
// 영원히 늘어난다. 디스크가 차면 Postgres가 멈추고 검색이 아니라 사이트 전체가 죽는다.
// 한 디스크에 Postgres·레디스·Typesense·Grafana가 같이 사는 상자라 여유도 없다.
export const QUERY_CACHE_TTL_SECONDS = 600

// 표의 복합 PK(content_hash, model, dims, task)를 그대로 키에 편다. dims와 task를
// 빼면 차원이나 taskType을 바꾼 뒤에도 옛 벡터가 돌아오고, 그 벡터는 새로 만든
// 것들과 같은 공간에 있지 않아 검색이 조용히 망가진다.
export const queryCacheKey = (hash: string, task: TypeEmbedTask) =>
  `embedding:${EMBEDDING_MODEL}:${EMBEDDING_DIMS}:${cacheTaskOf(task)}:${hash}`

export const computeHash = (text: string) => createHash('sha256').update((text || '').trim()).digest('hex')

// 축소 차원은 사전 정규화가 되어 있지 않다. 안 하면 코사인 거리 연산이 어긋난다.
export const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? v : v.map(x => x / norm)
}

// 임베딩 응답에는 생성 호출과 달리 usageMetadata가 없다. 비용을 세려면 추정해야 한다.
// 한국어는 대략 1.5자에 1토큰이다. 정확한 값이 아니라 자릿수를 맞추는 용도다.
//
// 이 셈으로 200자 질의는 약 134토큰이고, $0.15/1M이면 호출당 약 20마이크로달러
// ($0.00002)다. 질의 캐시가 아끼는 것은 이 돈이 아니라 지연과 호출 수다 - 캐시를
// 어디에 둘지는 비용이 아니라 용량으로 정해야 한다(위 QUERY_CACHE_TTL_SECONDS 주석).
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

  // 질의 캐시는 최적화일 뿐 진실의 출처가 아니다. 읽기든 쓰기든 레디스가 죽으면
  // 그냥 API를 치면 된다 - 여기서 던지면 캐시 장애가 검색 장애가 된다.
  getCachedQuery: async (hashes: string[], task: TypeEmbedTask): Promise<Map<string, number[]>> => {
    const cache = useCache()
    const found = new Map<string, number[]>()

    await Promise.all(hashes.map(async hash => {
      try {
        const value = await cache.get(queryCacheKey(hash, task))
        if (Array.isArray(value) && value.length === EMBEDDING_DIMS) found.set(hash, value)
      } catch (e) {
        log.error('embedding 질의 캐시 조회 실패', e)
      }
    }))

    return found
  },

  putCachedQuery: async (entries: { hash: string, vector: number[] }[], task: TypeEmbedTask) => {
    const cache = useCache()

    await Promise.all(entries.map(async ({ hash, vector }) => {
      try {
        // 10분이다. 1536 float를 JSON으로 적으면 약 30KB이므로 분당 120회 상한을
        // 계속 두드려도 10분 창에 약 36MB다. 한 시간으로 늘리면 200MB가 넘는데,
        // 이미 스왑을 쓰는 상자에서 레디스가 그만큼을 더 쥐고 있으면 안 된다.
        await cache.set(queryCacheKey(hash, task), vector, QUERY_CACHE_TTL_SECONDS)
      } catch (e) {
        log.error('embedding 질의 캐시 적재 실패', e)
      }
    }))
  },

  getCached: async (hashes: string[], task: TypeEmbedTask): Promise<Map<string, number[]>> => {
    if (!hashes.length) return new Map()
    if (task === 'RETRIEVAL_QUERY') return embedding.getCachedQuery(hashes, task)

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
    if (task === 'RETRIEVAL_QUERY') return embedding.putCachedQuery(entries, task)

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
        // 같은 배치 안에 같은 텍스트가 두 번 있을 수 있다(같은 글이 여러 청크의
        // 겹침으로 다시 등장하는 경우 등). 해시로 묶어 API에는 한 번만 보낸다 -
        // 안 그러면 토큰 추정이 두 배로 잡혀 비용 로그가 부풀려진다.
        const uniqueHashes = [...new Set(batch.map(o => o.hash))]
        const textByHash = new Map(batch.map(o => [o.hash, o.text]))
        const uniqueTexts = uniqueHashes.map(h => textByHash.get(h) as string)

        const vectors = await embedding.callApi(uniqueTexts, task)
        if (vectors.length !== uniqueTexts.length) {
          // 조용히 나머지를 null로 채우면 왜 짧아졌는지 알 길이 없다.
          log.error('embedding 응답 길이가 요청보다 짧다', { expected: uniqueTexts.length, got: vectors.length })
        }

        const vectorByHash = new Map<string, number[]>()
        uniqueHashes.forEach((h, k) => { if (vectors[k]) vectorByHash.set(h, vectors[k]) })
        batch.forEach(o => { out[o.i] = vectorByHash.get(o.hash) || null })

        // 캐시 쓰기는 따로 감싼다. API 호출은 이미 성공해 out이 채워졌는데 여기서
        // 던지면 바깥 catch로 빠져 성공한 호출이 실패로 집계되고, 실패율/비용
        // 통계가 둘 다 어긋난다. 캐시 실패는 로그만 남기고 다음 호출에서 다시
        // 채워질 것에 맡긴다.
        try {
          await embedding.putCached(
            uniqueHashes.map(h => ({ hash: h, vector: vectorByHash.get(h) as number[] })).filter(o => o.vector),
            task,
          )
        } catch (e) {
          log.error('embedding 캐시 적재 실패', e)
        }

        // 행은 요청당 하나다. 청크마다 남기면 호출 수가 실제와 어긋난다.
        // 토큰도 실제로 보낸 유니크 텍스트 기준으로 센다.
        void aiUsage.record({
          task: aiTask,
          model: EMBEDDING_MODEL,
          inputTokens: uniqueTexts.reduce((sum, t) => sum + estimateTokens(t), 0),
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

  // 이 변경 전에 쓰인 질의 행을 걷어내는 안전망이다. 지금은 질의가 embedding_cache로
  // 들어가지 않지만, 이미 쌓인 행은 지우는 경로가 없으면 영원히 남는다. 야간에 한 번
  // 돈다. 지울 것이 없으면 0행이라 매일 돌아도 무해하다.
  pruneQueryCache: async () => {
    try {
      const rows = await dataSource.query(
        `WITH deleted AS (DELETE FROM embedding_cache WHERE task = 'q' RETURNING 1)
         SELECT count(*)::int AS n FROM deleted`,
      )
      const deleted = Number((rows[0] || {}).n || 0)
      if (deleted) log.info(`embedding.pruneQueryCache: ${deleted}행`)
      return deleted
    } catch (e) {
      log.error('embedding.pruneQueryCache 실패', e)
      return 0
    }
  },
}

export default embedding
