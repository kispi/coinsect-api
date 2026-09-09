import useCache from '../../core/cache'
import helpers from '../../core/helpers'
import slackService from '../slack'

const cache = useCache()

const KEY = 'content:positionReports'

export type IPositionReport = {
  id: string           // 대상 포지션 id
  lane: 'desktop' | 'human'
  requester: string
  name?: string
  link?: string
  contract?: string
  entryPrice?: number
  liqPrice?: number
  size?: number
  onAir?: boolean
  ip?: string
  // 판독에 실제로 쓰인 프레임. 승인자가 'AI가 무엇을 봤는지'를 슬랙에서 바로 본다.
  imageUrl?: string
  imageKey?: string
  // 화면에서 포지션을 읽어내지 못한 제보. 수치가 없으므로 승인할 수 없고,
  // 사람이 스샷을 보고 어드민에서 직접 넣으라고 알리는 용도다.
  legible?: boolean
  reportedAt: string
}

type IInbox = {
  desktop: { [positionId: string]: IPositionReport }
  human: IPositionReport[]
}

const HUMAN_LIMIT = 5

// 판독이 틀렸거나 비었을 때 사람이 손으로 고치러 가는 곳이다.
const ADMIN_URL = 'https://admin.coinsect.io/real-time-positions'

// 셋 중 하나라도 비면 canonical에 반영해선 안 된다. set()은 빈 값을 '지우라'는 뜻으로
// 받아들여 컬럼을 날리고 "포지션이 업데이트되었습니다 / 진입 - / 청산 -"를 전 유저에게
// 푸시한다. 스샷에는 포지션이 멀쩡히 보이는 경우라 사람 눈으로도 못 거른다.
// set()과 같은 truthy 판정을 쓴다. 다르게 재면 여기서 통과한 값이 저기서 지워진다.
export const hasUsableValues = (o) => ['entryPrice', 'liqPrice', 'size'].every(field => !!(o || {})[field])

// 사람이 읽는 수치다. 천단위 콤마를 넣고, 값이 없으면 '-'. toLocaleString의 소수 상한
// 기본값은 3자리라 그대로 쓰면 기록이 조용히 뭉개진다. 넉넉히 열어둔다.
const readable = (v?: number | string) => {
  if (v === null || v === undefined || v === '') return '-'
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 8 }) : String(v)
}

// 자동 제보인지 사람 손인지 한 눈에 갈리게 한다.
const LANE_ICON: { [lane in IPositionReport['lane']]: string } = {
  desktop: '🖥',
  human: '🙋',
}

// 데스크톱 제보와 사람 제보를 한 배열에 담으면, 스크립트가 5분마다 5명을 돌 때
// 데스크톱 제보가 사람 제보를 전부 밀어낸다. 그래서 레인을 나눈다.
const read = async (): Promise<IInbox> => {
  const stored = await cache.get(KEY)
  return { desktop: {}, human: [], ...(stored || {}) }
}

const write = (inbox: IInbox) => cache.set(KEY, inbox)

export const positionHasChanged = (a, b) => ['contract', 'entryPrice', 'liqPrice', 'size'].some(field =>
  (a[field] && !b[field]) ||
  (!a[field] && b[field]) ||
  (a[field] && b[field] && a[field] != b[field])
)

const positionReports = {
  // 어드민은 레인을 구분하지 않는다. 최신순으로 합쳐서 준다.
  all: async () => {
    const inbox = await read()
    return [...Object.values(inbox.desktop), ...inbox.human]
      .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1))
  },
  find: async (positionId: string, reportedAt?: string) => {
    const inbox = await read()
    const found = inbox.desktop[positionId] || inbox.human.find(o => o.id === positionId)
    if (!found) return null
    // reportedAt이 어긋나면 그 사이에 더 새로운 제보가 들어온 것이다.
    // 오래된 슬랙 메시지의 버튼을 눌러 낡은 포지션이 전체 푸시로 나가는 것을 막는다.
    if (reportedAt && found.reportedAt !== reportedAt) return null
    return found
  },
  put: async (report: IPositionReport) => {
    const inbox = await read()

    if (report.lane === 'desktop') inbox.desktop[report.id] = report
    else inbox.human = [...inbox.human, report].slice(-HUMAN_LIMIT)

    await write(inbox)
  },
  remove: async (positionId: string) => {
    const inbox = await read()
    delete inbox.desktop[positionId]
    inbox.human = inbox.human.filter(o => o.id !== positionId)
    await write(inbox)
  },
  // 제보함에 넣고 알린다. 두 레인이 공유하는 마지막 단계다.
  // 알림이 못 나갔는데 제보를 남겨두면 다음 주기에 '직전 제보와 동일'로 억제돼,
  // 스트리머가 포지션을 바꿀 때까지 아무 알림도 오지 않는다. 그래서 되돌린다.
  file: async (report: IPositionReport) => {
    await positionReports.put(report)

    try {
      await positionReports.notify(report)
    } catch (e) {
      await positionReports.remove(report.id)
      throw e
    }

    return report
  },
  // 슬랙 mrkdwn의 링크는 마크다운이 아니라 <URL|텍스트> 형식이다.
  notify: async (report: IPositionReport): Promise<void> => {
    const title = report.link ? `<${report.link}|${report.name}>` : `*${report.name}*`
    const value = JSON.stringify({ id: report.id, reportedAt: report.reportedAt })
    const readable = hasUsableValues(report)

    // 판독 불가는 승인할 수치가 없다. 승인 버튼을 달면 빈 값이 canonical을 지운다.
    const buttons = readable ? [{
      type: 'button',
      action_id: 'position_approve',
      style: 'primary',
      text: { type: 'plain_text', text: '승인' },
      value,
    }, {
      type: 'button',
      action_id: 'position_reject',
      text: { type: 'plain_text', text: '거절' },
      value,
    }] : [{
      type: 'button',
      action_id: 'position_reject',
      text: { type: 'plain_text', text: '닫기' },
      value,
    }]

    // 판독이 틀렸을 때도 사람이 바로 고치러 갈 수 있게 어드민 링크를 함께 건다.
    const body = readable ? `
      :chart_with_upwards_trend: ${title} 포지션 수정 제보
      계약 / 규모: ${report.contract || '-'} / ${report.size || '-'}
      진입 / 청산: ${report.entryPrice || '-'} / ${report.liqPrice || '-'}
      요청자: ${report.requester}${report.ip ? ` (${report.ip})` : ''}
      <${ADMIN_URL}|어드민에서 직접 수정>
    ` : `
      :question: ${title} 화면에서 포지션을 읽지 못했습니다
      스샷을 보고 <${ADMIN_URL}|어드민>에서 직접 넣어주세요.
      요청자: ${report.requester}${report.ip ? ` (${report.ip})` : ''}
    `

    return slackService.postMessage({
      channel: 'coinsect-api',
      text: readable ? `[${report.name}] 포지션 수정 제보` : `[${report.name}] 포지션 판독 실패`,
      blocks: [...(report.imageUrl ? [{
        type: 'image',
        image_url: report.imageUrl,
        alt_text: `${report.name} 방송 캡처`,
      }] : []), {
        type: 'section',
        text: { type: 'mrkdwn', text: helpers.allNewlineTrimmed(body) },
      }, {
        type: 'actions',
        elements: buttons,
      }],
    })
  },
  // 승인/거절 결과는 원본 메시지를 한 줄 요약으로 갈아치운다. 이미지를 남기면 기록이
  // 쌓일수록 채널이 세로로 길어져 훑어볼 수 없다. 대신 무엇을 승인했는지를 이 한 줄에 담는다.
  resolutionText: ({ report, approve, message, who, when }: {
    report?: IPositionReport,
    approve: boolean,
    message: string,
    who: string,
    when: string,
  }) => {
    // 이미 처리됐거나 더 최신 제보가 있는 경우다. 남길 수치가 없으니 사유만 적는다.
    if (!report) return `⚠️ ${message} — ${who} · ${when}`

    const title = report.link ? `<${report.link}|${report.name}>` : `*${report.name}*`
    // 판독에 실패한 제보는 적을 수치가 없다. 빈 칸을 늘어놓는 대신 그렇게 적는다.
    const detail = hasUsableValues(report)
      ? `${report.contract || '-'} · 규모 ${readable(report.size)}`
        + ` · 진입 ${readable(report.entryPrice)} · 청산 ${readable(report.liqPrice)}`
      : '판독 불가'

    return `${approve ? '✅' : '❌'} ${message} — ${LANE_ICON[report.lane]} ${title}`
      + ` · ${detail} · ${who} · ${when}`
  },
}

export default positionReports
