import axios from 'axios'
import slack from './slack'
import { log } from '../core/logger'
import { HTMLElement, parse } from 'node-html-parser'
import { dataSource } from '../database'
import { Wallet } from '../entities/wallet'

const walletHelpers = {
  // wallet.balance === NULL 인 경우를 위해 디폴트를 0으로 설정
  asCryptoBalance: (balance: number) => (balance || 0).toLocaleString(undefined, {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }),
  domToFloat: (dom: HTMLElement, delim?: string) => parseFloat((dom.innerHTML || '').split(delim)[0]),
}

const crawlBalance = {
  BTC: (doc: HTMLElement) => {
    const dom = doc.querySelectorAll('.sc-1ryi78w-0.cILyoi.sc-16b9dsl-1.ZwupP.u3ufsr-0.eQTRKC')[5]
    if (dom) return walletHelpers.domToFloat(dom, ' BTC')
  },
  ETH: (doc: HTMLElement) => {
    const dom = doc.querySelectorAll('.col-md-8')[0]
    if (dom) return walletHelpers.domToFloat(dom, ' Ether')
  },
  BCH: (doc: HTMLElement) => crawlBalance.BTC(doc), // 비트랑 똑같
  LTC: (doc: HTMLElement) => {
    const dom = doc.querySelectorAll('p.title.is-5')[1]
    if (dom) return walletHelpers.domToFloat(dom, ' LTC')
  },
  EOS: () => {},
  DOGE: (doc: HTMLElement) => {
    const dom = doc.querySelectorAll('p.title.is-5')[1]
    if (dom) return walletHelpers.domToFloat(dom, ' LTC')
  },
  GRS: (doc: HTMLElement) => {
    const dom = doc.querySelectorAll('p.title.is-5')[1]
    if (dom) return walletHelpers.domToFloat(dom, ' LTC')
  },
  ZEC: () => {},
  XMR: () => {},
}

const throughApi = (wallet: Wallet) => {
  return {
    XRP: async () => {
      try {
        const { xrpBalance }: any = await axios.get(`https://api.xrpscan.com/api/v1/account/${wallet.address}`)
        return xrpBalance
      } catch (e) {
        return Promise.reject(e)
      }
    },
    XLM: async () => {
      try {
        const { balances }: any = await axios.get(`https://horizon.stellar.org/accounts/${wallet.address}`)
        const xlm = balances.find(b => b.asset_type === 'native')
        if (xlm) return xlm.balance
      } catch (e) {
        return Promise.reject(e)
      }
    },
    TRX: async () => {
      try {
        const data = await axios.get(`https://apilist.tronscanapi.com/api/accountv2?address=${wallet.address}`)
        return data['withPriceTokens'][0].amount
      } catch (e) {
        return Promise.reject(e)
      }
    },
  }
}

const scrape = async ({ html = '' as string, wallet = null as Wallet }): Promise<number> => {
  try {
    const selector = crawlBalance[wallet.blockchain.symbol]
    if (!selector) return Promise.reject({ message: `scrape: crawlBalance for ${wallet.blockchain.symbol} is not defined` })

    const balance = crawlBalance[wallet.blockchain.symbol](parse(html))
    if (isNaN(balance)) return Promise.reject({ message: 'scrape: balance is NaN. maybe dom innerHTML has changed?' })

    return Promise.resolve(balance)
  } catch (e) {
    return Promise.reject(e)
  }
}

const floatify = value => typeof value === 'string' ? parseFloat(value) : value

const nameToDashed = (name: string) => name.replace(/ /g, '-').toLowerCase()

const walletService = {
  // 블록체인 익스플로러 사이트를 폴링해서 잔고를 업데이트한다.
  renewBalance: async (wallet: Wallet) => {
    try {
      // typeorm의 default설정은 bigNumberString: on이기 때문
      const originalBalance = floatify(wallet.balance)
      wallet.balance = floatify(await walletService.poll(wallet))
      await dataSource.getRepository(Wallet).save(wallet)
      const before = walletHelpers.asCryptoBalance(originalBalance)
      const after = walletHelpers.asCryptoBalance(wallet.balance)
      return {
        url: wallet.exploreUrl(),
        symbol: wallet.blockchain.symbol,
        before,
        after,
        price: wallet.blockchain['$$price'],
      }
    } catch (e) {
      return Promise.reject(e)
    }
  },
  renewAll: async () => {
    log.info('walletService.renewAll: updating wallets...')
    try {
      const wallets = await walletService.all()
      const data = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${wallets.map(w => nameToDashed(w.blockchain.name))}&vs_currencies=usd,krw,btc`)
      if (data) wallets.forEach(wallet => {
        const price = data[nameToDashed(wallet.blockchain.name)] || {}
        wallet.blockchain['$$price'] = {
          usd: price.usd,
          krw: price.krw,
          btc: price.btc,
        }
      })

      const settled = await Promise.allSettled(wallets.map(walletService.renewBalance))
      const result = settled.filter(o => o.status === 'fulfilled' && o['value']).map(o => o['value'])
      const changed = result.filter(row => row.before !== row.after)
      if (changed.length === 0) return

      const total = { usd: 0, krw: 0, btc: 0 }
      result.map(row => {
        const b = parseFloat(row.after) || 0
        return {
          usd: row.price.usd * b,
          krw: row.price.krw * b,
          btc: row.price.btc * b,
        }
      }).forEach(row => {
        total.usd += (row.usd || 0)
        total.krw += (row.krw || 0)
        total.btc += (row.btc || 0)
      })

      slack.postMessage({
        text: `
          잔고가 변경된 크립토가 있습니다. (${changed.map(wallet => wallet.symbol).join(', ')})\n
          ${result.map(row => `<${row.url}|${row.symbol}: ${row.before} =&gt; ${row.after}>`).join('\n')}\n
          총 잔고: ${total.usd.toFixed(2)} USD = ${total.krw.toFixed(0)} KRW = ${total.btc.toFixed(8)} BTC
        `,
        channel: 'coinsect-api',
      })
    } finally {
      log.info('walletService.renewAll: updating wallets finished.')
    }
  },
  poll: async (wallet: Wallet): Promise<number> => {
    if (!wallet.blockchain) return Promise.reject({ message: 'wallet.blockchain is not populated' })

    try {
      const api = throughApi(wallet)[wallet.blockchain.symbol]
      if (api) return await api()

      const html: string = await axios.get(wallet.exploreUrl())
      if (!html) return Promise.reject({ message: `failed to fetch url ${wallet.exploreUrl()}` })

      return await scrape({ html, wallet })
    } catch (e) {
      return Promise.reject(e)
    }
  },
  all: () => dataSource.getRepository(Wallet)
    .createQueryBuilder()
    .leftJoinAndSelect('Wallet.blockchain', 'blockchain')
    .getMany(),
}

export default walletService