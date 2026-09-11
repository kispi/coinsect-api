import cron from '../core/cron'
import walletService from './wallet'
import chatService from './chat'
import whaleAlertService from './onchain/whale_alert'
import marketInfoService from './market_info'
import dashboardService from './dashboard'
import aiUsage from './ai_usage'

const failableCrawl = (minValue: number) => {
  whaleAlertService.crawl(minValue).then().catch(() => {})
}

// 어제치를 접고 90일 지난 원본을 지운다. 집계는 덮어쓰기, 정리는 컷오프 DELETE라
// 여러 번 돌아도 안전하다.
const rollupAiUsageJob = async () => {
  await aiUsage.rollup()
  await aiUsage.prune()
}

const cronService = {
  run: () => {
    cron.addJob({
      id: 'renewWalets',
      runnable: walletService.renewAll,
      interval: 1000 * 60 * 30,
    })
    cron.addJob({
      id: 'deleteOldChatUsers',
      runnable: () => chatService.deleteOldUsers(48),
      interval: 1000 * 60 * 30,
    })
    cron.addJob({
      id: 'crawlWhaleAlerts',
      runnable: () => {
        // 이 수치가 너무 작으면 limit 100 안에서 계속 크롤링 안되고 밀림
        failableCrawl(10000000)
        setTimeout(() => failableCrawl(5000000), 1000 * 20)
        setTimeout(() => failableCrawl(3000000), 1000 * 40)
      },
      interval: 1000 * 60 * 2,
    })
    cron.addJob({
      id: 'refreshMarketInfoInAdvance', // 사람들이 콜할때 업데이트하게 하지말고(바이낸스가 느림) 미리 주기적으로 캐시해둠
      runnable: () => {
        marketInfoService.symbols(true)
        marketInfoService.markets(true)
        dashboardService.main(true)
      },
      interval: 1000 * 60,
    })
    cron.addJob({
      id: 'rollupAiUsage',
      runnable: rollupAiUsageJob,
      interval: 1000 * 60 * 60 * 24,
    })
    // core/cron의 setInterval은 선행 호출 없이 주기만 건다. 24시간 주기 작업은
    // 프로세스가 24시간 넘게 연속으로 살아야 처음 한 번 돈다. 이 레포는 배포마다
    // 재시작하는 pm2 단일 프로세스라, 하루보다 잦게 배포하면 이 작업은 영영 안 돈다.
    // 그래서 기동 시에도 한 번 던져둔다 - rollup은 덮어쓰기, prune은 컷오프 DELETE라
    // 둘 다 멱등이므로 주기 실행과 겹쳐도 무해하다. 서버 기동을 붙잡으면 안 되므로
    // 기다리지 않는다.
    rollupAiUsageJob().catch(() => {})
    cron.run()
  },
}

export default cronService