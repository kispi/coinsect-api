import useCache from '../../core/cache'
import helpers from '../../core/helpers'
import slackService from '../slack'
import { IPosition, hasUsableValues, notional, sortByNotional } from './position_model'
import { IModelUsage, describeUsage } from './model_usage'

const cache = useCache()

const KEY = 'content:positionReports'

export type IPositionReport = {
  id: string           // 대상 스트리머 id
  lane: 'desktop' | 'human'
  requester: string
  name?: string
  // 슬랙에서 이름을 눌렀을 때 갈 곳. 방송인은 핸들+/live, 그 외는 출처 링크다.
  watchUrl?: string
  ip?: string
  // 이 화면에서 읽어낸 포지션 전부. 판독에 실패했으면 빈 배열이다.
  positions: IPosition[]
  // 승인자가 '화면과 일치한다'고 체크한 계약. 슬랙 체크박스를 토글할 때마다 갱신된다.
  // 기본은 전부다 - 판독은 대개 맞으므로 틀린 것만 체크를 푸는 쪽이 클릭이 적다.
  selected?: string[]
  // canonical에는 있지만 이 화면에서는 못 본 계약. 승인하면 지운다. 제보 시점에 계산해
  // 저장한다 - 슬랙 메시지로 사람에게 보여준 그 목록이 그대로 적용되어야 한다.
  unseen?: string[]
  // 이 제보를 만드는 데 쓴 모델과 토큰, 그리고 비용.
  usage?: IModelUsage
  // 판독에 실제로 쓰인 프레임. 승인자가 'AI가 무엇을 봤는지'를 슬랙에서 바로 본다.
  imageUrl?: string
  imageKey?: string
  reportedAt: string
}

type IInbox = {
  desktop: { [streamerId: string]: IPositionReport }
  human: IPositionReport[]
}

// 슬랙 체크박스는 옵션 10개까지다. 명목가 큰 것부터 싣고 나머지는 잘렸다고 알린다.
export const SLACK_OPTION_LIMIT = 10

// 사람에게 보이는 시각. 서버는 UTC라 그대로 찍으면 아홉 시간 어긋난다. 앱 전역의
// 타임존을 건드리는 대신 표시할 때만 옮긴다. 한국은 서머타임이 없어 +9가 항상 맞다.
export const kstStamp = () => {
  const kst = new Date(Date.now() + 1000 * 60 * 60 * 9).toISOString()
  return `${kst.slice(5, 10)} ${kst.slice(11, 16)}` // MM-DD HH:mm
}

// 승인 대상. 체크된 계약만 남긴다. selected가 없으면(옛 제보) 전부로 본다.
export const selectedPositions = (report: IPositionReport): IPosition[] => {
  const usable = (report.positions || []).filter(hasUsableValues)
  if (!report.selected) return usable
  return usable.filter(o => report.selected.includes(o.contract))
}

const HUMAN_LIMIT = 5

// 판독이 틀렸거나 비었을 때 사람이 손으로 고치러 가는 곳이다.
const ADMIN_URL = 'https://admin.coinsect.io/real-time-positions'

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
  const inbox: IInbox = { desktop: {}, human: [], ...(stored || {}) }

  // 2026-09-09 이전 제보는 포지션 필드가 제보에 직접 박혀 있다. 배포 순간 제보함에
  // 남아 있던 것들이 승인 시 빈 포지션으로 읽히지 않도록 읽을 때 감싼다.
  const migrate = (report): IPositionReport => {
    if (Array.isArray(report.positions)) return report
    const { contract, entryPrice, liqPrice, size, ...rest } = report
    const legacy = { contract, entryPrice, liqPrice, size }
    return { ...(rest as Omit<IPositionReport, 'positions'>), positions: hasUsableValues(legacy) ? [legacy] : [] }
  }

  Object.keys(inbox.desktop).forEach(id => { inbox.desktop[id] = migrate(inbox.desktop[id]) })
  inbox.human = inbox.human.map(migrate)
  return inbox
}

const write = (inbox: IInbox) => cache.set(KEY, inbox)

// 무엇으로 읽었고 얼마 들었는지. 사람 제보(모델을 쓰지 않는다)에는 붙지 않는다.
const usageLine = (report: IPositionReport) => {
  const described = describeUsage(report.usage)
  return described ? `:brain: ${described}` : ''
}

// 판독에 쓰인 프레임. 승인자가 방송을 켜지 않고도 화면을 대조할 수 있어야 한다.
const imageBlocks = (report: IPositionReport) => (report.imageUrl ? [{
  type: 'image',
  image_url: report.imageUrl,
  alt_text: `${report.name} 방송 캡처`,
}] : [])

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
  // 슬랙 체크박스를 토글할 때마다 불린다. state.values가 메시지에서 동작하는지는
  // 문서가 보장하지 않아, 액션 자신이 들고 오는 selected_options를 그때그때 저장한다.
  // 승인 클릭은 이 저장된 선택을 읽는다.
  select: async (streamerId: string, contracts: string[]) => {
    const inbox = await read()
    const report = inbox.desktop[streamerId] || inbox.human.find(o => o.id === streamerId)
    if (!report) return null

    report.selected = contracts
    await write(inbox)
    return report
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
  // 사람이 화면과 대조할 수 있게 한 줄로 적는다. 명목가를 함께 보여주는 이유는
  // 어느 것이 대표로 뽑힐지가 명목가로 결정되기 때문이다.
  positionLine: (position: IPosition) => {
    const side = position.size < 0 ? '숏' : '롱'
    return `${position.contract} ${side} ${readable(Math.abs(position.size))}`
      + ` @${readable(position.entryPrice)} · 청산 ${readable(position.liqPrice)}`
  },
  // 슬랙 mrkdwn의 링크는 마크다운이 아니라 <URL|텍스트> 형식이다.
  notify: async (report: IPositionReport): Promise<void> => {
    const title = report.watchUrl ? `<${report.watchUrl}|${report.name}>` : `*${report.name}*`
    const value = JSON.stringify({ id: report.id, reportedAt: report.reportedAt })
    const usable = sortByNotional((report.positions || []).filter(hasUsableValues))
    const shown = usable.slice(0, SLACK_OPTION_LIMIT)
    const truncated = usable.length - shown.length

    // 판독 불가는 승인할 수치가 없다. 승인 버튼을 달면 빈 값이 canonical을 지운다.
    if (!shown.length) {
      return slackService.postMessage({
        channel: 'coinsect-api',
        text: `[${report.name}] 포지션 판독 실패`,
        blocks: [...imageBlocks(report), {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: helpers.allNewlineTrimmed(`
              :question: ${title} 화면에서 포지션을 읽지 못했습니다
              스샷을 보고 <${ADMIN_URL}|어드민>에서 직접 넣어주세요.
              요청자: ${report.requester}${report.ip ? ` (${report.ip})` : ''}
              ${usageLine(report)}
            `),
          },
        }, {
          type: 'actions',
          elements: [{
            type: 'button',
            action_id: 'position_reject',
            text: { type: 'plain_text', text: '닫기' },
            value,
          }],
        }],
      })
    }

    // 체크박스의 초기 선택은 전부다. 판독은 대개 맞으므로 틀린 것만 풀는 쪽이 클릭이 적다.
    // description에 명목가를 적어 어느 것이 대표가 될지 보이게 한다.
    const options = shown.map(position => ({
      text: { type: 'plain_text', text: positionReports.positionLine(position) },
      description: { type: 'plain_text', text: `명목 ${readable(Math.round(notional(position)))} USDT` },
      value: position.contract,
    }))

    return slackService.postMessage({
      channel: 'coinsect-api',
      text: `[${report.name}] 포지션 수정 제보`,
      blocks: [...imageBlocks(report), {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: helpers.allNewlineTrimmed(`
            :chart_with_upwards_trend: ${title} 포지션 수정 제보 — ${usable.length}개 읽음
            화면과 일치하는 것만 남기고 승인하세요.
            요청자: ${report.requester}${report.ip ? ` (${report.ip})` : ''}
            ${(report.unseen || []).length ? `:wastebasket: 화면에 없어 지울 포지션: ${report.unseen.join(', ')}` : ''}
            ${usageLine(report)}
            <${ADMIN_URL}|어드민에서 직접 수정>${truncated > 0 ? `\n포지션이 많아 명목가 상위 ${SLACK_OPTION_LIMIT}개만 실었습니다 (${truncated}개 생략).` : ''}
          `),
        },
      }, {
        type: 'section',
        // 토글 페이로드에는 버튼의 value가 없다. 어느 제보의 체크박스인지 알아야 선택을
        // 저장할 수 있으므로 블록 자신에 실어 보낸다. (슬랙 block_id는 255자까지다)
        block_id: value,
        text: { type: 'mrkdwn', text: '*반영할 포지션*' },
        accessory: {
          type: 'checkboxes',
          action_id: 'position_select',
          options,
          initial_options: options,
        },
      }, {
        type: 'actions',
        elements: [{
          type: 'button',
          action_id: 'position_approve',
          style: 'primary',
          text: { type: 'plain_text', text: '체크한 것 승인' },
          value,
        }, {
          type: 'button',
          action_id: 'position_reject',
          text: { type: 'plain_text', text: '전체 거절' },
          value,
        }],
      }],
    })
  },
  // 자동승인 모드에서는 물어보지 않고 반영한 뒤 결과만 알린다. 버튼이 없으므로 원본을
  // 갈아치울 일도 없어 새 메시지로 보낸다.
  notifyAutoApproved: async (report: IPositionReport, positions: IPosition[]): Promise<void> => {
    await slackService.postMessage({
      channel: 'coinsect-api',
      text: positionReports.resolutionText({
        report,
        approve: true,
        message: '자동 승인됨',
        who: report.requester,
        when: kstStamp(),
        positions,
      }),
    })
  },
  // 승인/거절 결과는 원본 메시지를 한 줄 요약으로 갈아치운다. 이미지를 남기면 기록이
  // 쌓일수록 채널이 세로로 길어져 훑어볼 수 없다. 대신 무엇을 승인했는지를 이 한 줄에 담는다.
  resolutionText: ({ report, approve, message, who, when, positions }: {
    report?: IPositionReport,
    approve: boolean,
    message: string,
    who: string,
    when: string,
    // 실제로 반영된 포지션. 넘기지 않으면 제보의 선택 상태를 쓴다.
    positions?: IPosition[],
  }) => {
    // 이미 처리됐거나 더 최신 제보가 있는 경우다. 남길 수치가 없으니 사유만 적는다.
    if (!report) return `⚠️ ${message} — ${who} · ${when}`

    const title = report.watchUrl ? `<${report.watchUrl}|${report.name}>` : `*${report.name}*`
    // 반영된 것만 적는다. 판독한 것 전부를 적으면 승인하지 않은 포지션까지
    // 승인된 것처럼 기록에 남는다.
    const applied = positions || selectedPositions(report)
    const detail = applied.length
      ? applied.map(positionReports.positionLine).join(' / ')
      : '판독 불가'

    const described = describeUsage(report.usage)

    return `${approve ? '✅' : '❌'} ${message} — ${LANE_ICON[report.lane]} ${title}`
      + ` · ${detail} · ${who} · ${when}`
      + (described ? ` · ${described}` : '')
  },
}

export default positionReports
