import cron from '../core/cron'
import walletService from './wallet'
import chatService from './chat'
import whaleAlertService from './onchain/whale_alert'
import marketInfoService from './market_info'
import dashboardService from './dashboard'

const failableCrawl = (minValue: number) => {
  whaleAlertService.crawl(minValue).then().catch(() => {})
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
    cron.run()
  },
}

export default cronService