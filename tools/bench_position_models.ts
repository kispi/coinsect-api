// 선행 스펙 §9의 픽스처(정답 확보됨)로 모델별 판독 정확도와 비용을 잰다.
//
//   GOOGLE_AI_STUDIO=<키> npx ts-node tools/bench_position_models.ts
//
// 출력을 파일로 리다이렉트하면 Node가 stdout을 버퍼링해 진행이 안 보인다. 터미널에 그대로 띄울 것.
// THINKING_BUDGET=-1로 주면 thinking을 켜고 비교할 수 있다.
import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import {
  POSITION_PROMPT,
  POSITION_SCHEMA_PROMPT,
  pickPosition,
} from '../services/content/real_time_position'

const KEY = process.env.GOOGLE_AI_STUDIO
const DIR = path.join(__dirname, '..', 'docs/superpowers/specs/fixtures')

// thinking 제어는 모델 세대마다 다르다. 2.5 계열은 thinkingBudget(0=끔), 3.x 계열은
// thinkingLevel(minimal/low/medium/high)을 본다. gemini-3.8-flash가 thinkingBudget: 0을
// 무시하고 계속 생각하는 이유가 이것이다.
//   THINKING_LEVEL=minimal npx ts-node tools/bench_position_models.ts
const THINKING_BUDGET = Number.isFinite(parseInt(process.env.THINKING_BUDGET)) ? parseInt(process.env.THINKING_BUDGET) : 0
// 열거형 값은 대문자다(MINIMAL/LOW/MEDIUM/HIGH). 소문자로 줘도 되게 올려준다.
const THINKING_LEVEL = (process.env.THINKING_LEVEL || '').toUpperCase()

// THINKING_BUDGET=none이면 thinkingConfig를 아예 보내지 않는다. 운영이 지금 그 상태라
// '아무것도 안 준 기본값'과 비교하려면 이 모드가 필요하다.
const THINKING_OFF = process.env.THINKING_BUDGET === 'none'

const thinkingConfig = () => {
  if (THINKING_LEVEL) return { thinkingLevel: THINKING_LEVEL as ThinkingLevel }
  return { thinkingBudget: THINKING_BUDGET }
}

const CASES = [
  { file: 'btc-full.jpg', truth: { contract: 'BTCUSDT', size: 8.478, entryPrice: 64919.5, liqPrice: 63885 } },
  { file: 'soxl-full.jpg', truth: { contract: 'SOXLUSDT', size: -913.55, entryPrice: 138.30, liqPrice: 145.79 } },
  { file: 'soxl-crop-legible.jpg', truth: { contract: 'SOXLUSDT', size: -913.55, entryPrice: 138.30, liqPrice: 145.79 } },
]

const MODELS = (process.env.BENCH_MODELS
  || 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash-lite').split(',')

// 픽스처가 3장뿐이라 1회 측정은 편차에 그대로 휘둘린다. 같은 모델이 재실행에서 9/12와
// 10/12를 오간 적이 있다. 판단이 갈리는 후보끼리 비교할 때는 REPS를 올려서 볼 것.
const REPS = parseInt(process.env.REPS) || 1

// 호출당 단가 (USD / 1M 토큰). 2026-09-09 ai.google.dev/gemini-api/docs/pricing.
const PRICE = {
  'gemini-3.8-flash': { in: 0.75, out: 3.75 },
  'gemini-3.5-flash': { in: 1.50, out: 9.00 },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
}

// 하루 90바퀴(피크 6시간 x 5분 + 비피크 18시간 x 1시간)에 피크 3명 / 비피크 1명 라이브 가정.
const CALLS_PER_MONTH = (72 * 3 + 18 * 1) * 30

const near = (a, b, pct) => a != null && b != null && Math.abs(a - b) / Math.abs(b) <= pct

const score = (got, truth) => {
  if (!got) return { ok: 0, detail: '판독 불가' }
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

// 모델에 따라 thinkingConfig 자체를 400 INVALID_ARGUMENT로 거부한다(gemini-3.5-flash-lite).
// 그걸 판독 실패로 세면 가장 싼 후보를 재보지도 못하고 떨군다. 빼고 한 번 더 물어본다.
const generate = async (genAI: GoogleGenAI, model: string, contents) => {
  const base = { responseMimeType: 'application/json' }

  try {
    const config = THINKING_OFF ? { ...base } : { ...base, thinkingConfig: thinkingConfig() }
    return { res: await genAI.models.generateContent({ model, config, contents }), thinkingConfigured: true }
  } catch (e) {
    if (!/INVALID_ARGUMENT/i.test(e.message || String(e))) throw e
    return { res: await genAI.models.generateContent({ model, config: base, contents }), thinkingConfigured: false }
  }
}

const run = async () => {
  if (!KEY) throw new Error('GOOGLE_AI_STUDIO가 필요합니다.')

  const genAI = new GoogleGenAI({ apiKey: KEY })
  const totals = {}

  for (const model of MODELS) {
    totals[model] = { ok: 0, max: 0, ms: 0, inTok: 0, outTok: 0, thoughtTok: 0, thinkingRejected: false, unreadable: 0, calls: 0 }
    console.log(`\n=== ${model} ===`)

    for (const c of CASES) {
      const data = fs.readFileSync(path.join(DIR, c.file)).toString('base64')
      const marks = []

      for (let rep = 0; rep < REPS; rep++) {
      const t0 = Date.now()
      let got = null
      let err = ''
      let usage: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number } = {}

      try {
        const { res, thinkingConfigured } = await generate(genAI, model, [
          { text: POSITION_PROMPT },
          { text: POSITION_SCHEMA_PROMPT },
          { inlineData: { mimeType: 'image/jpeg', data } },
        ])
        if (!thinkingConfigured) totals[model].thinkingRejected = true

        // 운영과 같은 판정을 거친다. 모델이 legible=false를 내거나 대표를 못 고르면 판독 불가다.
        const parsed = JSON.parse(res.text)
        got = parsed.legible === false ? null : pickPosition(parsed.positions)
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
      totals[model].calls++
      if (!got && !err) totals[model].unreadable++

      marks.push(err ? '에러' : (got ? `${s.ok}/4` : '불가'))
      if (REPS === 1) {
        console.log(`${c.file.padEnd(24)} ${String(s.ok)}/4  ${s.detail}${err ? ' ' + err : ''}`)
        if (got) console.log(`${''.padEnd(24)} → ${got.contract} / ${got.size} / ${got.entryPrice} / ${got.liqPrice}`)
        console.log(`${''.padEnd(24)}   정답: ${c.truth.contract} / ${c.truth.size} / ${c.truth.entryPrice} / ${c.truth.liqPrice}  (${ms}ms)`)
        console.log(`${''.padEnd(24)}   토큰: 입력 ${usage.promptTokenCount || 0} / 출력 ${usage.candidatesTokenCount || 0} / thinking ${thoughtTok}`)
      }
      }

      if (REPS > 1) console.log(`${c.file.padEnd(24)} ${marks.join(' ')}`)
    }
  }

  console.log(`\n=== 종합 (${THINKING_OFF ? 'thinkingConfig 없음 = 운영 현행' : THINKING_LEVEL ? `thinkingLevel=${THINKING_LEVEL}` : `thinkingBudget=${THINKING_BUDGET}`}) ===`)
  for (const [m, t] of Object.entries(totals) as [string, any][]) {
    const billedOut = t.outTok + t.thoughtTok
    const perCall = (t.inTok / t.calls / 1e6) * PRICE[m].in + (billedOut / t.calls / 1e6) * PRICE[m].out
    console.log(
      `${m.padEnd(24)} ${t.ok}/${t.max}  판독불가 ${t.unreadable}/${t.calls}  평균 ${Math.round(t.ms / t.calls)}ms  ` +
      `호출당 $${perCall.toFixed(5)}  월 $${(perCall * CALLS_PER_MONTH).toFixed(2)}` +
      `${t.thoughtTok ? `  (thinking ${Math.round(t.thoughtTok / t.calls)}tok 포함)` : ''}` +
      `${t.thinkingRejected ? '  ※ thinkingConfig 미지원이라 빼고 측정' : ''}`,
    )
  }
  console.log(`\n케이스 ${CASES.length}건 x ${REPS}회 x 모델 ${MODELS.length}개. 월 비용은 호출 ${CALLS_PER_MONTH.toLocaleString()}회 가정.`)
  console.log('프롬프트는 services/content/real_time_position.ts에서 그대로 가져온다 — 복사본이 아니다.')
}

run().catch(e => { console.error(e); process.exit(1) })
