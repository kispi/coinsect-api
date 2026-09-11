// 기존 글을 전부 인덱싱한다. cron에 맡기면 5분에 20건이라 1,713건에 일곱 시간이
// 걸리는데, 그건 API가 느려서가 아니라 우리가 정한 페이싱 때문이다. 직접 돈다.
//
//   GOOGLE_AI_STUDIO=<키> npx ts-node tools/backfill_post_embeddings.ts
//
// 같은 잠금을 쓰므로 cron이나 글쓰기가 끼어들어 같은 잡을 두 번 처리하지 않는다.
// 중간에 죽어도 잡이 pending으로 남아 이어서 돈다.
import { dataSource } from '../database'
import indexer from '../services/rag/indexer'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// drain()은 "더 처리할 잡이 없다"와 "다른 프로세스가 잠금을 쥐고 있다"는 서로 다른
// 두 상황 모두에서 0을 돌려준다 - withLock이 잠금을 못 얻으면 null을 주고, drain은
// 그걸 `ran || 0`으로 접어버려 호출부에서는 구분이 안 된다. cron이 5분마다 같은
// 잠금을 잡으므로, 이 스크립트를 그 틈에 시작하면 첫 drain이 곧바로 0을 주는 일이
// 흔하다. `while (processed) { ... }`처럼 그 값만 보고 반응하면 아직 수천 건이
// 남았는데도 "끝났다"고 착각해 조용히 종료해버린다 - 운영자는 백필이 다 됐다고
// 믿지만 실제로는 거의 손도 안 댄 상태다. pending 잡이 실제로 남아 있는지 DB에
// 직접 물어 두 상황을 구분한다.
const pendingCount = async () => {
  const [{ count }] = await indexer.query(
    `SELECT count(*)::int AS count FROM embedding_jobs WHERE status = 'pending'`,
  )
  return Number(count)
}

// 잠금이 죽은 프로세스가 남긴 것이면 LOCK_STALE_MS(15분) 뒤 indexer.withLock이
// 알아서 뺏는다. 그보다 훨씬 오래 잠금을 못 얻으면 잠금 경합이 아니라 다른 문제
// (DB 연결 실패, cron이 계속 앞서 도는 등)로 봐야 하므로 무한정 기다리지 않는다.
const MAX_IDLE_RETRIES = 40
const IDLE_RETRY_MS = 30_000 // 40회 x 30초 = 최대 20분 대기

const run = async () => {
  await dataSource.initialize()

  const startedAt = Date.now()
  const queued = await indexer.sweep(100000)
  console.log(`인덱싱 대상 ${queued}건`)

  let done = 0
  let idleStreak = 0
  for (;;) {
    const processed = await indexer.drain(50)

    if (processed) {
      idleStreak = 0
      done += processed
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`${done}/${queued} — ${elapsed}초`)
      continue
    }

    // processed === 0. pending이 실제로 0이어야 진짜로 끝난 것이다.
    const remaining = await pendingCount()
    if (remaining === 0) break

    idleStreak += 1
    if (idleStreak > MAX_IDLE_RETRIES) {
      console.error(
        `잠금을 ${Math.round((MAX_IDLE_RETRIES * IDLE_RETRY_MS) / 60000)}분 넘게 못 얻었다. ` +
        `pending ${remaining}건이 아직 남아 있다 - 다른 프로세스나 DB 상태를 확인할 것.`,
      )
      process.exit(1)
    }

    console.log(
      `잠금이 다른 프로세스(cron 등)에 있는 듯 - pending ${remaining}건 남음, ` +
      `${Math.round(IDLE_RETRY_MS / 1000)}초 뒤 재시도 (${idleStreak}/${MAX_IDLE_RETRIES})`,
    )
    await sleep(IDLE_RETRY_MS)
  }

  const [{ count }] = await dataSource.query('SELECT count(*) FROM post_chunks WHERE embedding IS NOT NULL')
  console.log(`끝. 청크 ${count}개, ${Math.round((Date.now() - startedAt) / 1000)}초`)
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
