# PostgreSQL 리허설 결과 (Task 10)

계획: [2026-08-19-postgresql-migration.md](./2026-08-19-postgresql-migration.md)
진행 상황: [2026-08-19-postgresql-migration-progress.md](./2026-08-19-postgresql-migration-progress.md)

**Task 10 완료. 컷오버(Task 11)를 막는 결함은 없었다.**

실행: 2026-08-20 (KST) / 서버 `webserver.coinsect.io`
리허설 내내 MySQL은 서비스 중이었고 운영에 영향을 주지 않았다.

## 실측 소요 시간 — 컷오버 창 산정 근거

| 단계 | 시간 |
|---|---|
| 전체 이관 (20개 테이블, 약 96만 행) | **1분 17초** |
| 델타 동기화 (`--since` 전체 이관 시작 시각) | **8초** |
| `verify.mjs` | 약 10초 |

컷오버의 실제 정지 구간은 **델타 + 검증 = 약 20초**다. 계획서가 걱정하던
`messages_202605` 85만 행은 keyset 페이지네이션 덕에 병목이 아니었다.

## 결과

- 전체 이관 20개 테이블 전부 성공. `messages_202605` 860,536행(계획서 추정 852,544행에서
  자연 증가).
- 전체 이관 직후 `verify.mjs`는 **불일치 1건**을 냈다 — `posts`의 `updated_at` 경계값.
  원인은 결함이 아니라 **라이브 트래픽**이다. 이관 시작(23:54:51) 이후 `posts`가 복사된
  뒤에 MySQL에서 조회수 갱신이 계속 일어났다. 행 수와 id 범위는 그때도 일치했다.
- **델타 동기화 후 `verify.mjs` = `전부 일치`, 종료 코드 0.** 이것이 델타의 존재 이유이고,
  컷오버에서 API를 멈춘 뒤 델타를 돌리면 이 드리프트는 발생하지 않는다.
- `비활성 트리거: 없음` — 델타의 `DISABLE TRIGGER USER` / `ENABLE`이 정상 복구됐다.
  진행 상황 문서가 가장 위험하다고 지목한 지점인데 깨끗했다.

## 시각 정확성 — 가장 조용히 망가지는 지점

문서가 최우선으로 보라고 한 항목이라 행 단위로 대조했다.

- `posts.created_at` **1,707행 전부 마이크로초까지 일치** (MD5 대조).
- `replies`, `price_predictions`, `notifications`는 `created_at` + `updated_at`을 함께
  묶어 대조해도 **전부 일치**.
- `posts`의 `created_at`+`updated_at` 묶음만 어긋나는데, 대조 시점 이후 라이브 트래픽이
  건드린 3행 때문이다. `created_at`만 보면 완전히 일치한다.

> 대조할 때 MySQL `group_concat_max_len` 기본값이 1024바이트라 `GROUP_CONCAT`이 조용히
> 잘린다. `SET SESSION group_concat_max_len=1073741824`을 하지 않으면 멀쩡한 테이블도
> 불일치로 보인다. 컷오버에서 같은 대조를 한다면 반드시 걸어야 한다.

## 시퀀스

20개 테이블 전부 `last_value >= MAX(id)` 확인. 실제 INSERT로도 검증했다 —
`posts`에 넣으니 `MAX(id)=1755` 다음인 **1756**이 나왔다(확인 후 롤백).
`persons_images`, `whale_alerts`는 `id`가 없는 복합/문자열 PK라 시퀀스 대상이 아니다.

## 스모크 테스트

로컬 API를 리허설 DB에 붙여 확인했다. 전부 통과.

| 경로 | 결과 |
|---|---|
| `GET /posts?limit=5` (조인 + 반응 집계) | 200 |
| `GET /posts?query=비트코인` (ILIKE 검색) | 200 |
| `GET /posts?where=id:gte:1000` (새 DSL) | 200 |
| `GET /posts?where=1=1` | **400 `malformed filter`** |
| `GET /posts?where=bogusField:eq:1` | **400 `unknown field`** |
| `GET /posts?sort=bogus:desc` | **400 `unknown field`** |
| `GET /wallets`, `?join=Wallet.blockchain` | 200 / 200 (별칭 중복 가드 동작) |
| `GET /notifications` (boolean 컬럼) | 200 |
| `GET /dashboards/activities` — `start`만/`end`만/둘 다/없음 | 200 ×4, 집계값 정상 |
| `GET /webchat/messages` (86만 행 테이블) | 200 |
| `ws://…/webchat` 접속 | OPEN + auth 프레임 수신 |
| `POST /posts` (ORM 쓰기 경로) | 200, 한글 왕복 정상 |

`?where=id:eq:1 OR 1=1`은 400을 주는데, 문자열이 **파라미터로 바인딩되어** PostgreSQL이
integer 캐스팅에서 거부한 것이다(`22P02`). SQL이 주입되지 않았다는 증거이고 방어는
의도대로 동작한다. 다만 DSL 파서가 아니라 DB 오류가 새어 나오는 형태라, 메시지를
정돈하고 싶다면 후속 과제다(블로커 아님).

## 계획서에서 고쳐야 할 것

**Task 10 Step 5의 `GET /whale_alerts?...` 경로가 틀렸다.** 그런 라우트는 없다.
`whaleAlert`는 `useRouteCRUD`로 `/admin/whale_alerts`에 붙고 어드민 인증이 필요하며,
공개 경로는 `/onchain/whale_alert`다. 위 표에서는 `?where=` DSL을 `/posts`로 검증했다.
**Task 11 Step 6 smoke test에도 같은 오류가 있으니 그대로 따라 하지 말 것.**

## 컷오버 때 반드시 지킬 것

1. **리허설 DB가 그대로 운영 DB가 된다.** Task 11은 이 DB에 델타만 얹는다. 즉 리허설
   중에 PG에만 넣은 행은 운영에 그대로 남는다. 이번에 넣은 테스트 게시글은 삭제했고
   대조로 확인했다(`pg posts=1707`, `mysql posts=1707`). 추가 테스트를 한다면 같은
   정리가 필요하다.
2. **`--since`는 `~/migrate/started_at.txt`** = `2026-08-19T23:54:51Z`. 이 파일이 서버에
   그대로 있다. 컷오버 델타는 반드시 이 값을 쓴다.
3. 서버 기본 `node`가 **v12.22.9**라 이관 도구가 돌지 않는다. nvm의 v20을 명시해야 한다:
   `export PATH="$HOME/.nvm/versions/node/v20.11.0/bin:$PATH"`
4. 접속 URL의 비밀번호에 `@`와 `!`가 있어 **퍼센트 인코딩이 필요하다** (`%40`, `%21`).

## 서버에 남겨둔 상태

- `~/migrate/` — 도구 + `node_modules` + `started_at.txt`. 컷오버에서 그대로 재사용한다.
- PostgreSQL `coinsect` 롤/DB 생성 완료, 기준선 적용 완료, 데이터 적재 완료.
- 같은 인스턴스의 `gukto`, `calendar`, `everymaple`, `calendar_dev`는 건드리지 않았다.
- MySQL은 그대로 서비스 중이다.

## 클라이언트 3개 저장소 (2026-08-20 작업 완료)

세 저장소 모두 `feature/query-protocol` 브랜치에 커밋했다. **푸시하지 않았다** —
API와 함께 나가야 하므로 배포 시점에 맞춰 올린다.

| 저장소 | 커밋 | 검증 |
|---|---|---|
| `coinsect-nuxt` | `feat: 쿼리 빌더를 새 where DSL로 옮긴다` | 테스트 186개 통과, 타입 오류 증가 0 |
| `coinsect-web` | 〃 | 테스트 497개 통과, `nuxt typecheck` 종료 코드 0 |
| `coinsect-admin` | 〃 + `fix: 배열 쿼리 파라미터가 where[]로...` | lint 통과, `vite build` 성공 |

부록 B의 지시대로 옮겼고, 실제 API(리허설 DB)를 상대로 클라이언트가 만드는 URL을
그대로 호출해 확인했다 — 커뮤니티 목록/공지/키워드 검색, 대시보드 최근글, 고래알림
필터 4종, 비트코인 블로그 목록, 어드민 검색 연산자(`like`/`gt`/`eq`/boolean) 전부 200.

### 부록 B에 없던 것 두 가지

**1. axios가 배열을 `where[]`로 보냈다 (어드민, 실제 버그).**
`where`는 반복 파라미터인데 axios 기본 직렬화는 `where[]=a&where[]=b`를 만든다.
서버는 `query['where']`를 읽으므로 키가 어긋나 **필터가 조용히 전부 무시된다** — 400도
안 나고 결과만 틀린다. 실제 요청을 떠서 확인했고 `paramsSerializer`로 고쳤다.
`coinsect-nuxt`/`coinsect-web`이 쓰는 ofetch(ufo)는 원래부터 `where=a&where=b`로
펼치므로 문제가 없었다(이것도 직접 확인했다).

**2. 어드민 빌더의 `queryParams`는 계속 공개해야 한다.**
부록 B의 공통 빌더 형태는 상태를 클로저에 감추는데, `DataTable.vue`가
`queryParams.limit`/`offset`을 읽고 `delete queryParams.where`로 검색을 초기화한다.
`where`를 그 객체 안의 배열로 두어 기존 초기화 방식이 그대로 동작하게 했다.

### 후속 과제 (블로커 아님)

- **`where` 개수 상한 10과 어드민 검색창.** `user`, `post`는 검색 가능한 컬럼이 13개다.
  운영자가 10개를 넘겨 입력하면 400이 난다. 실사용에선 1~3개를 쓰므로 당장 문제는
  아니지만, 상한을 올리든 클라이언트에서 막든 정리가 필요하다.
- **`/posts/with_llm`이 모든 오류를 404로 덮는다.** `allWithLLM` 컨트롤러의 catch가
  `boardId/question` 누락(400)도 LLM 호출 실패도 똑같이 `NOT_FOUND` 404로 만든다.
  리허설에서 파라미터 이름이 맞는지 확인하려면 상태코드로는 안 되고 로그를 봐야 했다.

## 남은 것

Task 11(컷오버)만 남았다. 클라이언트 3개는 위와 같이 끝났으므로, 컷오버 때
`feature/query-protocol` 세 브랜치를 머지해 **API와 같은 창에서 함께 배포한다.**
API를 먼저 올리면 그 사이 커뮤니티 목록·고래알림 필터·어드민 테이블 검색이 전부 400을
뱉는다.

### `EC2_ORMCONFIG` 시크릿 주의

리허설용으로 로컬에 만든 `ormconfig.ts`는 `host`가 `webserver.coinsect.io`다 —
로컬에서 원격 DB에 붙기 위한 값이다. **운영 API는 그 서버 안에서 도는 만큼 `host`를
`localhost`로 두어야 한다.** 리허설 파일을 그대로 시크릿에 넣으면 앱이 자기 자신에게
공용 인터넷을 돌아 접속하게 된다. 나머지 필드는 그대로 쓰면 된다.
