import { EntityMetadata, SelectQueryBuilder } from 'typeorm'

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isnull'

const OPERATORS: Record<FilterOp, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'ILIKE',
  in: 'IN',
  isnull: 'IS NULL',
}

export const MAX_FILTERS = 10
export const MAX_VALUE_LENGTH = 200
export const MAX_IN_VALUES = 50
export const MAX_JOINS = 10

export class FilterError extends Error {
  status = 400

  constructor(message: string) {
    super(message)
    this.name = 'FilterError'
  }
}

export interface ParsedFilter {
  alias: string
  property: string
  op: FilterOp
  value: string | string[] | boolean | null
}

const isFilterOp = (v: string): v is FilterOp => Object.prototype.hasOwnProperty.call(OPERATORS, v)

export type AliasMap = Map<string, EntityMetadata>

/**
 * 엔티티에 실재하는 컬럼만 통과시키고, 프로퍼티명으로 정규화해서 돌려준다.
 * TypeORM QueryBuilder가 alias.propertyName을 실제 컬럼으로 번역해 주기 때문에
 * DB 컬럼명이 아니라 프로퍼티명을 써야 네이밍 전략에 결합되지 않는다.
 */
export const resolveProperty = (meta: EntityMetadata, field: string): string => {
  const column = meta.columns.find(c => c.propertyName === field || c.databaseName === field)
  if (!column) throw new FilterError(`unknown field: ${field}`)
  return column.propertyName
}

/**
 * '별칭.컬럼' 또는 '컬럼'을 해석한다. 별칭이 붙으면 같은 요청의 ?join=이 만든 것이어야
 * 한다 - coinsect-admin이 profile.nickname, blockchain.name 같은 조인 컬럼으로 정렬하고
 * 검색하기 때문이다.
 */
export const resolveField = (
  field: string,
  meta: EntityMetadata,
  rootAlias: string,
  aliases: AliasMap,
): { alias: string, property: string } => {
  const dot = field.lastIndexOf('.')
  if (dot === -1) return { alias: rootAlias, property: resolveProperty(meta, field) }

  const alias = field.slice(0, dot)
  const column = field.slice(dot + 1)
  const target = aliases.get(alias)
  if (!target) throw new FilterError(`unknown alias: ${alias} (join it first)`)

  return { alias, property: resolveProperty(target, column) }
}

// 값에 든 %와 _를 리터럴로 만든다. 이스케이프하지 않으면 사용자가 조건을 임의로 넓힐 수 있다.
const escapeLikeValue = (v: string) => v.replace(/[\\%_]/g, ch => `\\${ch}`)

const parseOne = (
  entry: unknown,
  meta: EntityMetadata,
  rootAlias: string,
  aliases: AliasMap,
): ParsedFilter => {
  if (typeof entry !== 'string') throw new FilterError('filter must be a string')

  // 값에 콜론이 들어갈 수 있으므로 앞의 두 개만 나누고 나머지는 값으로 되돌린다.
  const [field, op, ...rest] = entry.split(':')
  const value = rest.join(':')
  if (!field || !op) throw new FilterError(`malformed filter: ${entry}`)
  if (!isFilterOp(op)) throw new FilterError(`unknown operator: ${op}`)

  const { alias, property } = resolveField(field, meta, rootAlias, aliases)

  if (op === 'isnull') {
    if (value !== 'true' && value !== 'false') throw new FilterError('isnull takes true or false')
    return { alias, property, op, value: value === 'true' }
  }

  if (value.length > MAX_VALUE_LENGTH) throw new FilterError('filter value too long')

  if (op === 'in') {
    const values = value.split(',').filter(v => v !== '')
    if (values.length === 0) throw new FilterError('in takes at least one value')
    if (values.length > MAX_IN_VALUES) throw new FilterError('too many values for in')
    return { alias, property, op, value: values }
  }

  if (op === 'like') return { alias, property, op, value: `%${escapeLikeValue(value)}%` }

  return { alias, property, op, value }
}

export const parseFilters = (
  raw: unknown,
  meta: EntityMetadata,
  rootAlias: string,
  aliases: AliasMap = new Map(),
): ParsedFilter[] => {
  if (raw === undefined || raw === null || raw === '') return []

  const entries = Array.isArray(raw) ? raw : [raw]
  if (entries.length > MAX_FILTERS) throw new FilterError('too many filters')

  return entries.map(entry => parseOne(entry, meta, rootAlias, aliases))
}

export const applyFilters = (qb: SelectQueryBuilder<any>, filters: ParsedFilter[]) => {
  filters.forEach((filter, idx) => {
    const target = `${filter.alias}.${filter.property}`
    const key = `qf_${idx}`

    if (filter.op === 'isnull') {
      qb.andWhere(`${target} IS ${filter.value ? '' : 'NOT '}NULL`)
      return
    }
    if (filter.op === 'in') {
      qb.andWhere(`${target} IN (:...${key})`, { [key]: filter.value })
      return
    }
    qb.andWhere(`${target} ${OPERATORS[filter.op]} :${key}`, { [key]: filter.value })
  })
}

export const parseSort = (
  rawSort: unknown,
  rawOrder: unknown,
  meta: EntityMetadata,
  rootAlias: string,
  aliases: AliasMap = new Map(),
): { alias: string, property: string, order: 'ASC' | 'DESC' } | null => {
  if (rawSort === undefined || rawSort === null || rawSort === '') return null
  if (typeof rawSort !== 'string') throw new FilterError('sort must be a string')

  const order = String(rawOrder || 'desc').toUpperCase()
  if (order !== 'ASC' && order !== 'DESC') throw new FilterError('order must be asc or desc')

  return { ...resolveField(rawSort, meta, rootAlias, aliases), order }
}

/**
 * 별칭은 관계 프로퍼티명을 쓴다. 클라이언트가 blockchain.name처럼 관계명으로 컬럼을
 * 가리키므로, tb_0 같은 익명 별칭을 쓰면 정렬/검색에서 참조가 어긋난다.
 */
export const parseJoins = (
  raw: unknown,
  meta: EntityMetadata,
  rootAlias: string,
): { joins: Array<{ target: string, alias: string }>, aliases: AliasMap } => {
  const aliases: AliasMap = new Map([[rootAlias, meta]])
  if (raw === undefined || raw === null || raw === '') return { joins: [], aliases }
  if (typeof raw !== 'string') throw new FilterError('join must be a string')

  const targets = raw.split(',').map(t => t.trim()).filter(Boolean)
  if (targets.length > MAX_JOINS) throw new FilterError('too many joins')

  const joins = targets.map(target => {
    const parts = target.split('.')
    if (parts.length !== 2) throw new FilterError(`malformed join: ${target}`)

    const [parentAlias, relationName] = parts
    const parentMeta = aliases.get(parentAlias)
    if (!parentMeta) throw new FilterError(`unknown join source: ${parentAlias}`)

    const relation = (parentMeta.relations || []).find(r => r.propertyName === relationName)
    if (!relation) throw new FilterError(`unknown relation: ${target}`)

    // 별칭 = 관계명. 'Post.user,user.profile'처럼 이어 받는 것도 이 맵으로 해결된다.
    aliases.set(relationName, relation.inverseEntityMetadata)
    return { target, alias: relationName }
  })

  return { joins, aliases }
}

export const parsePositiveInt = (raw: unknown, { fallback, max }: { fallback: number, max: number }): number => {
  if (raw === undefined || raw === null || raw === '') return fallback

  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new FilterError('must be a non-negative integer')
  return Math.min(n, max)
}
