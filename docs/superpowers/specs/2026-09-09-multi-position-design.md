# 스트리머 1 : 포지션 N 설계

- 작성일: 2026-09-09
- 선행: [가정용 캡처 서비스와 슬랙 승인 설계](./2026-09-08-desktop-capture-agent-design.md),
  [데스크톱 캡처 인수인계](./2026-09-08-desktop-capture-handoff.md)

## 1. 배경

방송인은 BTC 하나만 잡지 않는다. 2026-09-09 관측: 박호두는 ZEC / VVV / 4 세 개를,
짭구는 BTC 하나를, 사또는 SOL 하나를 잡고 있었다. 지금 구조는 **스트리머 = 포지션 1개**라
나머지를 버린다.

2026-09-09에 판독 쪽은 이미 다중 포지션을 받도록 바꿨다. 모델이 읽은 포지션을 전부
배열로 내놓고 `pickPosition`이 명목가(|수량| x 진입가)로 대표 하나를 고른다.
**버려지는 지점이 판독에서 저장으로 옮겨갔을 뿐이다.** 이 스펙은 그 뒤를 마저 뚫는다.

지금도 "동일인을 여러 번 등록"하는 우회는 가능하다. 하지만 `desktopTargets`가 포지션
단위로 나가므로 **같은 스트리머를 N번 캡처한다.** Gemini 호출도 N배, 같은 집 IP에서
유튜브를 두드리는 횟수도 N배다. 봇 차단을 자초하는 구조라 우회로 두면 안 된다.

## 2. 지금 1:1이 박혀 있는 곳

| 위치 | 무엇이 1:1인가 |
|---|---|
| `constants/position_presets.ts` | 프리셋 한 줄 = 스트리머 + 포지션 |
| `services/content/real_time_position.ts` `IRealTimePosition` | 스트리머 필드와 포지션 필드가 한 객체 |
| `desktopTargets` | 포지션 id를 캡처 대상 id로 준다 |
| `desktopReport` / 제보함 | 제보 키가 포지션 id |
| `set()` | 포지션 필드 4개를 통째로 덮어쓴다 |
| `broadcast` / 푸시 | 스트리머당 알림 1회 = 포지션 1개 |
| `GET /contents/real_time_positions` | 평탄한 배열 |
| coinsect-nuxt `useRealTimePositions.ts` | `RealTimePosition`이 스트리머+포지션 |
| coinsect-nuxt `CPosition.vue` | 카드 = 스트리머 헤더 + 포지션 본문 |
| coinsect-admin `ViewRealTimePositions.vue` | 행 = 스트리머 + 포지션 |

`coinsect-web`은 이 API를 쓰지 않는다(2026-09-09 확인). 파급은 **api / nuxt / admin 셋**이다.

## 2.5 구현 완료 (2026-09-09)

api / admin / nuxt 셋 다 배포했다. 프로덕션에서 실제 캡처 클라이언트를 한 바퀴 돌려
박호두의 **ZEC + VVV 두 포지션**이 제보로 올라가고, 이미지가 CDN에서 200으로 읽히고,
슬랙 체크박스 메시지가 발송되는 것까지 확인했다.

설계에서 바뀐 것 두 가지:

1. **슬랙 선택 상태를 `state.values`로 읽지 않는다.** §7.1이 확인 과제로 남겼던 부분인데,
   확인 대신 우회했다. 체크박스를 토글할 때마다 오는 `selected_options`(액션 자신의 값,
   문서가 보장한다)를 제보함에 적어두고 승인 클릭이 그것을 읽는다. 봇 토큰도
   `trigger_id` 3초 제한도 필요 없다.
2. **기본은 전부 체크.** 판독이 대개 맞으므로 틀린 것만 체크를 푸는 쪽이 클릭이 적다.

**아직 사람 손이 필요한 것: 슬랙 체크박스를 실제로 토글하고 승인을 눌러보는 것.**
프로덕션 제보함에 박호두 제보가 살아 있어 버튼이 동작한다. 승인하면 실제 포지션이
반영되고 유저에게 푸시가 나간다.

## 3. 이미 정해진 것

운영자와 합의된 사항이다. 이 스펙은 이걸 전제로 쓴다.

- **프론트 표현**: 대표 포지션 1개를 카드에 보여주고 나머지는 "다른 포지션 N개"로 접는다
- **알림**: **대표 포지션이 바뀌었을 때만** broadcast/푸시를 보낸다. 사이드 포지션이
  꿈틀거려도 조용하다
- **슬랙 승인**: 제보 메시지 안에 체크박스를 두고, 사람이 화면과 **일치하는 것만 체크해
  승인**한다. 하나도 체크하지 않으면 승인은 거부되고 전체 거절만 가능하다
- **하위 호환은 버린다.** 운영자가 빅뱅 업데이트를 허용했다. API 응답 모양을 그대로
  유지하려고 구조를 비틀지 않는다
- **대표 선택 기준**: 명목가. 이미 `pickPosition`으로 구현되어 있다

## 4. 데이터 모델

```ts
type IStreamer = {
  id: string
  name: string
  image: string
  link: string          // 현재 방송 URL. desktopReport가 갱신한다
  channelUrl: string    // 캡처 기준. 방송을 껐다 켜도 안 변한다
  onAir: boolean
  editable: boolean
  lastUpdate: Date | string
  positions: IPosition[]
}

type IPosition = {
  id: string            // 어드민 편집/삭제와 제보 대조에 필요하다
  contract: string
  entryPrice: number
  liqPrice: number
  size: number
}
```

저장 키는 `content:realTimePositions` 그대로 두고 모양만 바꾼다.

**기존 데이터는 읽을 때 한 번 변환한다.** 캐시를 비우면 사람이 승인해 쌓아둔 값이 전부
날아간다. `positions`가 없는 항목을 만나면 포지션 필드 4개를 뽑아 `positions: [1개]`로
감싼다. 열 줄이면 되고, 한 번 저장되면 이후로는 새 모양이다.

`constants/position_presets.ts`는 스트리머만 정의한다. 포지션은 빈 배열로 시작한다.

## 5. API

`GET /contents/real_time_positions` (암호화 응답, 모양만 바뀐다)

```jsonc
{
  "data": [{
    "id": "…", "name": "박호두(852hodoo)", "image": "…", "link": "…",
    "onAir": true, "editable": true, "lastUpdate": "…",
    "positions": [
      { "id": "…", "contract": "ZECUSDT", "entryPrice": 1179.16, "liqPrice": 1351.71, "size": -974.63 },
      { "id": "…", "contract": "VVVUSDT", "entryPrice": 24.451, "liqPrice": 7.437, "size": 9280 }
    ]
  }],
  "lastUpdate": "…"
}
```

`dashboards:main`의 `realTimePositions`도 같은 모양을 담는다(`setRealTimePositions`가
이미 같은 객체를 넣고 있다).

어드민 저장(`POST /admin/contents/real_time_positions`)은 스트리머 하나를 통째로 받는다.
`positions` 배열이 곧 정답이며, 빠진 포지션은 삭제된 것으로 본다. 어드민은 사람이
직접 편집하는 화면이라 "빠졌으면 지운다"가 놀랍지 않다.

**단, 이 규칙을 제보 승인 경로에는 적용하지 않는다.** §7 참고.

## 6. 서버 변경

### 6.1 `desktopTargets`

스트리머 단위로 나간다. 지금도 `{id, name, channelUrl}`을 주므로 **모양은 그대로**고,
id가 '포지션 id'에서 '스트리머 id'로 의미만 바뀐다. `capture_desktop`은 수정 없다.

### 6.2 `desktopReport`

`autoParse`가 이미 `positions` 배열을 돌려준다. 대표 하나만 꺼내 쓰던 것을 그만두고
**읽은 포지션 전부를 제보에 담는다.**

판독 불가 판정은 그대로다. `legible === false`이거나 쓸 수 있는 포지션이 하나도 없으면
판독 불가 제보(스샷만)로 보낸다.

### 6.3 제보함

제보 키가 **스트리머 id**가 된다. 제보 하나 = "이 스트리머의 현재 화면에서 읽은 포지션 집합".
슬랙 메시지 하나에 체크박스 N개가 붙는 구조와 정확히 맞는다.

```ts
type IPositionReport = {
  id: string            // 스트리머 id
  lane: 'desktop' | 'human'
  requester: string
  name?: string
  link?: string
  // 화면에서 방금 읽은 값이라 id가 없다. id는 승인되어 canonical에 들어갈 때 붙는다.
  positions: Omit<IPosition, 'id'>[]   // 판독 불가면 빈 배열
  imageUrl?: string
  imageKey?: string
  reportedAt: string
  ip?: string
}
```

중복 억제(선행 설계 §5.3)는 **집합 비교**로 바뀐다. `positionHasChanged`를 계약별로
짝지어 비교하는 `positionSetHasChanged`로 확장한다. 판정은 지금과 같다.

1. canonical의 포지션 집합과 같으면 알리지 않는다
2. 직전 제보의 포지션 집합과 같으면 알리지 않는다

계약이 정렬되지 않은 채 오므로 비교 전에 `contract` 기준으로 정렬한다.

### 6.4 승인 반영

체크된 포지션만 **upsert** 한다. 계약이 같으면 갱신, 없으면 추가.

**체크되지 않은 기존 포지션은 지우지 않는다.** 판독이 일부만 맞은 경우가 흔한데,
승인 한 번에 나머지가 조용히 사라지면 사람이 눈으로 못 잡는다. 2026-09-09에 막은
'빈 값 승인이 포지션을 지우던 문제'와 같은 종류의 위험이다. 삭제는 어드민에서 한다.

### 6.5 알림

승인 반영 뒤 canonical의 **대표 포지션**(`pickPosition`)을 다시 계산해, 반영 전 대표와
다를 때만 `broadcast` + 푸시를 보낸다. 문구는 지금 그대로 대표 포지션 기준이다.

## 7. 슬랙

```
[방송 캡처]
📈 <링크|박호두> 포지션 수정 제보 — 3개 읽음
화면과 일치하는 것만 체크해 승인하세요. <어드민|어드민에서 직접 수정>

☑ ZECUSDT  숏 974.63 @1,179.16 · 청산 1,351.71   (명목 $1.15M)
☐ VVVUSDT  롱 9,280 @24.451 · 청산 7.437         (명목 $227K)
☐ 4USDT    롱 2,264,416 @0.0233 · 청산 —          (명목 $53K)

[체크한 것 승인] [전체 거절]
```

- `checkboxes`는 메시지에서 지원되고 **옵션 최대 10개**다.
  방송인이 10개를 넘게 잡으면 명목가 상위 10개만 싣고 그렇게 적는다
- 체크박스 값에는 포지션의 `contract`를 담는다. 승인 시 제보에서 같은 계약을 찾아 쓴다.
  **한 스트리머의 포지션은 계약당 하나라고 가정한다**(§11 참고)
- **하나도 체크하지 않은 승인은 거부한다.** 슬랙은 버튼을 조건부로 비활성화하지 못하므로
  서버에서 검증해 "체크한 포지션이 없습니다"로 되돌린다
- **체크박스를 토글할 때도 같은 엔드포인트로 요청이 온다.** 지금 핸들러는 `actions[0].value`를
  무조건 `JSON.parse` 하므로 토글에서 터진다. 버튼 `action_id`만 처리하고 나머지는 무시한다
- 판독 불가 제보는 지금처럼 체크박스 없이 닫기 버튼만 둔다

### 7.1 선행 확인 (구현 첫 단계)

**승인 클릭 시 오는 `block_actions` 페이로드의 `state.values`에서 체크 상태를 읽을 수
있는지 실물로 확인한다.** 공식 문서는 `state`를 "all stateful elements, not just input
blocks"라고 설명하지만 메시지 예시를 보여주지 않는다. 테스트 메시지 하나를 띄우고 한 번
눌러보면 끝난다.

읽히지 않으면 모달로 간다. 그 경우 `views.open`에 **봇 토큰이 필요하고**(인커밍 웹훅에는
토큰이 없다) `trigger_id`가 3초 만에 만료된다는 제약이 붙는다. 선행 설계 §6.3이 봇 토큰을
쓰지 않기로 한 결정을 뒤집는 것이므로, 그때 다시 판단한다.

## 8. coinsect-nuxt

| 파일 | 변경 |
|---|---|
| `composables/useRealTimePositions.ts` | `RealTimePosition` → `Streamer` + `Position`. 마크프라이스·미실현·평가금액은 **포지션 단위** |
| `composables/queries/useDashboardsMain.ts` | 같은 shape을 따라간다 |
| `components/common/c-position/CPosition.vue` | 헤더 1회 + 대표 포지션 + "다른 포지션 N개" 접기 |
| `components/modals/ModalPositionRequestEdit.vue` | 사람 제보도 포지션을 골라 수정하게 된다 |

- **티커 구독**은 모든 스트리머의 모든 포지션 계약의 합집합이 된다. 지금은 스트리머당
  하나였다. `useBybitSocket`이 구독 병합을 이미 하므로 목록만 넓히면 된다
- **정렬**(`sortRealTimePositions`)은 스트리머 단위로 남기고, 기준값은 대표 포지션의
  `$$value`를 쓴다
- **`applyPositionAlert`**는 스트리머를 찾아 `positions`를 갈아끼우는 방식으로 바뀐다.
  지금은 키를 골라 patch 하는데, 포지션이 늘고 줄므로 배열 교체가 맞다

## 9. coinsect-admin

| 파일 | 변경 |
|---|---|
| `views/ViewRealTimePositions.vue` | 스트리머 행 아래에 포지션 행을 추가/삭제/편집 |
| `modals/ModalAutoParsePosition.vue` | `auto_parse`가 `positions` 배열을 주므로 여러 줄을 채운다 |

`ModalAutoParsePosition.vue`가 아직 호출하는 죽은 엔드포인트
`admin/contents/real_time_positions/auto_capture`도 이때 함께 지운다
(2026-09-08에 서버에서 제거됐다).

## 10. 테스트

| 대상 | 검증 |
|---|---|
| `pickPosition` | 이미 있음 (명목가 최대, 순위 못 매기면 null) |
| 옛 shape 변환 | `positions` 없는 저장분이 1개짜리 배열로 감싸진다 |
| `positionSetHasChanged` | 계약 순서가 달라도 같은 집합이면 변경이 아니다 / 추가·삭제·값 변경은 변경이다 |
| 승인 upsert | 체크한 것만 반영하고, 체크 안 한 기존 포지션은 남는다 |
| 알림 조건 | 사이드 포지션만 바뀌면 broadcast/푸시가 발생하지 않는다 |
| 슬랙 인터랙션 | 체크박스 토글 페이로드는 무시하고, 빈 체크 승인은 거부한다 |

## 11. 가정과 범위 밖

### 계약당 포지션 하나

canonical과 승인 반영은 **계약을 키로** 다룬다. 같은 계약에 롱과 숏을 동시에 들고 있는
헤지 모드는 하나로 뭉개진다. 거래소 화면에서 이걸 구분해 읽는 것부터가 어렵고, 관측된
적도 없다. 실제로 나타나면 그때 포지션 방향까지 키에 넣는다.

### 다루지 않는 것

- **포지션 종료 감지.** 방송인이 포지션을 닫으면 화면에서 사라지는데, 그걸 '삭제'로
  볼지 '판독 실패'로 볼지 구분할 방법이 없다. 지금도 미해결이고 이번에도 풀지 않는다.
  정리는 어드민에서 사람이 한다
- **정확도 계층의 나머지** (`responseSchema`, 프레임 합의, 손익 역산)
- **`coinsect-web`** — 이 API를 쓰지 않는다
