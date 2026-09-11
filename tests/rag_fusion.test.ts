import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuseRRF, RRF_K } from '../services/rag/fusion'

const id = (o: { id: string }) => o.id

test('양쪽 리스트에 다 있는 항목이 위로 온다', () => {
  const a = [{ id: 'x' }, { id: 'y' }]
  const b = [{ id: 'z' }, { id: 'x' }]

  const fused = fuseRRF([a, b], id)

  assert.equal(fused[0].item.id, 'x')
  assert.deepEqual(fused[0].sources, [0, 1])
  // 1/(60+1) + 1/(60+2)
  assert.ok(Math.abs(fused[0].rrfScore - (1 / (RRF_K + 1) + 1 / (RRF_K + 2))) < 1e-12)
})

test('한 리스트에만 있으면 그 순위만큼의 점수를 갖는다', () => {
  const fused = fuseRRF([[{ id: 'a' }, { id: 'b' }]], id)

  assert.equal(fused[0].item.id, 'a')
  assert.deepEqual(fused[1].sources, [0])
})

test('먼저 등장한 리스트의 객체를 유지한다', () => {
  // 부르는 쪽이 정보량이 많은 리스트를 먼저 넘기면 그쪽이 남는다.
  const rich = [{ id: 'x', score: 0.9 }]
  const poor = [{ id: 'x' }]

  const fused = fuseRRF<{ id: string, score?: number }>([rich, poor], id)

  assert.equal(fused[0].item.score, 0.9)
})

test('동점이면 먼저 등장한 순서를 지킨다', () => {
  const fused = fuseRRF([[{ id: 'a' }], [{ id: 'b' }]], id)

  assert.equal(fused[0].rrfScore, fused[1].rrfScore)
  assert.equal(fused[0].item.id, 'a')
})

test('빈 리스트는 빈 결과다', () => {
  assert.deepEqual(fuseRRF([[], []], id), [])
})
