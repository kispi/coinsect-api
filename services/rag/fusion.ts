// Reciprocal Rank Fusion.
//
// 점수 체계가 다른 결과를 합칠 때 점수 자체를 정규화하려 들면 실패한다. 코사인
// 유사도는 0.68~0.9의 좁은 구간에 몰려 있고 키워드 매칭에는 애초에 점수가 없다.
// RRF는 점수를 버리고 순위만 써서 이 문제를 피한다.
//
// K는 상위권의 영향력을 얼마나 눌러줄지를 정한다. 60은 원 논문 이래의 관례값으로,
// 1등과 2등의 격차를 완만하게 만들어 한쪽 리스트가 결과를 독점하지 못하게 한다.
export const RRF_K = 60

export interface FusedItem<T> {
  item: T
  rrfScore: number
  // 이 항목이 등장한 입력 리스트의 인덱스들
  sources: number[]
}

// keyOf가 같은 값을 주는 항목은 동일한 것으로 보고 합산한다. 결과 객체는 가장
// 먼저 등장한 리스트의 것을 유지한다 - 부르는 쪽이 정보량이 많은 리스트를 먼저
// 넘기면 자연스럽게 그쪽이 남는다.
//
// 같은 리스트 안에서 같은 키가 두 번 나와도 한 번으로만 센다. RRF는 리스트당
// 한 항목이 한 번 등장한다고 전제하는 방식이라, 함수가 스스로 이 전제를 지키는
// 게 부르는 쪽마다 중복을 없애기를 비는 것보다 낫다.
export const fuseRRF = <T>(lists: T[][], keyOf: (item: T) => string): FusedItem<T>[] => {
  const byKey = new Map<string, FusedItem<T>>()
  // Map은 삽입 순서를 보존한다. 동점일 때 이 순서가 안정 정렬의 기준이 된다.
  const order: string[] = []

  lists.forEach((list, listIndex) => {
    list.forEach((item, position) => {
      const key = keyOf(item)
      const contribution = 1 / (RRF_K + position + 1)
      const existing = byKey.get(key)

      if (existing) {
        // 같은 리스트에서 이미 본 키는 무시한다 (첫 등장만 반영)
        if (!existing.sources.includes(listIndex)) {
          existing.rrfScore += contribution
          existing.sources.push(listIndex)
        }
        return
      }

      byKey.set(key, { item, rrfScore: contribution, sources: [listIndex] })
      order.push(key)
    })
  })

  return order.map(key => byKey.get(key)).sort((a, b) => b.rrfScore - a.rrfScore)
}
