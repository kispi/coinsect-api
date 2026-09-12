import { FastifyInstance } from 'fastify'
import { useRouter } from './core/router'
import helpers from './core/helpers'
import middlewares from './core/middlewares'
import useControllers from './controllers'

const ctrls = useControllers()

const useRouteCRUD = ({ app, model, middleware = middlewares.auth.admin.super }) => {
  const router = useRouter(app)

  const sp = helpers.case.pluralize(helpers.case.toSnake(model))

  router.post(`/admin/${sp}`, ctrls.admin[model].create, middleware)
  router.get(`/admin/${sp}`, ctrls.admin[model].all, middleware)
  router.get(`/admin/${sp}/:id`, ctrls.admin[model].detail, middleware)
  router.put(`/admin/${sp}/:id`, ctrls.admin[model].update, middleware)
  router.delete(`/admin/${sp}/:id`, ctrls.admin[model].delete, middleware)
}

export const useRoutes = (app: FastifyInstance) => ({
  admin: () => {
    const router = useRouter(app)

    router.post('/admin/chat/ban_ip', ctrls.admin.chat.banIP, middlewares.auth.admin.manager) // 단순 채금
    router.post('/admin/chat/create_banned_user', ctrls.admin.chat.createBannedUser, middlewares.auth.admin.manager) // 광고, 도배충들 용도 (메시지도 다 지움)
    router.post('/admin/chat/send_message', ctrls.admin.chat.sendMessage, middlewares.auth.admin.manager)
    router.post('/admin/force_refresh', ctrls.admin.forceRefresh, middlewares.auth.admin.super)

    router.get('/admin/store/bad_words', ctrls.admin.store.badWord.all, middlewares.auth.admin.super)
    router.get('/admin/store/banned_users', ctrls.admin.store.bannedUser.all, middlewares.auth.admin.manager)
    router.post('/admin/store/bad_words/invalidate', ctrls.admin.store.badWord.invalidate, middlewares.auth.admin.super)
    router.post('/admin/store/banned_users/invalidate', ctrls.admin.store.bannedUser.invalidate, middlewares.auth.admin.manager)
    router.post('/admin/store/messages/invalidate', ctrls.admin.store.message.invalidate, middlewares.auth.admin.manager)

    router.get('/admin/crons', ctrls.admin.cron.all, middlewares.auth.admin.super)
    router.get('/admin/ai_usage', ctrls.admin.aiUsage.all, middlewares.auth.admin.super)
    router.get('/admin/ai_usage/today', ctrls.admin.aiUsage.today, middlewares.auth.admin.super)

    router.get('/admin/contents/real_time_positions/change_notifications', ctrls.content.realTimePositions.changeNotification.all, middlewares.auth.admin.position)
    router.get('/admin/contents/real_time_positions/presets', ctrls.content.realTimePositions.presets, middlewares.auth.admin.position)
    router.post('/admin/contents/real_time_positions', ctrls.content.realTimePositions.set, middlewares.auth.admin.position)
    router.post('/admin/contents/real_time_positions/auto_parse', ctrls.content.realTimePositions.autoParse, middlewares.auth.admin.position)
    router.get('/admin/contents/real_time_positions/desktop_jobs', ctrls.content.realTimePositions.desktopJobs, middlewares.auth.admin.position)
    router.delete('/admin/contents/real_time_positions/:id', ctrls.content.realTimePositions.delete, middlewares.auth.admin.position)

    router.put('/admin/helpers/crawled_websites', ctrls.helper.crawledWebsites.delete, middlewares.auth.admin.super) // DELETE 메소드는 request body를 가질 수 없어서 put으로
    router.get('/admin/helpers/crawled_websites', ctrls.helper.crawledWebsites.all, middlewares.auth.admin.super)

    router.get('/admin/aws/rekognition/image_moderation', ctrls.aws.rekognition.imageModeration.all, middlewares.auth.admin.super)
    router.put('/admin/aws/rekognition/image_moderation', ctrls.aws.rekognition.imageModeration.delete, middlewares.auth.admin.super) // DELETE 메소드는 request body를 가질 수 없어서 put으로
    router.put('/admin/aws/rekognition/image_moderation/delete_bulk', ctrls.aws.rekognition.imageModeration.deleteBulk, middlewares.auth.admin.super)

    useRouteCRUD({ app, model: 'badWord' })
    useRouteCRUD({ app, model: 'bannedUser', middleware: middlewares.auth.admin.manager })
    useRouteCRUD({ app, model: 'blockchain' })
    useRouteCRUD({ app, model: 'board' })
    useRouteCRUD({ app, model: 'image' })
    useRouteCRUD({ app, model: 'message', middleware: middlewares.auth.admin.manager })
    useRouteCRUD({ app, model: 'notification' })
    useRouteCRUD({ app, model: 'person' })
    useRouteCRUD({ app, model: 'post' })
    useRouteCRUD({ app, model: 'profile' })
    useRouteCRUD({ app, model: 'reaction' })
    useRouteCRUD({ app, model: 'reply' })
    useRouteCRUD({ app, model: 'user' })
    useRouteCRUD({ app, model: 'wallet' })
    useRouteCRUD({ app, model: 'whaleAlert' })
  },
  service: () => {
    const router = useRouter(app)

    router.get('/config', ctrls.config.get)
    router.post('/config', ctrls.config.post)

    router.get('/dashboards/activities', ctrls.dashboard.activities)
    router.get('/dashboards/main', ctrls.dashboard.main)

    router.get('/wallets', ctrls.wallet.all)

    router.post('/users/sign_in', ctrls.auth.signIn)
    router.post('/users/sign_in_kakao', ctrls.auth.signInKakao)

    router.get('/users/me', ctrls.user.me)
    router.get('/users/me/stats', ctrls.user.myStats)
    router.get('/users/:id/stats', ctrls.user.stats)

    router.get('/persons', ctrls.person.all)

    router.get('/boards', ctrls.board.all)

    router.get('/posts/with_llm', ctrls.post.allWithLLM)
    router.get('/posts/search', ctrls.post.search)
    router.get('/posts', ctrls.post.all)
    router.get('/posts/:sharingKey', ctrls.post.detail)
    router.get('/posts/:sharingKey/related', ctrls.post.related)
    router.get('/posts/sitemap/:boardId', ctrls.post.sitemap)
    router.post('/posts', ctrls.post.create)
    router.put('/posts/:sharingKey', ctrls.post.update)
    router.post('/posts/:sharingKey/check_password', ctrls.post.checkPassword)
    router.delete('/posts/:sharingKey', ctrls.post.delete)

    router.post('/replies', ctrls.reply.create)
    router.delete('/replies/:id', ctrls.reply.delete)
    router.post('/replies/:id/check_password', ctrls.reply.checkPassword)
    router.post('/reactions/posts', ctrls.reaction.toggle.post)
    router.post('/reactions/replies', ctrls.reaction.toggle.reply)
    router.post('/reactions/messages', ctrls.reaction.toggle.message)

    router.get('/price_predictions', ctrls.pricePrediction.all)
    router.get('/price_predictions/:sharingKey', ctrls.pricePrediction.detail)
    router.post('/price_predictions', ctrls.pricePrediction.create)
    router.post('/price_predictions/:sharingKey/check_password', ctrls.post.checkPassword)
    router.delete('/price_predictions/:sharingKey', ctrls.post.delete)

    router.get('/market_info/leaderboard', ctrls.marketInfo.leaderboard)
    router.get('/market_info/indices', ctrls.marketInfo.indices)
    router.get('/market_info/symbols', ctrls.marketInfo.symbols)
    router.get('/market_info/markets', ctrls.marketInfo.markets)
    router.get('/market_info/crypto', ctrls.marketInfo.crypto)
    router.get('/market_info/nasdaq', ctrls.marketInfo.nasdaq)
    router.get('/market_info/kospi', ctrls.marketInfo.kospi)
    router.get('/market_info/assets_including_metal', ctrls.marketInfo.assetsIncludingMetal)

    // 구 goapi(별도 Go 서버, /goapi/*)에서 옮겨온 정적 데이터다. nginx가 api.coinsect.io/goapi/를
    // localhost:3000으로 프록시하던 구간이 사라지고 이 라우트가 대신한다.
    router.get('/contents/bitcoin_quotes', ctrls.content.bitcoinQuotes)
    router.get('/contents/countries', ctrls.content.countries)
    router.get('/contents/prices', ctrls.content.prices)

    router.get('/contents/real_time_positions', ctrls.content.realTimePositions.all)
    router.post('/contents/real_time_positions/change_notifications', ctrls.content.realTimePositions.changeNotification.create)
    // 어드민과 사용자가 같이 쓴다. 신원을 묻지 않는 대신 스트리머 단위 쿨다운과 전체
    // 총량으로 묶고, 운영자 토큰이 실려 있으면 그 제한을 면제한다
    // (services/content/desktop_jobs.ts 주석 참고).
    router.post('/contents/real_time_positions/:id/capture', ctrls.content.realTimePositions.enqueueCapture)
    router.get('/contents/real_time_positions/desktop_targets', ctrls.content.realTimePositions.desktopTargets, middlewares.auth.desktop)
    router.post('/contents/real_time_positions/desktop_report', ctrls.content.realTimePositions.desktopReport, middlewares.auth.desktop)
    router.post('/contents/real_time_positions/desktop_jobs', ctrls.content.realTimePositions.pollDesktopJobs, middlewares.auth.desktop)

    router.post('/slack/interactions', ctrls.content.realTimePositions.slackInteraction)

    router.get('/contents/news/upbit', ctrls.content.news.upbit)

    router.get('/onchain/whale_alert', ctrls.onchain.whaleAlert)

    router.post('/helpers/crawled_websites', ctrls.helper.crawledWebsites.create)
    router.get('/helpers/crawled_websites/examples', ctrls.helper.crawledWebsites.examples)
    router.post('/helpers/proxy', ctrls.helper.proxy)

    router.get('/notifications', ctrls.notification.all)

    router.post('/firebase/messaging', ctrls.firebase.send)

    router.get('/aws/s3/upload_url', ctrls.aws.s3.getSignedUrl)
    router.delete('/aws/s3/object', ctrls.aws.s3.deleteObject)

    router.get('/aws/rekognition/image_moderation/examples', ctrls.aws.rekognition.imageModeration.examples)
    router.post('/aws/rekognition/image_moderation', ctrls.aws.rekognition.imageModeration.create)
  },
})

export default useRoutes