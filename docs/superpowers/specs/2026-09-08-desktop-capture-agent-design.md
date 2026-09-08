# 가정용 캡처 서비스와 슬랙 승인 설계

- 작성일: 2026-09-08
- 범위: `coinsect-api` (신규 하위 서비스 `capture_desktop/` 포함)
- 선행 문서: [2026-08-10 실시간 포지션 자동 캡처·인식 설계](./2026-08-10-realtime-position-auto-capture-design.md)
- 상태: 설계 승인됨 (구현 계획 대기)

## 1. 배경

선행 스펙의 캡처 파이프라인은 이미 구현되어 있다.

| 자산 | 위치 |
|---|---|
| 핸들 → 라이브 HLS URL 해석 | `services/content/live_capture.ts` `resolveLiveStream` |
| HLS → 프레임 N장 | `services/content/live_capture.ts` `captureFrames` |
| 프레임 → 포지션 JSON | `services/content/real_time_position.ts` `autoParse` |
| 위 셋을 엮는 엔드포인트 | `POST /admin/contents/real_time_positions/auto_capture` |

`toLiveUrl`은 `@zzap9` 같은 **핸들 문자열만 줘도** `https://www.youtube.com/@zzap9/live`로 해석하고,
`is_live` 판정까지 이미 한다. 즉 "핸들만 받아 딸깍"은 코드상 성립한다.

**실제로 막힌 것은 하나다.** 선행 스펙 §10이 미검증 리스크로 남겨둔 **운영 서버 IP의 봇 차단**이 현실이 됐다.
EC2에서 `yt-dlp`가 라이브 URL을 해석하지 못하고, 쿠키 우회도 통하지 않았다.
어드민의 "완전 딸깍 시도" 버튼은 그래서 죽어 있다.

### 1.1 기각한 대안: computer use 에이전트

캡처 전체를 브라우저 자동화 에이전트로 대체하는 안을 검토했고 기각했다.

- **비용이 성립하지 않는다.** 브라우저 태스크 단가는 호출당 $0.5 규모로, 현재 파이프라인(프레임 3장 + 짧은 JSON, flash 티어, 1센트 미만)의 50~100배다.
  주기 실행으로 가면 아예 불가능하다.
- **어려운 절반이 오히려 나빠진다.** 선행 스펙 §2.4의 결론은 판독 실패가 **오버레이 숫자의 픽셀 잘림**에서 온다는 것이다.
  브라우저 창 스크린샷은 ffmpeg가 HLS에서 직접 뜨는 1080p 원본 프레임보다 화질이 낮다.
- **쉬운 절반이 비결정적이 된다.** 채널을 열고 라이브를 찾는 일은 `yt-dlp`가 2~3초에 결정론적으로 끝낸다.
  이를 LLM 클릭으로 바꾸면 광고·쿠키 배너·연령 게이트에서 매번 다르게 깨진다.

**LLM은 "프레임에서 숫자 읽기" 한 지점에만 쓴다.** 나머지는 전부 결정론적으로 유지한다.

### 1.2 핵심 통찰

이 문제에서 가정용 기계가 필요한 이유는 **지능이 아니라 IP**다.
따라서 집에서 도는 것은 에이전트가 아니라 **가정용 IP를 가진 얇은 캡처 클라이언트**여야 한다.

## 2. 아키텍처

집이 NAT 뒤 + 유동 IP이므로 **서버가 집을 부르지 않는다. 집이 서버를 부른다.**
터널도 포트포워딩도 작업 큐도 필요 없다.

```
[집 PC, 상시 가동]  capture_desktop/
   1. 대상 조회     GET  /contents/real_time_positions/desktop_targets
   2. 라이브 해석   yt-dlp: @handle → { videoId, isLive, hlsUrl }
   3. 캡처          ffmpeg: HLS에 붙어 프레임 N장, 디스크 쓰기 없음
   4. 전송          POST /contents/real_time_positions/desktop_report
                          { positionId, videoId, isLive, images[] }
                          ↓
[EC2]  5. 인식      프레임별 autoParse 독립 호출
       6. 상태 반영  link / onAir 를 Redis에 즉시 갱신 (브로드캐스트 없음)
       7. 제보 등록  포지션이 실제로 바뀌었을 때만
       8. 슬랙       링크 걸린 방송명 + [승인] [거절] 버튼
                          ↓
[슬랙]  9. 클릭      POST /slack/interactions (서명 검증)
       10. 승인 시   realTimePositionService.set → broadcast + 푸시
```

`capture_desktop`은 **Gemini를 부르지 않는다.** 프레임만 떠서 보낸다.

이 경계를 택한 이유는 운영이다. 선행 스펙 §4가 프롬프트 전면 재작성을 요구하고 있고
이 프롬프트는 앞으로 계속 튜닝될 물건인데, EC2에 있으면 **배포 한 번으로 끝난다.**
집에 두면 프롬프트를 고칠 때마다 집 기계를 만져야 하고, 어드민 수동 업로드 경로와 프롬프트가 갈라진다.
집에 Google API 키를 둘 필요도 없어진다.

선행 스펙 §3의 계층 분리(`frameCapturer` ↔ `positionExtractor`)와도 일치한다.

## 3. 하위 서비스 `capture_desktop/`

`proxy_upbit/`과 같은 방식으로 레포 안의 독립 서비스로 둔다.
자체 `package.json`, 자체 `.env`(커밋은 `.env.sample`만), 자체 프로세스 수명주기.

떼어내는 이유는 세 가지다. **다른 기계에서 돈다**는 것이 가장 크고,
배포 주기가 다르며(`yt-dlp`는 유튜브 변경에 맞춰 자주 갱신해야 한다),
API 서버가 죽어도 이건 죽을 이유가 없다.

**언어는 Node/TypeScript.** `proxy_upbit`은 Go지만 여기서는
`services/content/live_capture.ts`를 **한 줄도 고치지 않고 그대로 가져올 수 있다.** Go로 다시 쓸 이유가 없다.

`live_capture.ts`는 `capture_desktop/`으로 **이동**한다. EC2에 남겨둘 이유가 없고,
두 곳에 두면 갈라진다. 이에 따라 EC2의 `autoCapture`와 `/admin/.../auto_capture` 라우트는 제거한다.
(어드민의 "완전 딸깍 시도" 버튼도 함께 정리 대상 — `coinsect-admin` 쪽 후속 작업)

### 3.1 설정

| 키 | 설명 |
|---|---|
| `API_BASE_URL` | `https://api.coinsect.io` |
| `DESKTOP_SECRET` | 서버와 공유하는 시크릿 |
| `INTERVAL_MS` | 한 바퀴 주기 (기본 5분) |
| `FRAMES` / `FRAME_INTERVAL_SEC` | 프레임 수와 간격 (기본 3 / 4) |
| `YT_DLP_PATH` / `FFMPEG_PATH` / `YT_DLP_EXTRA_ARGS` | 기존 `live_capture.ts`가 쓰던 것 그대로 |

### 3.2 루프

대상을 **순차 처리한다.** 병렬로 돌리면 같은 IP에서 동시에 여러 스트림에 붙어 봇 차단을 자초한다.

한 대상의 실패는 그 대상에서만 끝난다. 로그를 남기고 다음으로 넘어가며, 루프는 절대 죽지 않는다.
`is_live: false`인 경우는 실패가 아니다 — 프레임 없이 `isLive: false`만 서버로 보고한다.

## 4. 서버 변경

### 4.1 `GET /contents/real_time_positions/desktop_targets`

시크릿 헤더 인증. `[{ id, name, channelUrl }]`만 돌려준다.
`channelUrl`이 비어 있는 포지션은 제외한다.

### 4.2 `POST /contents/real_time_positions/desktop_report`

시크릿 헤더 인증. 본문은 `{ positionId, videoId, isLive, images: string[] }`.

**본문 크기 주의.** 프레임 3장이 base64로 부풀면 1MB를 넘긴다.
fastify 기본 `bodyLimit`이 정확히 1MB이므로 **이 라우트에 한해 per-route `bodyLimit`을 올린다.**
전역으로 올리면 다른 모든 엔드포인트가 같이 노출되므로 그렇게 하지 않는다.

처리 순서:

1. **`link` / `onAir` 갱신.** `isLive`가 참이면 `link`를 `https://www.youtube.com/watch?v={videoId}`로,
   `onAir`를 `true`로 둔다. 거짓이면 `onAir`를 `false`로 내리고 `link`는 마지막 값을 유지한다.
   이 갱신은 **canonical state(Redis)에 즉시 반영**하되 `chatService.broadcast`도 푸시도 발생시키지 않는다.
   `positionHasChanged`가 `contract`/`entryPrice`/`liqPrice`/`size`만 보므로 구조적으로 안전하다.
2. **인식.** `isLive`가 거짓이면 여기서 끝. 참이면 프레임별로 `autoParse`를 독립 호출한다.
3. **제보 등록.** §5의 억제 규칙을 통과할 때만.

인식이 전부 실패해도 1번은 이미 반영됐으므로 방송 상태 추적은 계속 굴러간다.

### 4.3 인증

공유 시크릿 헤더 하나(`X-Desktop-Secret`)로 끝낸다.

관리자 JWT를 쓰지 않는 이유는 `core/helpers/jwt.ts:11`의 `expiresIn: 60*60*24*28` 때문이다.
`.env`에 토큰을 박아두면 **28일마다 조용히 죽고**, 집 기계에서 401을 뒤늦게 발견하게 된다.

시크릿은 타이밍 세이프 비교(`crypto.timingSafeEqual`)로 대조한다.

## 5. 제보함

### 5.1 Redis 이관

`notifiedPositionHistories`는 현재 인메모리 배열이다(`real_time_position.ts:57`).
**슬랙 버튼은 서버 프로세스보다 오래 산다.** 재배포 한 번이면 어제 메시지의 승인 버튼이 죽는다.
따라서 제보함을 Redis로 옮긴다. 나중에 서버가 분산될 때도 필요한 변경이다.

### 5.2 레인 분리

데스크톱 제보와 사람 제보를 분리 보관한다.

- **데스크톱 레인**: 포지션당 1건만 유지. 같은 스트리머의 새 제보는 기존 것을 덮어쓴다.
- **사람 레인**: 기존과 같이 최근 5건.

현재의 `slice(-5)` 단일 배열을 그대로 두면, 스크립트가 5명을 주기적으로 돌 때
**데스크톱 제보가 사람 제보를 전부 밀어낸다.**

### 5.3 중복 억제

슬랙 알림은 다음 두 조건을 **모두** 만족할 때만 보낸다.

1. canonical 포지션과 다르다 (`positionHasChanged` — 기존 로직)
2. **해당 포지션의 직전 데스크톱 제보와도 다르다**

2번이 없으면 억제가 동작하지 않는다. 관리자가 승인하지 않고 놔두면 canonical이 계속 낡은 값이므로,
1번만으로는 5분마다 같은 내용의 슬랙 알림이 영원히 온다.

제보함 항목 자체는 조건과 무관하게 최신값으로 덮어쓴다. 알림만 억제한다.

## 6. 슬랙

### 6.1 메시지

`services/slack.ts`의 `postMessage`가 `text`만 받으므로 **Block Kit `blocks`를 받도록 확장한다.**
`helpers.allNewlineTrimmed`는 `text` 경로에만 적용한다.

스트리머 이름에 현재 방송 링크를 건다. 슬랙 mrkdwn은 마크다운이 아니다 —
`[웨돔](URL)`이 아니라 **`<URL|웨돔>`** 이다. (기존 메시지가 쓰는 `*굵게*`와 같은 계열)

메시지에는 `[승인]`과 `[거절]` 버튼을 둔다.

버튼 `value`에는 `{ lane, positionId, reportedAt }`을 담는다.
전체 포지션 값을 담지 않는 이유는 §6.4의 stale 방어 때문이다.

### 6.2 인터랙션 수신

**`POST /slack/interactions`** 라우트를 추가한다.

슬랙은 `application/x-www-form-urlencoded`로 보내는데 현재 fastify에는 CORS 외에
아무 body 파서도 붙어 있지 않다(`server_modules.ts:99~`). `@fastify/formbody`를 추가한다.

**함정: 서명 검증은 파싱 전 원문(raw body)으로 해야 한다.** 파서가 원문을 보존하도록 구성해야 하며,
이 순서가 어긋나면 검증이 조용히 항상 실패하거나(더 나쁘게) 항상 통과한다.

슬랙은 3초 내 200 응답을 요구한다. 즉시 응답하고, 실제 반영과 메시지 갱신은
페이로드의 `response_url`로 이어서 처리한다.

### 6.3 인가 — 이 기능에서 가장 중요한 부분

**승인 클릭 = 전 사용자 푸시 발송이다.** 두 겹으로 막는다.

1. **슬랙 서명 검증.** `X-Slack-Signature` / `X-Slack-Request-Timestamp`를 Signing Secret으로
   HMAC-SHA256 대조하고, 타임스탬프가 5분을 넘으면 거부한다(리플레이 방지).
   비교는 타이밍 세이프로 한다.
   **이게 없으면 엔드포인트 주소만 아는 사람이 임의의 값으로 전체 푸시를 쏠 수 있다.**
2. **승인자 허용 목록.** 페이로드의 `user.id`를 `SLACK_APPROVER_IDS`와 대조한다.
   채널에 있는 아무나 누를 수 있으면 안 된다. 목록 밖이면 ephemeral 메시지로 거절을 알린다.

### 6.4 stale 클릭 방어

버튼 값의 `reportedAt`을 제보함의 현재 항목과 대조한다.

| 상황 | 처리 |
|---|---|
| 일치 | 반영하고 메시지를 "승인됨 (승인자, 시각)"으로 갱신 |
| 더 최신 제보가 있음 | 반영하지 않고 "더 최신 제보가 있습니다"로 갱신 |
| 제보가 없음 (이미 처리됨/만료) | "제보를 찾을 수 없습니다"로 갱신 |

이게 없으면 3일 전 메시지를 눌러 낡은 포지션이 전체 푸시로 나간다.

### 6.5 승인 / 거절

- **승인**: 저장된 제보를 `realTimePositionService.set`으로 적용한다. 여기서 `broadcast`와 푸시가 나간다.
  제보에는 포지션 수치만 반영하고 `image`/`name`/`link`/`editable`은 건드리지 않는다
  (`set`의 `submittedByUser` 경로와 같은 취급).
- **거절**: 제보함에서 제거하고 메시지를 "거절됨"으로 갱신한다. canonical은 그대로.

두 경우 모두 처리된 제보는 제보함에서 사라지므로, 다음 주기에 같은 값이 다시 오면
§5.3의 2번 조건이 풀려 **다시 알림이 온다.** 거절이 "이번 판독은 틀렸다"는 뜻이지
"이 스트리머를 무시하라"는 뜻이 아니므로 의도한 동작이다.

## 7. 실패 처리

| 상황 | 처리 |
|---|---|
| 집 PC가 꺼져 있음 | 제보가 안 올 뿐. 서버는 아무 영향 없음. 어드민의 수동 업로드 경로는 그대로 살아 있다 |
| 채널 404 / 방송 아님 | 실패가 아님. `isLive: false`로 보고하고 `onAir`를 내린다 |
| yt-dlp 봇 차단 | 집에서 발생할 일은 아니지만, 발생 시 로그만 남기고 다음 대상으로 |
| 프레임 인식 전부 실패 | `link`/`onAir`는 이미 반영됨. 제보만 생략 |
| 본문 크기 초과 | per-route `bodyLimit` 상향으로 방지. 그래도 넘치면 프레임 수를 줄여 재시도 |
| 슬랙 서명 불일치 | 401. 로그를 남긴다 (공격 신호일 수 있음) |
| 승인자 목록 밖 | ephemeral 거절 메시지 |

`yt-dlp`/`ffmpeg` 하위 프로세스는 기존과 같이 타임아웃과 함께 실행한다.

## 8. 테스트

순수 로직만 픽스처·단위 테스트로 덮는다. 라이브 방송과 슬랙 왕복은 수동 스모크로 남긴다.

| 대상 | 검증 |
|---|---|
| 중복 억제 (§5.3) | canonical과 같음 / 직전 제보와 같음 / 둘 다 다름 — 알림 발생 여부 |
| 레인 분리 (§5.2) | 데스크톱 제보 다수가 사람 제보 5건을 밀어내지 않는다 |
| 슬랙 서명 검증 (§6.3) | 정상 / 변조 본문 / 5분 초과 타임스탬프 / 헤더 누락 |
| stale 방어 (§6.4) | `reportedAt` 일치 / 불일치 / 제보 없음 |
| `link`·`onAir` 갱신 (§4.2) | 이 갱신만으로는 `broadcast`와 푸시가 발생하지 않는다 |

선행 스펙 §9의 픽스처 5장은 인식 정확도(§4/§5 미구현분) 검증용이므로 이번 범위 밖이다.

## 9. 사용자 수동 작업

슬랙 앱 설정은 `api.slack.com` 대시보드에서만 가능하다. MCP로도 코드로도 대신할 수 없다.

1. **현재 `SLACK_COINSECT_API` 웹훅이 정식 슬랙 앱 소유인지 확인.**
   레거시 "Incoming WebHooks" 커스텀 인테그레이션이면 **버튼이 아예 동작하지 않는다.**
   그 경우 앱을 새로 만들고 웹훅을 재발급해야 한다. 착수 전에 이것부터 확인한다.
2. 앱 설정 → **Interactivity & Shortcuts** 활성화, Request URL을
   `https://api.coinsect.io/slack/interactions`로 등록
3. **Basic Information → App Credentials → Signing Secret** 을 `.env`의 `SLACK_SIGNING_SECRET`에
4. 승인을 허용할 슬랙 사용자 ID를 `SLACK_APPROVER_IDS`에 (쉼표 구분)
5. `DESKTOP_SECRET`을 임의의 긴 랜덤 문자열로 생성해 서버와 `capture_desktop/.env` 양쪽에

메시지 갱신은 인터랙션 페이로드의 `response_url`로 하므로 **봇 토큰은 필요 없다.**

## 10. 이번 범위에서 제외

- **인식 정확도 계층.** 선행 스펙 §4(`responseSchema` + `legible`)와 §5(프레임 합의 + 손익 역산)는
  여전히 미구현이며 별도 스펙으로 다룬다. 이번엔 기존 `autoParse`를 그대로 쓴다.
  제보함을 경유하므로 오인식이 사용자에게 새지 않고, **실전 정확도를 측정할 데이터가 이 스펙으로 처음 쌓인다.**
  그 데이터가 §4/§5의 우선순위를 정한다.
- **신뢰도 기반 자동 반영.** `high`만 사람 없이 반영하는 하이브리드는 §4/§5 이후.
- **다중 포지션, 유튜브 외 플랫폼.** 선행 스펙 §11과 동일.
- **`coinsect-admin` 변경.** "완전 딸깍 시도" 버튼 정리는 후속 작업.
