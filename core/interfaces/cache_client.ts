interface ICacheClient {
  set: (key: string, value: unknown, seconds?: number) => unknown,
  get: (key: string) => Promise<any>,
  del: (key: string) => unknown,
  // 값을 1 올리고 올린 뒤의 값을 준다. 처음 만들어질 때만 만료를 건다.
  //
  // get으로 읽고 +1 해서 set으로 쓰는 방식은 카운터가 될 수 없다. 두 요청이 같은
  // 값을 읽고 같은 값을 쓰므로 한 번만 오른다 - 동시에 들어온 요청이 전부 한도를
  // 통과한다. 속도 제한처럼 '동시에 들어온 것을 세는' 용도에는 원자적 증가가 필요하다.
  incr: (key: string, ttlSeconds: number) => Promise<number>,
  // 필드 단위로 원자적인 해시 연산.
  //
  // get으로 읽고 고쳐서 set으로 쓰는 사이에는 await 경계가 있어(레디스 왕복) 다른 요청이
  // 끼어든다. 두 요청이 같은 맵을 동시에 고치면 나중에 쓴 쪽이 상대 변경을 덮어쓴다.
  // 맵을 해시로 두면 그 구간 자체가 없어지고, 서버가 여러 대여도 안전하다.
  hGetAll: (key: string) => Promise<{ [field: string]: any }>,
  hSet: (key: string, field: string, value: unknown) => Promise<unknown>,
  // 이미 있으면 쓰지 않고 false를 준다. '없을 때만 넣기'가 원자적이어야
  // 동시에 누른 두 요청이 잡을 두 개 만들지 않는다.
  hSetNX: (key: string, field: string, value: unknown) => Promise<boolean>,
  hDel: (key: string, field: string) => Promise<unknown>,
}

export default ICacheClient