import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FilterError,
  applyFilters,
  parseFilters,
  parseJoins,
  parsePositiveInt,
  parseSort,
} from '../core/query_filter'

// parseFilters/parseSort/parseJoins가 EntityMetadata에서 실제로 읽는 것은
// columns[].propertyName, columns[].databaseName, relations[] 뿐이다.
const fakeMeta = (overrides: any = {}): any => ({
  name: 'WhaleAlert',
  columns: [
    { propertyName: 'hash', databaseName: 'hash' },
    { propertyName: 'amountUsd', databaseName: 'amount_usd' },
    { propertyName: 'fromOwnerType', databaseName: 'from_owner_type' },
    { propertyName: 'deletedAt', databaseName: 'deleted_at' },
  ],
  relations: [],
  ...overrides,
})

// andWhere 호출을 기록만 하는 가짜 QueryBuilder.
const fakeQb = () => {
  const calls: Array<{ sql: string, params?: object }> = []
  return {
    calls,
    andWhere(sql: string, params?: object) { calls.push({ sql, params }); return this },
  }
}

test('parseFilters: 값이 비면 빈 배열을 준다', () => {
  assert.deepEqual(parseFilters(undefined, fakeMeta(), 'WhaleAlert'), [])
  assert.deepEqual(parseFilters('', fakeMeta(), 'WhaleAlert'), [])
})

test('parseFilters: DB 컬럼명을 프로퍼티명으로 정규화한다', () => {
  const [filter] = parseFilters('amount_usd:gte:3000000', fakeMeta(), 'WhaleAlert')
  assert.equal(filter.property, 'amountUsd')
  assert.equal(filter.op, 'gte')
  assert.equal(filter.value, '3000000')
})

test('parseFilters: 프로퍼티명도 그대로 받는다', () => {
  const [filter] = parseFilters('amountUsd:gte:3000000', fakeMeta(), 'WhaleAlert')
  assert.equal(filter.property, 'amountUsd')
})

test('parseFilters: 엔티티에 없는 컬럼은 거부한다', () => {
  assert.throws(() => parseFilters('nope:eq:1', fakeMeta(), 'WhaleAlert'), FilterError)
})

test('parseFilters: 임의 SQL은 문법 검증에서 막힌다', () => {
  // 콜론이 없으면 op 자리가 비어 malformed로 걸린다.
  assert.throws(() => parseFilters('1=1 OR 1=1', fakeMeta(), 'WhaleAlert'), FilterError)
  assert.throws(() => parseFilters('amount_usd >= 3000000', fakeMeta(), 'WhaleAlert'), FilterError)
})

// 문법이 정상이면 값에 무엇이 들어 있든 거부하지 않는다. 값은 SQL이 아니라
// 파라미터로 나가므로 그것이 곧 방어다. 거부가 아니라 바인딩을 검증한다.
test('parseFilters: 값에 든 SQL은 리터럴로 취급해 파라미터로 넘긴다', () => {
  const payload = "x' OR '1'='1"
  const [filter] = parseFilters(`hash:eq:${payload}`, fakeMeta(), 'WhaleAlert')
  assert.equal(filter.value, payload)

  const qb = fakeQb()
  applyFilters(qb as any, [filter])
  assert.equal(qb.calls[0].sql, 'WhaleAlert.hash = :qf_0')
  assert.deepEqual(qb.calls[0].params, { qf_0: payload })
})

test('parseFilters: 허용되지 않은 연산자는 거부한다', () => {
  assert.throws(() => parseFilters('hash:regexp:x', fakeMeta(), 'WhaleAlert'), FilterError)
})

test('parseFilters: in은 쉼표로 나눈다', () => {
  const [filter] = parseFilters('hash:in:a,b,c', fakeMeta(), 'WhaleAlert')
  assert.deepEqual(filter.value, ['a', 'b', 'c'])
})

test('parseFilters: isnull은 불리언만 받는다', () => {
  assert.equal(parseFilters('deleted_at:isnull:true', fakeMeta(), 'WhaleAlert')[0].value, true)
  assert.equal(parseFilters('deleted_at:isnull:false', fakeMeta(), 'WhaleAlert')[0].value, false)
  assert.throws(() => parseFilters('deleted_at:isnull:yes', fakeMeta(), 'WhaleAlert'), FilterError)
})

test('parseFilters: like는 값의 와일드카드를 이스케이프한다', () => {
  const [filter] = parseFilters('hash:like:100%_x', fakeMeta(), 'WhaleAlert')
  assert.equal(filter.value, '%100\\%\\_x%')
})

test('parseFilters: 값에 콜론이 있어도 잘리지 않는다', () => {
  const [filter] = parseFilters('hash:eq:a:b:c', fakeMeta(), 'WhaleAlert')
  assert.equal(filter.value, 'a:b:c')
})

test('parseFilters: 배열로 여러 조건을 받는다', () => {
  const filters = parseFilters(['hash:eq:a', 'amount_usd:gte:1'], fakeMeta(), 'WhaleAlert')
  assert.equal(filters.length, 2)
})

test('parseFilters: 조건 개수 상한을 넘기면 거부한다', () => {
  const many = Array.from({ length: 11 }, () => 'hash:eq:a')
  assert.throws(() => parseFilters(many, fakeMeta(), 'WhaleAlert'), FilterError)
})

test('parseFilters: 지나치게 긴 값은 거부한다', () => {
  assert.throws(() => parseFilters(`hash:eq:${'a'.repeat(201)}`, fakeMeta(), 'WhaleAlert'), FilterError)
})

test('applyFilters: 값을 SQL에 넣지 않고 파라미터로 넘긴다', () => {
  const qb = fakeQb()
  applyFilters(qb as any, parseFilters('amount_usd:gte:3000000', fakeMeta(), 'WhaleAlert'))
  assert.equal(qb.calls[0].sql, 'WhaleAlert.amountUsd >= :qf_0')
  assert.deepEqual(qb.calls[0].params, { qf_0: '3000000' })
})

test('applyFilters: in은 스프레드 문법을 쓴다', () => {
  const qb = fakeQb()
  applyFilters(qb as any, parseFilters('hash:in:a,b', fakeMeta(), 'WhaleAlert'))
  assert.equal(qb.calls[0].sql, 'WhaleAlert.hash IN (:...qf_0)')
  assert.deepEqual(qb.calls[0].params, { qf_0: ['a', 'b'] })
})

test('applyFilters: isnull은 파라미터 없이 SQL만 만든다', () => {
  const qb = fakeQb()
  applyFilters(qb as any, parseFilters('deleted_at:isnull:true', fakeMeta(), 'WhaleAlert'))
  assert.equal(qb.calls[0].sql, 'WhaleAlert.deletedAt IS NULL')
  applyFilters(qb as any, parseFilters('deleted_at:isnull:false', fakeMeta(), 'WhaleAlert'))
  assert.equal(qb.calls[1].sql, 'WhaleAlert.deletedAt IS NOT NULL')
})

test('parseSort: 실재하는 컬럼과 방향만 통과시킨다', () => {
  const meta = fakeMeta()
  assert.deepEqual(parseSort('amount_usd', 'asc', meta, 'WhaleAlert'), { alias: 'WhaleAlert', property: 'amountUsd', order: 'ASC' })
  assert.deepEqual(parseSort('amountUsd', undefined, meta, 'WhaleAlert'), { alias: 'WhaleAlert', property: 'amountUsd', order: 'DESC' })
  assert.equal(parseSort(undefined, 'asc', meta, 'WhaleAlert'), null)
  assert.throws(() => parseSort('nope', 'asc', meta, 'WhaleAlert'), FilterError)
  assert.throws(() => parseSort('amountUsd', 'asc; DROP TABLE users', meta, 'WhaleAlert'), FilterError)
})

// coinsect-admin의 데이터 테이블이 profile.nickname, blockchain.name 같은 조인 컬럼으로
// 정렬하고 검색한다. 별칭은 같은 요청의 ?join=이 만든 것이어야 한다.
const postMeta = () => fakeMeta({
  name: 'Post',
  columns: [{ propertyName: 'id', databaseName: 'id' }, { propertyName: 'title', databaseName: 'title' }],
  relations: [{
    propertyName: 'user',
    inverseEntityMetadata: {
      columns: [{ propertyName: 'email', databaseName: 'email' }],
      relations: [{
        propertyName: 'profile',
        inverseEntityMetadata: { columns: [{ propertyName: 'nickname', databaseName: 'nickname' }], relations: [] },
      }],
    },
  }],
})

test('parseJoins: 실재하는 관계만 통과시키고 별칭은 관계명을 쓴다', () => {
  const { joins } = parseJoins('Post.user', postMeta(), 'Post')
  assert.deepEqual(joins, [{ target: 'Post.user', alias: 'user' }])
  assert.throws(() => parseJoins('Post.nope', postMeta(), 'Post'), FilterError)
  assert.throws(() => parseJoins('Other.user', postMeta(), 'Post'), FilterError)
})

test('parseJoins: 앞선 조인이 만든 별칭을 이어받는다', () => {
  const { joins, aliases } = parseJoins('Post.user,user.profile', postMeta(), 'Post')
  assert.deepEqual(joins, [
    { target: 'Post.user', alias: 'user' },
    { target: 'user.profile', alias: 'profile' },
  ])
  assert.ok(aliases.has('profile'))
})

test('parseSort: 조인 별칭의 컬럼으로 정렬할 수 있다', () => {
  const meta = postMeta()
  const { aliases } = parseJoins('Post.user,user.profile', meta, 'Post')
  assert.deepEqual(
    parseSort('profile.nickname', 'asc', meta, 'Post', aliases),
    { alias: 'profile', property: 'nickname', order: 'ASC' },
  )
})

test('parseSort: 조인하지 않은 별칭은 거부한다', () => {
  const meta = postMeta()
  const { aliases } = parseJoins(undefined, meta, 'Post')
  assert.throws(() => parseSort('profile.nickname', 'asc', meta, 'Post', aliases), FilterError)
})

test('parseFilters: 조인 별칭의 컬럼으로 필터할 수 있다', () => {
  const meta = postMeta()
  const { aliases } = parseJoins('Post.user,user.profile', meta, 'Post')
  const [filter] = parseFilters('profile.nickname:like:kim', meta, 'Post', aliases)
  assert.equal(filter.alias, 'profile')
  assert.equal(filter.property, 'nickname')

  const qb = fakeQb()
  applyFilters(qb as any, [filter])
  assert.equal(qb.calls[0].sql, 'profile.nickname ILIKE :qf_0')
})

test('parseFilters: 조인 별칭 자리에 임의 문자열을 넣으면 거부한다', () => {
  const meta = postMeta()
  const { aliases } = parseJoins('Post.user', meta, 'Post')
  assert.throws(() => parseFilters('users u; DROP TABLE x--.id:eq:1', meta, 'Post', aliases), FilterError)
})

test('parsePositiveInt: 숫자로 강제하고 상한을 건다', () => {
  assert.equal(parsePositiveInt(undefined, { fallback: 0, max: 1000 }), 0)
  assert.equal(parsePositiveInt('20', { fallback: 0, max: 1000 }), 20)
  assert.equal(parsePositiveInt('99999', { fallback: 0, max: 1000 }), 1000)
  assert.throws(() => parsePositiveInt('1; DROP TABLE users', { fallback: 0, max: 1000 }), FilterError)
  assert.throws(() => parsePositiveInt('-1', { fallback: 0, max: 1000 }), FilterError)
  assert.throws(() => parsePositiveInt('1.5', { fallback: 0, max: 1000 }), FilterError)
})
