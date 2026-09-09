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

    return slackService.postMessage({
      channel: 'coinsect-api',
      text: `[${report.name}] 포지션 수정 제보`,
      blocks: [...(report.imageUrl ? [{
        type: 'image',
        image_url: report.imageUrl,
        alt_text: `${report.name} 방송 캡처`,
      }] : []), {
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
