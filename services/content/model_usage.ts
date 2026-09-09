// 판독에 쓴 모델과 토큰, 그리고 그것이 얼마인지.
//
// 벤치(tools/bench_position_models.ts)와 운영이 같은 단가표를 봐야 한다. 프롬프트를
// 따로 들고 있다가 실제와 다른 결과를 낸 일이 있어(2026-09-09) 값은 한 곳에만 둔다.

export type IModelUsage = {
  model: string
  calls: number          // 프레임을 여러 장 보면 호출도 여러 번이다
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  costUsd: number
}

// USD / 1M 토큰. 2026-09-09 ai.google.dev/gemini-api/docs/pricing 기준.
// gemini-3.8-flash는 2027-01-01에 두 배가 된다($1.50 / $7.50).
export const MODEL_PRICING: { [model: string]: { input: number, output: number } } = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
}

export const emptyUsage = (model: string): IModelUsage => ({
  model,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
})

// thoughtsTokenCount는 candidatesTokenCount에 포함되지 않고 별도로 오지만 과금은
// 출력 단가로 매겨진다. 빼고 세면 비용이 실제보다 싸게 나온다.
export const costOf = (model: string, inputTokens: number, outputTokens: number, thinkingTokens: number) => {
  const price = MODEL_PRICING[model]
  if (!price) return 0

  return (inputTokens / 1e6) * price.input + ((outputTokens + thinkingTokens) / 1e6) * price.output
}

// SDK의 usageMetadata 한 건을 누계에 더한다.
export const addUsage = (total: IModelUsage, usageMetadata): IModelUsage => {
  const inputTokens = (usageMetadata || {}).promptTokenCount || 0
  const outputTokens = (usageMetadata || {}).candidatesTokenCount || 0
  const thinkingTokens = (usageMetadata || {}).thoughtsTokenCount || 0

  const next = {
    ...total,
    calls: total.calls + 1,
    inputTokens: total.inputTokens + inputTokens,
    outputTokens: total.outputTokens + outputTokens,
    thinkingTokens: total.thinkingTokens + thinkingTokens,
  }

  return {
    ...next,
    costUsd: costOf(next.model, next.inputTokens, next.outputTokens, next.thinkingTokens),
  }
}

// 이미 집계된 사용량 둘을 합친다. 프레임을 여러 장 보면 autoParse가 호출마다 자기
// 사용량을 돌려주므로, 부르는 쪽이 이걸로 누계한다.
export const mergeUsage = (a: IModelUsage, b?: IModelUsage): IModelUsage => {
  if (!b) return a

  const next = {
    model: b.model || a.model,
    calls: a.calls + (b.calls || 0),
    inputTokens: a.inputTokens + (b.inputTokens || 0),
    outputTokens: a.outputTokens + (b.outputTokens || 0),
    thinkingTokens: a.thinkingTokens + (b.thinkingTokens || 0),
    costUsd: 0,
  }

  return { ...next, costUsd: costOf(next.model, next.inputTokens, next.outputTokens, next.thinkingTokens) }
}

// 사람이 읽는 한 줄. 비용이 호출당 $0.003쯤이라 소수 4자리까지 보여준다.
export const describeUsage = (usage?: IModelUsage) => {
  if (!usage || !usage.calls) return null

  const n = (v: number) => v.toLocaleString('en-US')
  const thinking = usage.thinkingTokens ? ` (+thinking ${n(usage.thinkingTokens)})` : ''

  return `${usage.model} · ${usage.calls}회 판독 · 입력 ${n(usage.inputTokens)}`
    + ` · 출력 ${n(usage.outputTokens)}${thinking}`
    + ` · $${usage.costUsd.toFixed(4)}`
}
