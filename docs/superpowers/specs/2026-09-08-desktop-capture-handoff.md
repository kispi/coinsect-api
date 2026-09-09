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
- 테스트와 빌드는 `ormconfig.ts`가 로컬에 있어야 돈다 (gitignore 대상, `ormconfig.sample.ts`를 복사).

## 다음 할 일

### 1. 모델 벤치마크 완주 (`tools/bench_position_models.js`)

도구는 준비됐다. `thinkingBudget=0`으로 재고, 호출당 입력/과금출력 토큰을 찍는다.
**실행에 `GOOGLE_AI_STUDIO` 키가 필요하다.**

```bash
GOOGLE_AI_STUDIO=<키> node tools/bench_position_models.js
```

- 출력을 파일로 리다이렉트하면 Node가 stdout을 버퍼링해 진행이 안 보인다. 터미널에 그대로 띄울 것
- `THINKING_BUDGET=-1`로 주면 thinking을 켜고 비교할 수 있다
- **운영의 `autoParse`는 thinkingBudget을 주지 않아 thinking이 켜진 채로 돈다.**
  여기서 이긴 모델로 갈아탈 때 이 설정도 같이 옮겨야 측정한 정확도와 비용이 실제와 맞는다

비교 대상: `gemini-3.8-flash`(현재 고정값), `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`.
Flash-Lite가 충분히 읽어내면 월 $24 → $5 수준으로 내려간다.

### 2. 비용 재추정

기존 추정(월 $1.6~$24)은 **thinking 토큰을 계산에 넣지 않았다.** 1번을 끝내면 실측값이 나온다.
`gemini-3.8-flash`는 2027-01-01에 단가가 두 배가 된다는 점도 감안할 것.

### 3. 정확도 계층 (선행 스펙 §4/§5)

`responseSchema` + `legible` 신고 + 프레임 합의 + 손익 역산.
운영자가 "어차피 사람이 눈으로 보고 승인하니 오인식은 큰 문제가 아니다"라고 판단해 우선순위를 내렸다.
1번 결과에 따라 싼 모델로 갈아탈 경우 필요성이 다시 올라갈 수 있다.

### 4. `coinsect-admin`의 죽은 버튼

"완전 딸깍 시도"가 호출하던 `/admin/contents/real_time_positions/auto_capture`를 제거했다.
별도 레포라 손대지 않았다.

### 5. pm2 로그 로테이션 (별건)

`~/.pm2/logs/coinsect-api-out.log` 1.1GB + `-error.log` 798MB. 3.8GB 램에 스왑까지 쓰는 상자에서
디스크만 갉아먹고 있다. `pm2-logrotate`를 잡을 것.

## 알아두면 좋은 것

- 슬랙 mrkdwn 링크는 `[텍스트](URL)`이 아니라 **`<URL|텍스트>`** 다
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
