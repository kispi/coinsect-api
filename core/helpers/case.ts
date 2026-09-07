// coinsect-api가 내보내는 응답의 키는 camelCase로 통일한다. 문제는 우리가 그대로 중계하는 외부
// 원천들이다 - 업비트 뉴스는 featured_list/created_at/is_best를, coinmarketcap은 status.error_code를
// snake_case로 준다. 그게 그대로 새어나가면 같은 응답 안에서 realTimePositions·whaleAlerts 같은
// 우리 키와 표기가 섞인다. keysToCamel을 중계 경계에 한 번 걸어서 원천의 표기를 여기서 끊는다.
const caseHelpers = {
  pluralize: (str: string) => {
    if (str.endsWith('day')) return `${str}s`
    if (str.endsWith('way')) return `${str}s`
    if (str.endsWith('y')) return `${str.slice(0, -1)}ies`
    if (str.endsWith('s') || str.endsWith('h')) return `${str}es`

    return `${str}s`
  },
  toCapital: (str: string) => str.charAt(0).toUpperCase() + str.slice(1),
  toSnake: (str: string, delim?: string) => (str || '').replace(/[A-Z]/g, letter => `${delim || '_'}${letter.toLowerCase()}`),
  // 구분자 뒤가 숫자여도(volume_7d) 구분자를 없앤다. 숫자는 대문자가 따로 없어 그대로 남는다.
  toCamel: (str: string) => (str || '').replace(/[-_]+([a-z0-9])/g, (_, char: string) => char.toUpperCase()),
  // 키만 바꾸고 값은 손대지 않는다. 뉴스 content의 HTML처럼 값 쪽에도 밑줄이 흔하다.
  keysToCamel: <T>(value: T): T => {
    if (Array.isArray(value)) return value.map(item => caseHelpers.keysToCamel(item)) as unknown as T
    if (!value || typeof value !== 'object' || value instanceof Date) return value

    const converted: Record<string, unknown> = {}
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      converted[caseHelpers.toCamel(key)] = caseHelpers.keysToCamel(item)
    })

    return converted as T
  },
}

export default caseHelpers
