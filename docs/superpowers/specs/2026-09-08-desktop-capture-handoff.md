# 데스크톱 캡처 — 진행 상황과 다음 할 일

- 작성일: 2026-09-08 (2026-09-09 갱신)
- 설계: [2026-09-08 가정용 캡처 서비스와 슬랙 승인 설계](./2026-09-08-desktop-capture-agent-design.md)

## 지금 돌아가는 것

프로덕션에 배포되어 있고 **실전에서 한 바퀴 검증됐다.**
2026-09-08 22:45 KST에 4명 전원 인식 성공, 슬랙 제보 4건 발송, 사람이 화면을 보고 4건 모두 승인,
포지션 반영과 푸시까지 나갔다.

| 조각 | 상태 |
|---|---|
| `capture_desktop` (집 PC) | 동작 확인. 바탕화면 `코인충 포지션 캡처.lnk`로 실행 |
| 라이브 감지 → 프레임 캡처 → 전송 | 동작 확인 |
| Gemini 판독 | 동작 확인 (4/4) |
| 제보함(Redis) + 레인 분리 + 중복 억제 | 동작 확인 |
| 슬랙 버튼 승인/거절 | 왕복 확인 |
| 판독 프레임을 슬랙에 첨부 | 2026-09-09 원인 찾아 고침. 업로드와 공개 GET은 검증, 슬랙 렌더는 다음 제보에서 눈으로 확인할 것 |
| 승인/거절 기록 (한 줄 요약) | 2026-09-09 추가. 문구는 검증, 실제 버튼 왕복은 다음 제보에서 확인할 것 |
| 시간대별 주기 (21~3시 5분 / 나머지 1시간) | **배포됨, 실물 미확인** |

2026-09-09 로컬에서 실 데이터로 한 바퀴 더 돌렸다. 박호두 라이브를 떠서 Gemini가
`KORUUSDT / -16570 / 24.36 / 35.496`으로 읽었고 화면과 4/4로 일치했다.
S3 업로드와 CDN 공개 GET, 이미지가 붙은 슬랙 제보까지 확인했다.
(제보함이 로컬 인메모리라 버튼 왕복은 이 경로로는 확인되지 않는다)

### 이미지 첨부가 안 되던 이유 (2026-09-09 해결)

두 겹이었다.

1. `putObject`가 `ACL: 'public-read'`를 붙였는데 버킷에 Block Public Access의 `BlockPublicAcls`가
   켜져 있어 S3가 `PutObject` 자체를 `AccessDenied`로 거부했다. `desktopReport`가 이 실패를 삼키고
   진행하도록 되어 있어서 제보는 이미지 없이 정상 발송됐고, 그래서 눈에 띄지 않았다.
2. 성공했더라도 반환하던 원시 S3 URL은 **공개 GET이 403**이다. 이 레포의 공개 이미지 경로는
   전부 CloudFront(`helpers.useCdn`)다. 슬랙은 그 URL을 읽지 못했을 것이다.

ACL을 걷고 CDN URL을 돌려주도록 고쳤다. 픽스처를 실제로 올려 CDN이 `200 image/jpeg`로 주는 것과
슬랙이 이미지 블록을 받아들이는 것까지 확인했다. 채널에서 눈으로 본 것은 아니다.

### 승인/거절 기록 형식

원본 메시지를 이 한 줄로 갈아치운다.

```
✅ 승인됨 — 🖥 <링크|웨돔> · BTCUSDT · 규모 8.478 · 진입 64,919.5 · 청산 63,885 · <@승인자> · 09-09 09:40
❌ 거절됨 — 🙋 *뉴비* · SOXLUSDT · 규모 -913.55 · 진입 138.3 · 청산 145.79 · <@승인자> · 09-09 09:40
⚠️ 제보를 찾을 수 없습니다. (이미 처리됐거나 더 최신 제보가 있습니다) — <@승인자> · 09-09 09:40
```

- 레인 아이콘으로 자동 제보(`🖥`)와 사람 제보(`🙋`)가 갈린다. 사람 제보는 `link`가 없어 이름만 굵게 나온다.
- **이미지는 요약에 남기지 않는다.** 기록이 쌓일수록 채널이 세로로 길어져 훑어볼 수 없다.
  이미지는 승인 시점에 판단하려고 붙이는 것이므로 제보 메시지에만 있다.
  따라서 승인/거절 시 S3 객체를 지우는 동작은 그대로 둔다.

## 환경

- 서버 `.env`: `DESKTOP_SECRET` 추가됨 (백업 `~/web/coinsect-api/.env.bak-20260908133940`)
- 집 `C:\dev\coinsect-api\capture_desktop\.env`: `API_BASE_URL`, `DESKTOP_SECRET`, `YT_DLP_PATH`, `FFMPEG_PATH`
  - `yt-dlp`를 winget으로 깔았는데 `WinGet\Links`가 PATH에 안 잡혀서 전체 경로를 박아뒀다
- 슬랙 앱 `코인충 봇`(`A03F1G319EU`)에 Interactivity 활성, Request URL `https://api.coinsect.io/slack/interactions`
  - 서명 검증과 승인자 허용 목록은 두지 않기로 했다 (설계 §6.3)

## 로컬에서 돌리기

```bash
cp .env.sample .env          # 필수 키가 하나라도 비면 server_modules.ts가 process.exit 한다
npm install
npm run dev                  # → :4100
```

밟게 되는 것들:

- **`ormconfig.ts`의 host가 `webserver.coinsect.io`, 즉 운영 DB다.** 그대로 `npm run dev`하면
  로컬에서 운영 DB에 붙는다. 로컬로 돌릴 땐 `localhost`로 바꾸고
  `psql -U coinsect -d coinsect -f schema/001_baseline.sql`로 스키마를 넣는다.
- **`.env` 없이 셸 환경변수만 넘기는 방식은 안 먹는다.** `store.ts`의
  `dotenv.config().parsed || process.env`에서, dotenv는 파일이 없을 때 `parsed`를 `{}`로 준다.
  빈 객체는 truthy라 `process.env` 폴백이 죽어 있다. 설정이 전부 빈 값이 된다.
- 서버만 띄워 확인할 때는 `POST /contents/real_time_positions/desktop_report`에
  `X-Desktop-Secret` 헤더와 base64 프레임을 직접 넣으면 된다. 캡처 클라이언트가 필요 없다.
- 슬랙 버튼 왕복은 로컬에서 안 된다. 슬랙이 공개 URL을 불러야 한다. ngrok을 쓰거나
  `payload=<JSON>` 폼바디를 `curl`로 `localhost:4100/slack/interactions`에 직접 넣는다.
- 맥에서 `capture_desktop`을 돌리려면 `brew install yt-dlp ffmpeg`가 먼저다.
  (2026-09-09에 이 맥에 설치해뒀다)
- 테스트와 빌드는 `ormconfig.ts`가 로컬에 있어야 돈다 (gitignore 대상, `ormconfig.sample.ts`를 복사).

## 다음 할 일

### 1. 모델 벤치마크 — 완료 (2026-09-09)

`GOOGLE_AI_STUDIO=<키> npx ts-node tools/bench_position_models.ts`
(`REPS=4`, `BENCH_MODELS=a,b`로 좁혀 볼 수 있다. 벤치는 운영 프롬프트를 직접 import한다)

픽스처 3장 x 4항목 x **4회 반복** = 48점.

| 모델 | 점수 | 판독 불가 | 평균 지연 | 월 비용 |
|---|---|---|---|---|
| **`gemini-3.8-flash`** (현재) | **48/48** | 0/12 | 4,490ms | **$18.63** |
| `gemini-3.5-flash-lite` | 28/48 | 4/12 | 1,890ms | $4.36 |
| `gemini-2.5-flash-lite` | 25/48 | 0/12 | 3,163ms | $0.75 |

**결론: `gemini-3.8-flash` 유지.** 정확도보다 결정적인 것은 **일관성**이다.

```
gemini-2.5-flash-lite  btc-full.jpg   1/4 4/4 3/4 2/4   ← 같은 이미지, 회차마다 다른 답
gemini-3.5-flash-lite  soxl-full.jpg  불가 불가 불가 불가
gemini-3.8-flash       (전 케이스)      4/4 4/4 4/4 4/4
```

싼 모델은 **같은 화면에서도 회차마다 답이 흔들린다.** 이건 단순한 오답보다 나쁘다.
중복 억제(§5.3)가 직전 제보와 값을 비교하는데, 값이 매 주기 요동치면 억제가 풀려
슬랙 알림이 주기마다 온다. 가격표에 안 나오는 운영 비용이다.

`gemini-3.5-flash-lite`가 SOXL을 전부 '판독 불가'로 넘기는 것은 프롬프트의 BTC 편향
때문이 아니었다. 프롬프트를 코인 일반으로 다시 쓴 뒤에도 그대로였다.

**프롬프트 재작성의 부수 효과가 컸다.** BTC 전용 힌트("size는 보통 1~100 BTC",
"비트코인은 다섯 자리")를 치우자 3.8-flash의 thinking이 호출당 724 → 249토큰으로 줄어
**월 $28 → $18.63**이 됐다. 정확도는 그대로, 지연은 5.9s → 3.9s. 모순되는 힌트를
치우는 것만으로 모델이 덜 헤맨다.

### 2. 비용 — 실측 (2026-09-09)

단가는 2026-09-09 ai.google.dev/gemini-api/docs/pricing 기준. 벤치가 월 비용까지 찍는다.

호출 수 가정: 피크(21~3시) 6시간 x 5분 = 72바퀴 + 비피크 18시간 x 1시간 = 18바퀴 =
하루 90바퀴. 한 바퀴에 라이브인 대상 수만큼 호출하므로 피크 3명/비피크 1명이면
하루 234회, 월 약 7,020회다. 가정이 틀리면 `tools/bench_position_models.ts`의
`CALLS_PER_MONTH`를 고쳐 다시 돌리면 된다.

**`gemini-3.8-flash`는 2027-01-01에 단가가 두 배가 된다 → 월 $37.**

남은 비용 카드: 과금출력 320 중 **249가 여전히 thinking**이다. `thinkingBudget: 0`은
이 모델에서 무시된다. 정말 끌 방법을 찾으면 월 $18.63 → $5 수준이다. 모델 교체보다
이득이 크고 정확도 위험이 없다.

### 3. 정확도 계층 (선행 스펙 §4/§5)

**`legible` 신고와 다중 포지션 처리는 2026-09-09에 들어갔다.** 남은 것은
`responseSchema`(지금은 프롬프트로만 스키마를 지시한다), 프레임 합의, 손익 역산이다.

다중 포지션: 모델이 읽은 포지션을 전부 배열로 내놓고, 대표는 `pickPosition`이 고른다.
기준은 **명목가(|수량| x 진입가)** 다. 코인 개수로는 0.5 BTC와 16,570 KORU를 비교할 수
없기 때문이다. 순위를 못 매기면 고르지 않고 판독 불가로 넘긴다.
2026-09-09 박호두는 ZEC($1.15M) / VVV($227K) / 4($53K) 셋을 잡고 있었고 ZEC가 대표로 뽑혔다.

**대표가 바뀌면 새 제보가 나간다.** 두 포지션의 명목가가 엎치락뒤치락하면 주기마다
알림이 올 수 있다. 아직 실물로 겪지는 않았다.

같은 날 **빈 값 승인 차단**도 넣었다. 판독이 일부만 된 제보를 승인하면 `set()`이 빈 값을
'지우라'로 받아들여 포지션을 날리고 "진입 - / 청산 -"를 전 유저에게 푸시하고 있었다.
사람이 스샷을 봐도 못 거르는 종류라 승인 경로에서 막는 것 말고는 방법이 없었다.

남은 위험은 **모델이 자신 있게 틀리는 것**이다(진입가와 청산가를 맞바꾸는 등).
이건 승인자가 스샷의 숫자와 요약 줄의 숫자를 대조해야 걸린다. 틀린 채로 승인해도
어드민 링크로 바로 고칠 수 있다.

### 4. `coinsect-admin`의 죽은 버튼

"완전 딸깍 시도"가 호출하던 `/admin/contents/real_time_positions/auto_capture`를 제거했다.
별도 레포라 손대지 않았다.

### 5. pm2 로그 로테이션 (별건)

`~/.pm2/logs/coinsect-api-out.log` 1.1GB + `-error.log` 798MB. 3.8GB 램에 스왑까지 쓰는 상자에서
디스크만 갉아먹고 있다. `pm2-logrotate`를 잡을 것.

## 알아두면 좋은 것

- 슬랙 mrkdwn 링크는 `[텍스트](URL)`이 아니라 **`<URL|텍스트>`** 다
- **`yt-dlp`의 `best`는 영상과 소리가 합쳐진 포맷만 고른다.** 유튜브가 player_client에 따라
  video-only/audio-only만 내주면 `Requested format is not available`로 죽는다. 집 PC가 돌던 건
  `.env`의 `YT_DLP_EXTRA_ARGS`로 client를 바꿔둔 덕이었다. 2026-09-09에 video-only 폴백을 넣어
  그 설정 없이도 돌게 했다
- **preset의 `channelUrl`이 죽어도 아무도 모른다.** 라이브 해석 실패는 다음 대상으로 넘어가며
  삼켜진다. 실제로 웨돔의 `@wedomnbro`가 채널째 404가 된 채 방치돼 있었다(2026-09-09에
  `@wedombtc`로 교체). 가끔 `yt-dlp --print '%(id)s %(is_live)s' <채널>/live`로 5명을 훑어볼 것
- **서비스 함수를 async로 바꿀 때 컨트롤러의 `await`을 같이 보라.** fastify 5의 `reply.send`는
  Promise를 await하지 않고 `{}`로 직렬화한다. 어드민의 실시간 포지션 화면이 이것 때문에
  `(o.value || []).filter is not a function`으로 죽어 있었다
- **S3 객체의 공개 읽기는 ACL이 아니라 CloudFront가 담당한다.** 원시 S3 URL
  (`coinsect-production.s3...`)은 공개 GET이 403이다. 공개로 노출할 URL은 `helpers.useCdn(key)`.
  `getSignedUrl`(브라우저 업로드) 경로는 여전히 `ACL: 'public-read'`를 서명에 넣고 있어
  같은 이유로 깨져 있을 수 있다 — 확인해볼 것
- 배포는 GitHub Actions가 러너에서 빌드해 `dist/`만 서버로 복사한다. 서버는 `git pull`을 하지 않으므로
  서버 워킹트리가 더러워도 무관하다
- 서버는 UTC다. 사람에게 보이는 시각은 KST로 옮겨야 한다 (한국은 서머타임이 없어 +9 고정)
- 전체 로그에 `slackInteraction failed`는 2026-09-08 22:45:56 단 한 건이다. `payload`가 이중
  인코딩된 채로 들어와 `JSON.parse`가 터졌는데, 키 순서도 슬랙 실제 페이로드 모양이 아니다.
  세팅 중 손으로 만든 테스트 요청으로 보이고 재발이 없어 손대지 않았다
