# 목록 조회 쿼리 프로토콜

`orm.querySetter`를 쓰는 모든 목록 엔드포인트가 받는 공통 쿼리 파라미터다.
`coinsect-nuxt`와 `coinsect-admin`이 이 계약에 맞춰 요청을 만든다. 세 저장소의 단일
출처이므로, 문법을 바꾸려면 이 문서를 먼저 고친다.

2026-08-19 이전에는 `where`가 임의 SQL 조각이었고 서버가 그대로 WHERE 절에 이어
붙였다. 인증 없는 공개 엔드포인트에서도 그랬다. 지금은 아래 문법만 받는다.

## 파라미터

| 이름 | 형식 | 설명 |
|---|---|---|
| `limit` | 정수 | 0 이상. 상한 1000 |
| `offset` | 정수 | 0 이상 |
| `sort` | 컬럼명 | 엔티티에 실재하는 컬럼만 |
| `order` | `asc` \| `desc` | 기본 `desc` |
| `where` | `필드:연산자:값` | 반복 가능. 여러 개는 AND로 묶인다 |
| `join` | `별칭.관계명` 쉼표 구분 | 실재하는 관계만 |

## `where` 문법

```
필드:연산자:값
```

- **필드** — 엔티티 프로퍼티명(`amountUsd`)과 DB 컬럼명(`amount_usd`) 둘 다 받는다.
  실재하지 않으면 400.
- **연산자** — `eq` `ne` `gt` `gte` `lt` `lte` `like` `in` `isnull`. 그 외는 400.
- **값** — 첫 두 콜론 뒤는 전부 값이다. `hash:eq:a:b:c`의 값은 `a:b:c`.

| 연산자 | 예 | SQL |
|---|---|---|
| `eq` | `boardId:eq:1` | `board_id = $1` |
| `ne` | `postType:ne:notice` | `post_type <> $1` |
| `gt` `gte` `lt` `lte` | `amountUsd:gte:3000000` | `amount_usd >= $1` |
| `like` | `title:like:비트코인` | `title ILIKE '%비트코인%'` |
| `in` | `symbol:in:BTC,ETH` | `symbol IN ($1, $2)` |
| `isnull` | `deletedAt:isnull:true` | `deleted_at IS NULL` |

`like`의 값에 든 `%`와 `_`는 리터럴로 이스케이프된다. 사용자가 조건을 넓힐 수 없다.

### 여러 조건

`where`를 반복해서 넘긴다. AND로 묶인다.

```
?where=postType:eq:normal&where=boardId:in:1,2
```

OR나 괄호 그룹은 지원하지 않는다. 필요하면 그 엔드포인트에 이름 붙은 전용 파라미터를
만든다 — 예: 고래알림의 `excludeBetweenSameExchange=true`.

### 상한

| 항목 | 상한 |
|---|---|
| `where` 개수 | 10 |
| 값 길이 | 200자 |
| `in`의 값 개수 | 50 |
| `join` 개수 | 10 |
| `limit` | 1000 |

## 인코딩

값을 미리 `encodeURI`로 감싸지 **말 것.** HTTP 계층이 한 번만 인코딩한다. 서버는 디코딩을
추가로 하지 않는다. 예전에는 클라이언트가 `encodeURI`를 걸고 서버가 `decodeURI`로
되돌렸는데, 값에 공백이 들어가면 `%20`이 리터럴로 남는 구조였다.

## 목록 외 파라미터

프로토콜 밖이지만 함께 정리한 것들이다.

| 엔드포인트 | 파라미터 | 비고 |
|---|---|---|
| `GET /posts` | `keyword` | 예전 `query=keyword=값`을 평평하게 폈다 |
| `GET /price_predictions` | `keyword` | 위와 동일 |
| `GET /posts/with_llm` | `boardId`, `question` | 예전 `board_id`, `query` |
| `GET /onchain/whale_alert` | `excludeBetweenSameExchange` | `true`면 한쪽만 알려진 주체인 거래만 |

## 오류

문법이나 화이트리스트를 어기면 `400`과 함께 사유가 돌아온다.

```json
{ "message": "unknown field: nope" }
```
