// 선행 스펙 §9의 픽스처(정답 확보됨)로 모델별 판독 정확도를 잰다.
const fs = require('fs')
const path = require('path')
const { GoogleGenAI } = require('@google/genai')

const KEY = process.env.GOOGLE_AI_STUDIO
const DIR = path.join(__dirname, '..', 'docs/superpowers/specs/fixtures')

// services/content/real_time_position.ts의 autoParse 프롬프트를 그대로 옮겨온다.
const PROMPT = `
        Ignore the orderbook. The relevant information is usually located near the bottom-left corner of the image.

        - 'entryPrice' is the initial price at which the position was entered. Look for 'Open Price', 'Entry Price' or similar labels. Don't assume that entry price = position value / size.
        - 'liqPrice' refers to the liquidation price, which is typically labeled as 'Liq' or 'Liquidation Price'.
        - 'size' indicates the position size. Positive for long position, usually where liqPrice is lower than entryPrice. Negative for short position, usually where liqPrice is higher than entryPrice. Usually ranges between 1 and 100 BTC. (not always, so make your own guess.)
        - 'contract' is the trading pair and usually ends with 'USDT' (e.g., 'BTCUSDT', 'ETHUSDT'). It can also be any altcoin-USDT pair. If the contract is not explicitly mentioned, look for it in labels near the position information or default to 'BTCUSDT'.

        Make sure entryPrice, liqPrice, and size are all numbers, not string representations of numbers.

        Ignore the total value of the position, I just need how many coins are being longed or shorted.
        Bitcoin is currently at 5 figures, so if you see something like "56,829.50", it's a number 56829.5 (Make sure to ignore all commas)

        I wish you can check all the values correctly like human can do even without hinting labels.
      `

const SCHEMA_PROMPT = `
        Fill this JSON using the given image.

        {
          "entryPrice": number,
          "liqPrice": number,
          "size": number,
          "contract": string
        }
      `

const CASES = [
  { file: 'btc-full.jpg', truth: { contract: 'BTCUSDT', size: 8.478, entryPrice: 64919.5, liqPrice: 63885 } },
  { file: 'soxl-full.jpg', truth: { contract: 'SOXLUSDT', size: -913.55, entryPrice: 138.30, liqPrice: 145.79 } },
  { file: 'soxl-crop-legible.jpg', truth: { contract: 'SOXLUSDT', size: -913.55, entryPrice: 138.30, liqPrice: 145.79 } },
]

const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']

const near = (a, b, pct) => a != null && b != null && Math.abs(a - b) / Math.abs(b) <= pct

const score = (got, truth) => {
  if (!got) return { ok: 0, detail: 'PARSE_FAIL' }
  const checks = {
    contract: got.contract === truth.contract,
    size: near(got.size, truth.size, 0.001),
    entry: near(got.entryPrice, truth.entryPrice, 0.001),
    // 청산가는 크로스 마진이라 프레임마다 실시간으로 변한다. 완전일치를 요구하면 안 된다.
    liq: near(got.liqPrice, truth.liqPrice, 0.005),
  }
  return {
    ok: Object.values(checks).filter(Boolean).length,
    detail: Object.entries(checks).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' '),
  }
}

const run = async () => {
  const genAI = new GoogleGenAI({ apiKey: KEY })
  const totals = {}

  for (const model of MODELS) {
    totals[model] = { ok: 0, max: 0, ms: 0 }
    console.log(`\n=== ${model} ===`)

    for (const c of CASES) {
      const data = fs.readFileSync(path.join(DIR, c.file)).toString('base64')
      const t0 = Date.now()
      let got = null
      let err = ''
      try {
        const res = await genAI.models.generateContent({
          model,
          config: { responseMimeType: 'application/json' },
          contents: [
            { text: PROMPT },
            { text: SCHEMA_PROMPT },
            { inlineData: { mimeType: 'image/jpeg', data } },
          ],
        })
        got = JSON.parse(res.text)
      } catch (e) {
        err = (e.message || String(e)).slice(0, 80)
      }
      const ms = Date.now() - t0
      const s = score(got, c.truth)
      totals[model].ok += s.ok
      totals[model].max += 4
      totals[model].ms += ms

      console.log(`${c.file.padEnd(24)} ${String(s.ok)}/4  ${s.detail}${err ? ' ' + err : ''}`)
      if (got) console.log(`${''.padEnd(24)} → ${got.contract} / ${got.size} / ${got.entryPrice} / ${got.liqPrice}`)
      console.log(`${''.padEnd(24)}   정답: ${c.truth.contract} / ${c.truth.size} / ${c.truth.entryPrice} / ${c.truth.liqPrice}  (${ms}ms)`)
    }
  }

  console.log('\n=== 종합 ===')
  for (const [m, t] of Object.entries(totals)) {
    console.log(`${m.padEnd(24)} ${t.ok}/${t.max}  평균 ${Math.round(t.ms / CASES.length)}ms`)
  }
}

run().catch(e => { console.error(e); process.exit(1) })

// 사용법:
//   GOOGLE_AI_STUDIO=<키> node tools/bench_position_models.js
//
// 주의: 출력을 파일로 리다이렉트하면 Node가 stdout을 버퍼링해서 진행 상황이 안 보인다.
// 터미널에 그대로 띄우거나, 필요하면 process.stdout.write 대신 fs.appendFileSync를 쓴다.
//
// 미완: 2026-09-08 실행에서 요약 헤더까지만 찍히고 멈췄다. Gemini 3.x가 기본으로 thinking을
// 돌아 호출당 수십 초가 걸리는 것으로 보인다. thinkingConfig: { thinkingBudget: 0 }을 주고
// 다시 재볼 것. usageMetadata.thoughtsTokenCount가 출력 토큰으로 과금되므로 비용 추정에
// 반드시 포함해야 한다.
