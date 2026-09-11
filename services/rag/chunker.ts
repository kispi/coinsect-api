// 긴 본문을 단락 경계로 자른다. 부수효과가 없어 테스트가 쉽다.

// 앞 조각의 꼬리에서 겹침으로 쓸 부분을 떼어낸다.
//
// 마지막 N자를 그냥 자르면 단어 중간에서 시작하는 조각이 나온다. 그 조각은
// 임베딩에 잡음으로 들어간다. 잘라낸 뒤 첫 공백까지를 버려 온전한 경계에서
// 시작하게 한다. 공백이 없으면(한국어처럼 띄어쓰기가 드문 경우) 자른 그대로
// 쓴다 - 문맥을 잃는 것보다는 낫다.
const overlapTail = (prev: string, overlap: number): string => {
  if (overlap <= 0 || !prev) return ''
  if (prev.length <= overlap) return prev

  const tail = prev.slice(-overlap)
  const firstSpace = tail.search(/\s/)
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1)
}

// 각 조각 머리에 앞 조각의 꼬리를 붙인다. 겹침만큼 상한을 넘어서는 것은 의도된 동작이다.
const applyOverlap = (chunks: string[], overlap: number): string[] => {
  if (overlap <= 0 || chunks.length <= 1) return chunks

  return chunks.map((chunk, i) => {
    if (i === 0) return chunk
    const tail = overlapTail(chunks[i - 1], overlap)
    return tail ? `${tail}\n\n${chunk}` : chunk
  })
}

// 겹침은 조각 크기의 15% 남짓이 기본이다. 더 키우면 저장량과 임베딩 호출이
// 그만큼 늘고, 0으로 두면 경계에서 문맥이 끊긴다.
export const chunkText = (text: string, maxChunkSize = 800, overlap = 120): string[] => {
  const trimmed = (text || '').trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChunkSize) return [trimmed]

  const chunks: string[] = []
  let current = ''

  for (const para of trimmed.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue

    if ((current ? `${current}\n\n${p}` : p).length <= maxChunkSize) {
      current = current ? `${current}\n\n${p}` : p
      continue
    }

    if (current) chunks.push(current)

    if (p.length > maxChunkSize) {
      let temp = ''
      for (const s of p.split(/(?<=[.!?\n])\s+/)) {
        if ((temp ? `${temp} ${s}` : s).length <= maxChunkSize) {
          temp = temp ? `${temp} ${s}` : s
        } else {
          if (temp) chunks.push(temp)
          temp = s
        }
      }
      current = temp
    } else {
      current = p
    }
  }

  if (current) chunks.push(current)

  return applyOverlap(chunks, overlap)
}
