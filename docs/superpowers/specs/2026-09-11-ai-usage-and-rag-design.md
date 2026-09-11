# AI 사용량 계측과 RAG 검색 설계

- 작성일: 2026-09-11
- 범위: `coinsect-api` (프론트는 검색바 경로만 바뀐다)
- 상태: 설계 승인됨 (구현 계획 대기)

## 1. 배경

이 레포에 AI를 부르는 자리는 두 곳이다.

| 자리 | 모델 | 호출 수 | 계측 |
|---|---|---|---|
| `real_time_position.autoParse` | `gemini-3.8-flash` (고정됨) | 프레임당 1회, 읽히면 중단 | 계산은 하지만 슬랙 한 줄로 쓰고 버린다 |
| `postService.allWithLLM` | `gemini-flash-latest` (떠다니는 별칭) | 질문당 2회 | 없다 |

둘 다 "이번 달에 얼마 썼나"를 물으면 답할 수 없다. 판독 쪽은 제보 메시지에 한 줄로
남지만 그 메시지는 승인하면 사라지고, `allWithLLM`은 애초에 아무것도 남기지 않는다.

`allWithLLM`은 구조도 낡았다. 보드의 **모든 글을 꺼내 제목을 전부 프롬프트에 붙여**
3개를 고르게 하고, 고른 글의 본문을 통째로 다시 붙여 답을 받는다. 글이 늘어나면
첫 호출의 입력이 선형으로 늘고, 제목만 보고 고르므로 본문에만 있는 내용은 찾지 못한다.

자유게시판 검색은 `postService.all`의 `keyword` 분기다. 제목·본문·닉네임에 ILIKE
부분일치를 건다. 인덱스가 없어 매번 순차 스캔이고, 동의어나 표현이 다르면 못 찾는다.

## 2. 사전 확인 (2026-09-11 실측)

프로덕션에서 직접 확인한 값이다.

```
psql (PostgreSQL) 16.14 (Ubuntu 16.14-1.pgdg22.04+1)
vector|0.8.5|          -- 설치 가능, 아직 설치 안 됨
pg_trgm|1.6|           -- 설치 가능, 아직 설치 안 됨
```

코퍼스 규모:

| 보드 | id | 글 | 본문 글자 수 |
|---|---|---|---|
| free_board | 1 | 1,630 | 3,554,102 |
| technical_analysis | 2 | 0 | 0 |
| bitcoin_blog | 3 | 55 | 312,603 |
| coinsect_blog | 4 | 28 | 73,746 |
| everymaple | 5 | 0 | 0 |

여기서 나오는 수치:

- 800자 청크 기준 약 6,000청크. 1536차원 float4면 벡터만 **37MB**다.
- 전체 백필 임베딩은 약 300만 토큰, `$0.15 / 1M` 기준 **$0.5 미만**이다. 한 번만 든다.
- 서버는 2 vCPU / 3.8GB에 이미 스왑을 쓰고 있다(topology 참고). 37MB와 HNSW 인덱스는
  얹을 만하지만, 차원을 3072으로 올리거나 청크를 잘게 쪼개는 선택은 이 상자에서 위험하다.

## 3. 범위와 순서

독립된 두 작업이다. **A를 먼저 끝내고 B를 붙인다.** B가 만드는 호출(임베딩, 답변)이
A의 계측 위에 얹혀야 하기 때문이다. 순서를 뒤집으면 RAG를 켠 첫 달의 비용을 모른다.

- **A. AI 사용량 계측.** 기존 두 자리에 계측을 붙이고 표 둘을 만든다.
- **B. RAG.** 벡터 인덱스를 만들고, 자유게시판에 하이브리드 검색을 내고, `allWithLLM`을
  회수 기반으로 다시 쓴다.

## 4. A. AI 사용량 계측

### 4.1 `ai_usage` — 호출 한 건이 한 행

```
id            serial      PK
created_at    timestamptz
task          varchar(32)  'position_read' | 'post_answer' | 'embed_index' | 'embed_query'
model         varchar(64)
input_tokens  integer
output_tokens integer
thinking_tokens integer
cost_micros   integer      USD의 100만분의 1, 정수
latency_ms    integer
ok            boolean
error         text         null 가능. 실패한 호출도 행을 남긴다
ref_type      varchar(32)  null 가능. 'streamer' | 'post'
ref_id        varchar(64)  null 가능
requester     varchar(64)  null 가능. 'desktop' | 'cron' | ip
```

인덱스는 `(created_at)`과 `(task, created_at)` 둘이다. 조회는 항상 기간이 먼저다.

**실패한 호출도 행을 남기는 이유.** 토큰이 0이어도 호출 수는 이상 징후다. 어느 날
`ok = false`가 치솟으면 모델이 바뀌었거나 키가 죽은 것이고, 행이 없으면 그게 안 보인다.

**비용을 정수 micros로 두는 이유.** 부동소수를 누적하면 오차가 쌓인다. 호출 한 건이
$0.003 수준이라 소수 여섯째 자리까지 필요하고, micros면 정수로 정확히 담긴다.
원화가 아니라 달러인 이유는 청구서가 달러로 오고 환율은 우리가 정하는 값이 아니라서다.
원화로 적으면 환율이 움직인 뒤 과거 기록이 조용히 틀린 값이 된다.

**보관 90일.** 그 뒤에는 지운다. 하루 수백 행 규모라 용량 문제는 아니지만, 되짚을 일이
없는 데이터를 영원히 들고 있을 이유도 없다.

### 4.2 `ai_usage_daily` — 날짜·모델·태스크당 한 행

```
day           varchar(10)  UTC 'YYYY-MM-DD'    ┐
model         varchar(64)                      ├ 복합 PK
task          varchar(32)                      ┘
requests      integer
tokens_in     bigint
tokens_out    bigint
tokens_thinking bigint
cost_micros   bigint
```

영구 보관한다. 하루 몇 행이라 1년 쌓여도 수천 행이다.

**모델이 키에 들어가는 이유.** 단가표가 틀렸던 것이 나중에 드러나도 모델별 토큰이
남아 있으면 다시 계산할 수 있다. 한 칸에 합치면 그 순간 되돌릴 수 없는 숫자가 된다.

**`bigint`인 이유.** 서비스 전체 합이라 `integer`의 상한($2,147)에 언젠가 닿는다.
raw 쪽은 호출 한 건이라 `integer`로 충분하다.

### 4.3 단가표와 미상 모델

새 단가표를 만들지 않는다. `services/content/model_usage.ts`의 `MODEL_PRICING`을 그대로
쓰고 임베딩 모델을 더한다.

```ts
'gemini-embedding-001': { input: 0.15, output: 0 },
```

임베딩은 출력 토큰이 없다. 출력 단가를 0으로 두면 곱셈 하나로 같은 경로를 쓴다.

**`costOf`의 미상 모델 처리를 바꾼다.** 지금은 표에 없으면 0을 돌려준다. 이러면 새
모델을 붙인 날 비용이 조용히 사라지고, 나중에 청구서를 보고서야 안다. 표에서 가장 비싼
값으로 계산하고 `log.error`를 남기는 쪽으로 바꾼다. **과대평가는 알림을 부르지만
과소평가는 청구서를 부른다.**

기존 호출부(`addUsage`, `mergeUsage`, 벤치)는 시그니처가 그대로라 영향이 없다.

### 4.4 기록 모듈 `services/ai_usage.ts`

```ts
aiUsage.record({ task, model, usageMetadata, latencyMs, ok, error, ref, requester })
```

- **던지지 않는다.** 계측이 본래 동작을 막으면 안 된다. 내부에서 잡아 `log.error`만 남긴다.
- **기다리지 않는다.** 호출부는 `void`로 던져 놓고 진행한다.
- `usageMetadata`는 Gemini SDK가 주는 것을 그대로 받는다. 토큰 추출과 비용 환산은
  이 모듈 안에서 `model_usage.ts`를 불러 한다. 호출부마다 다시 계산하지 않는다.

### 4.5 붙는 자리

1. **`real_time_position.autoParse`.** 이미 `addUsage`로 사용량을 만든다. `task: 'position_read'`,
   `ref: { type: 'streamer', id: positionId }`로 한 줄 더한다. 프레임을 여러 장 보면 호출도
   여러 번이므로 **행도 여러 개** 남는다. 기존의 `usage` 누계(슬랙 한 줄)는 그대로 둔다.
2. **`postService.allWithLLM`.** `task: 'post_answer'`, `requester`는 요청 IP다.
   B에서 이 함수가 다시 쓰이지만 계측 자리는 같다.
3. **B의 임베딩 경로.** `embed_index`(인덱싱)와 `embed_query`(검색)를 나눈다. 둘을 합치면
   "검색이 비싼가 인덱싱이 비싼가"를 나중에 분리할 수 없다.

**모델 고정.** `allWithLLM`의 `gemini-flash-latest`를 `gemini-3.8-flash`로 못 박는다.
별칭은 구글이 다음 티어로 옮기는 순간 배포도 하지 않았는데 단가와 판독 성향이 함께
바뀌고, 단가표에 그 이름이 없어 비용이 미상으로 기록된다. 판독 쪽이 같은 이유로 이미
고정돼 있다. **이 모델은 2027-01-01에 $1.50 / $7.50으로 두 배가 된다** — 그날이 오면
`MODEL_PRICING`을 같이 고쳐야 한다. 표를 안 고치면 기록된 원가만 절반으로 남는다.

### 4.6 cron

`services/cron.ts`에 야간 작업 둘을 더한다. 하루 한 번이면 충분하므로 24시간 주기로 두되,
`cron.addJob`이 프로세스 시작 시각 기준이라 재배포가 잦으면 여러 번 돌 수 있다.
**집계는 멱등이어야 한다** — 전날 raw를 다시 훑어 `ON CONFLICT DO UPDATE`로 덮어쓴다.
더하지 않고 덮어쓰는 것이 핵심이다.

1. `rollupAiUsage` — 어제(UTC) raw를 `(day, model, task)`로 묶어 daily에 upsert.
2. `pruneAiUsage` — 90일 지난 raw 삭제.

### 4.7 조회

`GET /admin/ai_usage?from=&to=` — daily 행을 돌려준다. 어드민 인증 미들웨어를 건다.
화면은 `coinsect-admin`이라 이번 범위 밖이다.

## 5. B. RAG

### 5.1 스키마

확장 둘을 켠다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

**`post_chunks`**

```
id            serial      PK
created_at    timestamptz
updated_at    timestamptz
post_id       integer     not null
board_id      integer     not null
chunk_index   integer     not null default 0
content       text        not null
content_hash  varchar(64) not null
model         varchar(64) not null
embedding     vector(1536)            -- null 가능: 청크는 만들었으나 임베딩 전
```

```sql
CREATE UNIQUE INDEX post_chunks_source_unq ON post_chunks (post_id, chunk_index);
CREATE INDEX post_chunks_board_idx ON post_chunks (board_id);
CREATE INDEX post_chunks_embedding_hnsw_idx ON post_chunks USING hnsw (embedding vector_cosine_ops);
```

`board_id`를 중복해 두는 이유는 검색 경로에서 `posts` 조인 없이 보드로 거르기 위해서다.
글이 보드를 옮기는 일은 없다시피 하고, 있다면 재인덱싱 경로가 같이 고친다.

**`embedding_jobs`**

```
id            serial      PK
created_at    timestamptz
updated_at    timestamptz
post_id       integer     not null
content_hash  varchar(64)
status        varchar(20) not null default 'pending'   -- pending|running|done|failed
attempts      integer     not null default 0
last_error    text
locked_at     timestamptz
locked_by     varchar(100)
```

```sql
CREATE INDEX embedding_jobs_status_idx ON embedding_jobs (status, created_at);
```

`locked_at`/`locked_by`는 지금 당장은 필요 없다. API가 단일 프로세스이기 때문이다.
그래도 넣는 이유는 이 칸이 없으면 프로세스를 나누는 순간 같은 잡을 둘이 잡아 임베딩
비용이 두 배가 되고, 그때 가서 칸을 더하려면 이미 쌓인 잡을 손봐야 하기 때문이다.

**`embedding_cache`**

```
content_hash  varchar(64)  ┐
model         varchar(64)  ├ 복합 PK
dims          integer      │
task          varchar(1)   ┘   -- 'd'(document) | 'q'(query)
embedding     vector(1536) not null
created_at    timestamptz
```

**차원과 taskType이 키에 함께 들어간다.** 같은 텍스트라도 이 둘이 다르면 다른 벡터다.
빠뜨리면 차원을 바꾸거나 taskType을 고쳐도 캐시가 옛 벡터를 돌려주고, 그 벡터는 새로
만든 것들과 같은 공간에 있지 않아 검색이 조용히 망가진다.

**문서와 질의가 같은 표를 쓴다.** scheduly는 문서만 캐시하고 질의는 매번 API를 친다.
로그인 사용자만 쓰는 서비스라 그래도 되지만, 자유게시판 검색은 익명 공개라 같은 질의가
반복해서 들어온다. 질의 캐시가 그쪽보다 중요하다.

**`posts`의 trigram 인덱스**

```sql
CREATE INDEX posts_title_trgm_idx ON posts USING gin (title gin_trgm_ops);
CREATE INDEX posts_content_trgm_idx ON posts USING gin (content gin_trgm_ops);
```

PostgreSQL 기본 전문검색은 한국어에서 무력하다. 조사와 어미가 붙은 토큰을 갈라내지
못한다. pg_trgm은 부분문자열 기반이라 어간이 남아 있으면 걸린다.

**TypeORM과 `vector` 타입.** TypeORM은 이 타입을 모른다. 엔티티에 `embedding` 칸을
매핑하지 않고, 벡터의 읽기와 쓰기는 `dataSource.query`로 간다. 나머지 칸은 평범한
엔티티로 둬서 잡 관리와 청크 정리는 리포지터리로 한다.

### 5.2 임베딩 모델과 차원

`gemini-embedding-001`, **1536차원**이다.

- 원본은 3072이지만 pgvector의 HNSW 인덱스가 2000차원 상한이다.
- 768로 줄이면 미세한 구분이 먼저 사라지고 굵은 주제 축만 남아, 무관한 문서끼리도
  점수가 붙는다. scheduly가 768에서 1536으로 올린 이유다.
- 축소 차원은 사전 정규화가 되어 있지 않다. **받은 벡터를 단위 길이로 정규화해 저장한다.**
  안 하면 코사인 거리 연산이 어긋난다.

문서는 `RETRIEVAL_DOCUMENT`, 질의는 `RETRIEVAL_QUERY`로 넣는다. 둘을 같은 방식으로
넣으면 관련 문서와 무관 문서의 점수 간격이 좁아진다.

### 5.3 청킹

800자, 겹침 120자. 단락(`\n\n`) 경계로 자르고, 한 단락이 상한을 넘으면 문장으로 쪼갠다.
겹침은 앞 청크의 꼬리를 다음 청크 머리에 붙이되 첫 공백까지는 버려 단어 중간에서
시작하지 않게 한다.

**겹침이 필요한 이유.** 없으면 경계에 걸린 내용이 양쪽 어디에서도 온전하지 않다. 주제어는
앞 청크에, 사실은 뒤 청크에 남아 뒤 청크의 임베딩에 주제 신호가 아예 들어가지 않는다.

**청크 입력에 제목을 붙인다.** `{title}\n\n{chunk}` 형태다. 자유게시판 글은 짧고 본문만으로는
무엇에 관한 글인지 모르는 경우가 많다. 제목은 그 글에서 가장 압축된 주제 신호다.

글자 수 기준이라 토큰 수와 정확히 대응하지 않는다는 한계는 안다. 한국어에서 800자는
대략 500~600토큰이다. 이 규모에서 토크나이저를 붙일 만큼의 이득은 없다.

### 5.4 인덱싱 파이프라인

**등록.** `post_controller`의 `create`/`update`/`delete` 셋에서 부른다. 별도 subscriber를
두지 않는다. 이 레포에는 subscriber가 하나도 없고, 세 자리를 눈으로 보는 편이 낫다.

- create/update → `enqueue(postId)`. 같은 글의 pending 잡이 있으면 해시만 갱신한다.
- delete → 청크를 **즉시 하드 삭제**하고 pending 잡도 지운다.

**삭제를 미루지 않는 이유.** 검색에 잡히는데 눌러보면 없는 글로 가는 유령 결과가
생긴다. 벡터 행이 용량의 대부분이기도 하다. 소프트 삭제(`deleted_at`)여도 청크는 지운다.
복구되면 재인덱싱하면 된다.

**배수(drain).** cron 1분 주기.

1. `pending` 잡을 오래된 순으로 N개(기본 20) 잠근다.
2. 글을 읽는다. 없거나 지워졌으면 청크를 지우고 `done`으로 넘긴다.
3. `{제목}\n\n{본문}`을 청킹한다.
4. 청크별 해시로 `embedding_cache`를 먼저 본다. **없는 것만** 임베딩 API를 친다.
   동시 5개까지. 올리면 빨라지지만 rate limit에 걸리기 쉽다.
5. 청크를 `(post_id, chunk_index)` 기준으로 upsert하고, **새 청크 수보다 큰 index의 옛
   청크를 지운다.** 글이 짧아졌을 때 꼬리가 남는 것을 막는다.
6. `done`으로 표시한다. 실패하면 `attempts`를 올리고 `last_error`를 적는다.
   5회를 넘으면 `failed`로 두고 더 시도하지 않는다. 조용히 무한 재시도하면 API 비용만 태운다.

**백필.** `tools/backfill_post_embeddings.ts`가 대상 보드의 전 글을 잡으로 등록하고 끝난다.
임베딩은 cron이 소화한다. 한 번에 몰아치지 않아 rate limit에 걸리지 않고, 중간에 죽어도
잡이 남아 이어서 돈다. 1,713건이면 1분에 20건씩 약 1시간 30분이다.

### 5.5 검색 `GET /posts/search`

**라우트 등록 순서에 주의한다.** `/posts/:sharingKey`보다 **앞에** 둬야 한다.
`with_llm`이 이미 같은 이유로 앞에 있다.

파라미터는 `q`(필수), `boardId`(선택), `limit`(기본 20)이다.

**병렬로 두 경로를 돌린다.**

- **벡터.** 질의를 `RETRIEVAL_QUERY`로 임베딩(캐시 먼저)하고, `post_chunks`에 코사인
  거리로 질의한다. 컷오프 미만은 버린다.
- **키워드.** `posts` 원본을 trigram 인덱스로 훑는다. 공백으로 자른 토큰 최대 8개,
  2글자 미만은 버린다. **청크가 아니라 원본을 본다** — 아직 인덱싱되지 않은 글(방금
  쓴 글, 임베딩 실패분)을 첫 검색부터 찾아낸다.

**융합.** RRF(K=60). 키는 `post_id`다. 융합 전에 **벡터 결과를 글당 최고 청크 하나로
접는다.** 안 그러면 같은 리스트에서 점수가 여러 번 더해져, 조각이 많은 긴 글이 단지
조각 수 때문에 상위를 차지한다. RRF는 리스트당 한 항목이 한 번 등장한다고 전제한다.

후보 깊이는 `max(limit * 3, 30)`이다. 융합은 순위만 쓰므로 후보가 얕으면 합칠 것이 없다.

**응답.**

```json
{ "data": [ { ...post, "score": 0.78, "matchType": "both" } ], "total": 12 }
```

`score`는 벡터 매칭이 있을 때만 코사인 유사도(0~1)이고 키워드 전용이면 `null`이다.
**RRF 점수를 여기 넣지 않는다.** 화면이 백분율로 보여주는 자리라 의미가 달라진다.
`matchType`은 `vector` | `keyword` | `both`다.

기존 `/posts?keyword=`는 손대지 않는다. 어드민과 목록이 같이 쓰고 `limit`/`offset`
페이지네이션을 전제로 돌기 때문이다. 프론트는 검색바만 새 경로로 바꾼다.

**유사도 컷오프는 백필 뒤에 실측으로 정한다.** scheduly의 0.71은 그쪽 코퍼스(업무 노트와
일정)에서 나온 값이고, 우리 코퍼스는 비트코인 글과 잡담이라 점수 분포가 다르다.
`tools/calibrate_search.ts`가 무관한 질의 6종과 관련 질의 6종을 넣어 두 분포의 간격을
재고, 그 사이에 선을 긋는다. **측정값과 날짜를 코드 주석에 남긴다.** 모델이나 차원을
바꾸면 분포가 통째로 이동하므로 그때마다 다시 잰다.

컷오프는 벡터 경로에만 건다. 키워드 경로는 부분문자열이 실제로 들어 있다는 사실 자체가
근거다.

**알려진 한계.** HNSW는 인덱스가 먼저 후보를 고르고 `board_id` 필터가 그 뒤에 걸린다.
필터가 셀 때 결과가 요청한 수보다 적게 나올 수 있다(pgvector의 고전적 함정). 우리는
보드가 셋뿐이고 가장 큰 보드가 전체의 9할이라 심하게 물리지 않는다. 후보 깊이를 넉넉히
두는 것으로 완화하고, 보드가 늘어나면 부분 인덱스를 고려한다.

### 5.6 `with_llm` 재구성

지금:

```
전 글 조회 → 제목 전부를 프롬프트에 → 3개 선택          (호출 1)
선택된 글 본문 전부를 프롬프트에 → 답변                 (호출 2)
```

바꾼 뒤:

```
질의 임베딩(캐시) → 상위 청크 6개 회수 → 답변            (호출 1)
```

- 회수는 5.5의 하이브리드 검색을 그대로 쓴다. 검색과 답변이 같은 회수 계층을 본다.
- 답변 프롬프트에는 **청크만** 넣는다. 글 전문이 아니다.
- 근거 글 목록(`data`)은 회수된 청크의 글로 만든다. 중복은 접는다.
- **응답 모양은 그대로다.** `{ data, total, answer: { kr, en } }`. `ModalBitcoinGPT`는
  수정이 없다.

비용은 `bitcoin_blog` 기준 호출 2회 · 입력 1만 토큰대에서 호출 1회 · 3천 토큰대로 내려간다.
지연도 절반이다. 글이 늘어도 입력이 늘지 않는 것이 더 중요하다.

회수 결과가 비면 모델을 부르지 않고 빈 답을 준다. 근거 없이 답하게 두면 그럴듯한
거짓말이 나온다.

### 5.7 공개 엔드포인트 방어

`/posts/search`와 `/posts/with_llm`은 인증이 없다. 세 겹으로 막는다.

1. **질의 임베딩 캐시.** 같은 질의는 API를 다시 치지 않는다.
2. **IP당 속도 제한.** 이 레포에는 속도 제한 장치가 아예 없다. Redis 카운터로 만든다
   (`USE_REDIS=yes`가 이미 켜져 있다). 검색은 분당 30회, 답변은 분당 5회에서 시작한다.
   초과는 429다.
3. **일일 전역 비용 상한.** `ai_usage_daily`의 오늘 합이 상한을 넘으면 **답변만** 끈다.
   검색은 계속 동작한다 — 캐시와 키워드 경로는 임베딩 없이도 돌아간다. 한도 때문에
   검색이 통째로 죽는 것보다 결과가 줄어드는 편이 낫다. 상한은 환경변수로 둔다.

개인 한도가 없는 공개 서비스에서 전역 상한은 마지막 방어선이다. 사람이 깨어나기 전에
서비스가 스스로 멈춰야 한다.

## 6. 스키마 적용

**마이그레이션 체계를 도입하지 않는다.** 이 레포는 나중에 다시 쓸 예정이고, 지금 필요한
것은 "작업이 끝난 시점의 엔티티 파일과 DB가 일치하는 스냅샷"이다.

- `tools/sql/`에 번호를 붙인 `.sql` 파일을 둔다. 확장, 테이블, 인덱스, 그리고 기존
  `posts`의 trigram 인덱스까지 전부 여기 적는다.
- 서버에서 `psql`로 직접 돌린다. `tools/migrate`가 이미 같은 결의 운영 스크립트다.
- 모든 문장은 `IF NOT EXISTS`를 붙여 두 번 돌려도 안전하게 한다.
- 엔티티 파일과 SQL이 어긋나지 않는지 마지막에 눈으로 대조한다.

## 7. 테스트

이 레포의 기존 테스트는 DB를 띄우지 않고 전부 스텁이다. 같은 방식을 따른다.
순수 함수로 뺄 수 있는 것을 최대한 뺀다.

| 대상 | 무엇을 검사하나 |
|---|---|
| `costOf` | 미상 모델이 0이 아니라 최고 단가로 계산되는지 |
| `rollup` | 같은 날을 두 번 집계해도 값이 두 배가 되지 않는지 |
| `aiUsage.record` | DB가 죽어도 호출부에 예외가 새지 않는지 |
| `chunkText` | 경계, 겹침, 한 단락이 상한을 넘는 경우, 빈 입력 |
| `fuseRRF` | 두 리스트 융합, 같은 키 합산, 동점 시 안정 정렬 |
| `cacheKey` | 차원이나 taskType이 바뀌면 키가 갈리는지 |
| `drain` | 잡 하나를 두 번 처리해도 청크가 중복되지 않는지 |
| 청크 정리 | 글이 짧아졌을 때 꼬리 청크가 남지 않는지 |

벡터 SQL은 단위 테스트로 덮이지 않는다. 백필 뒤 `tools/calibrate_search.ts`의 실측으로
확인하고, 그 수치를 주석에 남긴다.

## 8. 실패 모드

| 상황 | 무슨 일이 나나 | 대응 |
|---|---|---|
| 임베딩 API 장애 | 인덱싱이 밀린다 | 잡이 pending으로 남아 다음 주기에 다시 돈다. 검색은 키워드 경로로 계속 동작 |
| 임베딩이 계속 실패 | 같은 잡을 무한 재시도 | 5회에서 `failed`로 두고 멈춘다 |
| 계측 기록 실패 | 비용을 못 센다 | 던지지 않는다. 로그만 남기고 본래 동작은 진행 |
| 집계 cron이 여러 번 돎 | 비용이 부풀어 보인다 | upsert가 더하지 않고 덮어쓴다 |
| 글이 지워졌는데 청크가 남음 | 유령 검색 결과 | 삭제 경로에서 하드 삭제. 검색 SQL에도 살아있는 글 확인을 건다 |
| 단가표에 없는 모델 | 비용이 0으로 기록 | 최고 단가로 계산하고 error 로그 |
| 공개 엔드포인트 남용 | 비용 폭주 | 속도 제한 + 일일 전역 상한. 상한에 닿으면 답변만 중단 |

## 9. 범위 밖

- **댓글(`replies`) 인덱싱.** 자유게시판 검색은 글만 본다. 댓글까지 넣으면 청크가
  크게 늘고, 짧은 댓글은 임베딩 신호가 약하다. 필요해지면 별도로 다룬다.
- **리랭커.** 이 규모에서 얻는 것보다 지연과 비용이 크다.
- **질의 확장, HyDE.** 같은 이유다.
- **어드민 비용 화면.** `coinsect-admin`은 별도 레포다. API까지만 낸다.
- **포지션 판독의 멀티프레임 개선.** 별건이다.
