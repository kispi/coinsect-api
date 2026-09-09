// 스트리머와 포지션의 모양, 그리고 그 위에서 도는 순수 판정들.
//
// real_time_position(canonical 관리)과 position_reports(제보함)가 둘 다 이 판정을 쓴다.
// 한쪽에 두면 서로를 import해 순환이 생기므로 여기로 뺐다. 부수효과가 없어 테스트도 쉽다.

// 스트리머가 잡고 있는 포지션 한 건. 스트리머 하나가 여럿을 들 수 있다.
export type IPosition = {
  id?: string           // canonical에 들어간 뒤 붙는다. 화면에서 방금 읽은 값에는 없다.
  contract?: string
  entryPrice?: number
  liqPrice?: number
  size?: number
}

export type IStreamer = {
  id: string
  name: string
  // 방송인은 채널 핸들이 유일한 출처다. 방송 URL은 따로 두지 않는다 - 방송을 껐다 켜면
  // 바뀌는 값이라 갱신을 쫓아다녀야 했고, 이제 핸들에 /live를 붙이면 그 순간의 방송으로
  // 유튜브가 보내준다(방송 중이 아니면 채널 페이지로 떨어진다).
  channelUrl: string
  // 방송인이 아닌 항목(사토시, 테슬라, 엘살바도르 등)의 출처 링크. 근거 기사나 트래커라
  // 채널 개념이 없다. 둘은 성격이 다르므로 이름을 나눈다.
  sourceUrl?: string
  image: string
  onAir: boolean
  editable: boolean
  lastUpdate: Date | string
  positions: IPosition[]
  tracking?: boolean
}

// 셋 중 하나라도 비면 canonical에 반영해선 안 된다. set()은 빈 값을 '지우라'는 뜻으로
// 받아들여 컬럼을 날리고 "포지션이 업데이트되었습니다 / 진입 - / 청산 -"를 전 유저에게
// 푸시한다. 스샷에는 포지션이 멀쩡히 보이는 경우라 사람 눈으로도 못 거른다.
// set()과 같은 truthy 판정을 쓴다. 다르게 재면 여기서 통과한 값이 저기서 지워진다.
export const hasUsableValues = (o?: IPosition) => ['entryPrice', 'liqPrice', 'size']
  .every(field => !!(o || {})[field])

export const positionHasChanged = (a, b) => ['contract', 'entryPrice', 'liqPrice', 'size'].some(field =>
  (a[field] && !b[field]) ||
  (!a[field] && b[field]) ||
  (a[field] && b[field] && a[field] != b[field])
)

const byContract = (list: IPosition[]) => [...(list || [])]
  .sort((a, b) => String(a.contract || '').localeCompare(String(b.contract || '')))

// 포지션이 여러 개가 되면서 '바뀌었나'는 집합 비교가 됐다. 모델이 계약을 매번 같은
// 순서로 내주지 않으므로 정렬해서 짝지어 본다.
export const positionSetHasChanged = (a: IPosition[], b: IPosition[]) => {
  const [x, y] = [byContract(a), byContract(b)]
  if (x.length !== y.length) return true
  return x.some((position, i) => positionHasChanged(position, y[i]))
}

// 카드에서 이름을 눌렀을 때 갈 곳. 방송인은 지금 방송(핸들 + /live), 그 외는 출처 링크다.
export const watchUrl = (streamer: { channelUrl?: string, sourceUrl?: string }) => {
  const channel = (streamer.channelUrl || '').trim().replace(/\/live\/?$/, '')
  if (channel) return `${channel}/live`

  return streamer.sourceUrl || null
}

// 명목가. 코인 개수는 코인마다 자릿수가 달라(0.5 BTC vs 16,570 KORU) 그대로 비교할 수 없다.
export const notional = (p: IPosition) => Math.abs(parseFloat(String(p.size)))
  * Math.abs(parseFloat(String(p.entryPrice)))

// 한 화면에 BTC/ETH/SOL이 동시에 잡혀 있어도 카드에는 하나만 크게 보여주고, 변경 알림도
// 이 하나를 기준으로 판단한다. '가장 크게 건 포지션'을 명목가로 고른다.
// 순위를 못 매기면 고르지 않는다. 사람이 스샷을 보고 판단하는 편이 낫다.
export const pickPosition = (positions?: IPosition[]): IPosition => {
  const usable = (positions || []).filter(p => p && hasUsableValues(p))
  if (!usable.length) return null
  if (usable.length === 1) return usable[0]

  const ranked = [...usable].sort((a, b) => notional(b) - notional(a))

  // 1등과 2등이 같으면 어느 쪽이 대표인지 정할 근거가 없다.
  if (notional(ranked[0]) === notional(ranked[1])) return null
  return ranked[0]
}

// 명목가 큰 순. 슬랙 체크박스가 10개까지만 되고, 카드도 큰 것부터 보여준다.
export const sortByNotional = (positions: IPosition[]) => [...(positions || [])]
  .sort((a, b) => notional(b) - notional(a))

// 승인은 사람이 체크한 것만 반영한다. 계약이 같으면 갱신, 없으면 추가.
// **체크되지 않은 기존 포지션은 지우지 않는다.** 판독이 일부만 맞는 경우가 흔한데
// 승인 한 번에 나머지가 조용히 사라지면 사람이 눈으로 못 잡는다. 삭제는 어드민에서 한다.
export const upsertPositions = (
  current: IPosition[],
  incoming: IPosition[],
  makeId: () => string,
  // 화면에서 사라진 계약. 승인 시 함께 정리한다. 슬랙 메시지가 무엇을 지울지 미리 알린다.
  remove: string[] = [],
): IPosition[] => {
  const next = (current || []).filter(o => !remove.includes(o.contract))

  for (const position of incoming || []) {
    if (!hasUsableValues(position)) continue

    const idx = next.findIndex(o => o.contract === position.contract)
    const values = {
      contract: position.contract,
      entryPrice: parseFloat(String(position.entryPrice)),
      liqPrice: parseFloat(String(position.liqPrice)),
      size: parseFloat(String(position.size)),
    }

    if (idx >= 0) next[idx] = { ...next[idx], ...values }
    else next.push({ id: makeId(), ...values })
  }

  return next
}

// 2026-09-09 이전 저장분에는 link가 있다. 방송인의 link는 '그 순간의 방송' 주소라
// 버려도 되지만(핸들로 다시 만든다), 방송인이 아닌 항목의 link는 출처라 살려야 한다.
const migrateLink = (streamer) => {
  if (!streamer || !('link' in streamer)) return streamer

  const { link, ...rest } = streamer
  return rest.channelUrl ? rest : { ...rest, sourceUrl: rest.sourceUrl || link }
}

// 화면을 성공적으로 읽었다면, 그 화면에 없던 계약은 방송인이 닫은 것이다. 그대로 두면
// 유령 포지션이 영원히 쌓이고, 명목가가 크면 대표 자리까지 차지해 실제 포지션을 가린다.
// 2026-09-09에 박호두의 BTCUSDT($4.6M)가 ZEC/VVV를 가려 이걸 밟았다.
//
// 판독이 실패했을 때(빈 배열)는 아무것도 지우지 않는다. '화면을 못 읽었다'와
// '포지션이 없다'를 구분할 수 없기 때문이다.
export const unseenContracts = (current: IPosition[], read: IPosition[]) => {
  if (!(read || []).length) return []

  const seen = new Set((read || []).map(o => o.contract))
  return (current || []).map(o => o.contract).filter(contract => !seen.has(contract))
}

// 2026-09-09 이전 저장분은 스트리머와 포지션이 한 객체에 섞여 있다. 캐시를 비우면
// 사람이 승인해 쌓아둔 값이 전부 날아가므로, 읽을 때 한 번 감싸서 올린다.
// 한 번 저장되면 이후로는 새 모양이라 이 경로를 다시 타지 않는다.
//
// id는 스트리머 id와 계약에서 만들어낸다. 이 변환은 매 읽기마다 도는데(저장할 때까지
// 레디스는 옛 모양이다) 새 uuid를 뽑으면 GET 두 번이 같은 포지션에 다른 id를 준다.
// 프론트의 v-for 키가 매번 갈려 5분마다 목록이 통째로 다시 그려진다.
export const toStreamer = (stored): IStreamer => {
  if (Array.isArray((stored || {}).positions)) return migrateLink(stored)

  const { contract, entryPrice, liqPrice, size, ...streamer } = stored || {}
  const legacy = { contract, entryPrice, liqPrice, size }

  return {
    ...migrateLink(streamer),
    // 계약만 있고 수치가 비어 있던 자리(프리셋 기본값)는 포지션으로 세지 않는다.
    positions: hasUsableValues(legacy) ? [{ id: `${streamer.id}-${contract}`, ...legacy }] : [],
  }
}
