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

// Gemini 3.x는 기본으로 thinking을 돌아 호출당 수십 초가 걸린다. 2026-09-08 실행이
// 요약 헤더까지만 찍히고 멈춘 것이 이 때문이다. 0으로 끄고 잰다.
// 주의: 운영(services/content/real_time_position.ts의 autoParse)은 이 값을 주지 않아
// thinking이 켜진 상태로 돈다. 여기서 이긴 모델로 갈아탈 때 이 설정도 같이 옮겨야
// 측정한 정확도와 비용이 실제와 맞는다. THINKING_BUDGET=-1로 주면 켜고 잴 수 있다.
const THINKING_BUDGET = Number.isFinite(parseInt(process.env.THINKING_BUDGET)) ? parseInt(process.env.THINKING_BUDGET) : 0

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

// 모델에 따라 thinkingConfig 자체를 400 INVALID_ARGUMENT로 거부한다(2026-09-09 기준
// gemini-3.5-flash-lite). 그걸 판독 실패로 세면 가장 싼 후보를 재보지도 못하고 떨군다.
// 설정을 빼고 한 번 더 물어보고, 무엇으로 잰 값인지는 결과에 표시한다.
const generate = async (genAI, model, contents) => {
  const base = { responseMimeType: 'application/json' }

  try {
    const config = { ...base, thinkingConfig: { thinkingBudget: THINKING_BUDGET } }
    return { res: await genAI.models.generateContent({ model, config, contents }), thinkingConfigured: true }
  } catch (e) {
    if (!/INVALID_ARGUMENT/i.test(e.message || String(e))) throw e
    return { res: await genAI.models.generateContent({ model, config: base, contents }), thinkingConfigured: false }
  }
}

const run = async () => {
  const genAI = new GoogleGenAI({ apiKey: KEY })
  const totals = {}

  for (const model of MODELS) {
    totals[model] = { ok: 0, max: 0, ms: 0, inTok: 0, outTok: 0, thoughtTok: 0, thinkingRejected: false }
    console.log(`\n=== ${model} ===`)

    for (const c of CASES) {
      const data = fs.readFileSync(path.join(DIR, c.file)).toString('base64')
      const t0 = Date.now()
      let got = null
      let err = ''
      let usage = {}
      try {
        const { res, thinkingConfigured } = await generate(genAI, model, [
          { text: PROMPT },
          { text: SCHEMA_PROMPT },
          { inlineData: { mimeType: 'image/jpeg', data } },
        ])
        if (!thinkingConfigured) totals[model].thinkingRejected = true
        got = JSON.parse(res.text)
        usage = res.usageMetadata || {}
      } catch (e) {
        err = (e.message || String(e)).slice(0, 80)
      }
      const ms = Date.now() - t0
      const s = score(got, c.truth)
      // thoughtsTokenCount는 candidatesTokenCount에 포함되지 않고 별도로 오지만
      // 과금은 출력 토큰 단가로 매겨진다. 빼고 세면 비용이 실제보다 싸게 나온다.
      const thoughtTok = usage.thoughtsTokenCount || 0
      totals[model].ok += s.ok
      totals[model].max += 4
      totals[model].ms += ms
      totals[model].inTok += usage.promptTokenCount || 0
      totals[model].outTok += usage.candidatesTokenCount || 0
      totals[model].thoughtTok += thoughtTok

      console.log(`${c.file.padEnd(24)} ${String(s.ok)}/4  ${s.detail}${err ? ' ' + err : ''}`)
      if (got) console.log(`${''.padEnd(24)} → ${got.contract} / ${got.size} / ${got.entryPrice} / ${got.liqPrice}`)
      console.log(`${''.padEnd(24)}   정답: ${c.truth.contract} / ${c.truth.size} / ${c.truth.entryPrice} / ${c.truth.liqPrice}  (${ms}ms)`)
      console.log(`${''.padEnd(24)}   토큰: 입력 ${usage.promptTokenCount || 0} / 출력 ${usage.candidatesTokenCount || 0} / thinking ${thoughtTok}`)
    }
  }

  console.log(`\n=== 종합 (thinkingBudget=${THINKING_BUDGET}) ===`)
  for (const [m, t] of Object.entries(totals)) {
    // 출력 단가로 과금되는 토큰은 출력 + thinking이다. 이 합에 모델별 출력 단가를,
    // 입력 토큰에 입력 단가를 곱해야 호출당 비용이 나온다.
    const billedOut = t.outTok + t.thoughtTok
    console.log(
      `${m.padEnd(24)} ${t.ok}/${t.max}  평균 ${Math.round(t.ms / CASES.length)}ms  ` +
      `호출당 입력 ${Math.round(t.inTok / CASES.length)}tok / 과금출력 ${Math.round(billedOut / CASES.length)}tok` +
      `${t.thoughtTok ? ` (thinking ${Math.round(t.thoughtTok / CASES.length)}tok 포함)` : ''}` +
      `${t.thinkingRejected ? '  ※ thinkingConfig 미지원이라 빼고 측정' : ''}`,
    )
  }
  console.log(`\n케이스 ${CASES.length}건 x 모델 ${MODELS.length}개. 월 비용은 호출당 토큰 x 일 호출수 x 단가로 계산할 것.`)
}

run().catch(e => { console.error(e); process.exit(1) })

// 사용법:
//   GOOGLE_AI_STUDIO=<키> node tools/bench_position_models.js
//
// 주의: 출력을 파일로 리다이렉트하면 Node가 stdout을 버퍼링해서 진행 상황이 안 보인다.
// 터미널에 그대로 띄우거나, 필요하면 process.stdout.write 대신 fs.appendFileSync를 쓴다.
//
// thinking은 기본으로 끄고(thinkingBudget=0) 재며, 켜고 비교하려면 THINKING_BUDGET=-1을 준다.
// 호출당 입력/과금출력 토큰을 찍어주므로, 모델별 단가만 곱하면 월 비용이 나온다.
// thoughtsTokenCount는 출력 단가로 과금되므로 과금출력에 합산해 센다.
