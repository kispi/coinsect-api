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
  reportedAt: string
}

type IInbox = {
  desktop: { [positionId: string]: IPositionReport }
  human: IPositionReport[]
}

const HUMAN_LIMIT = 5

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
  // 슬랙 mrkdwn의 링크는 마크다운이 아니라 <URL|텍스트> 형식이다.
  notify: async (report: IPositionReport) => {
    const title = report.link ? `<${report.link}|${report.name}>` : `*${report.name}*`
    const value = JSON.stringify({ id: report.id, reportedAt: report.reportedAt })

    return slackService.postMessage({
      channel: 'coinsect-api',
      text: `[${report.name}] 포지션 수정 제보`,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: helpers.allNewlineTrimmed(`
            :chart_with_upwards_trend: ${title} 포지션 수정 제보
            계약 / 규모: ${report.contract || '-'} / ${report.size || '-'}
            진입 / 청산: ${report.entryPrice || '-'} / ${report.liqPrice || '-'}
            요청자: ${report.requester}${report.ip ? ` (${report.ip})` : ''}
          `),
        },
      }, {
        type: 'actions',
        elements: [{
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
        }],
      }],
    })
  },
}

export default positionReports
