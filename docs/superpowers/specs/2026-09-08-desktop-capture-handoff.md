# 데스크톱 캡처 — 진행 상황과 다음 할 일

- 작성일: 2026-09-08
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
| 판독 프레임을 슬랙에 첨부 | **배포됨, 실물 미확인** |
| 시간대별 주기 (21~3시 5분 / 나머지 1시간) | **배포됨, 실물 미확인** |

마지막 두 줄은 코드와 타입체크·테스트는 통과했지만 실제 슬랙 메시지로 확인하지 못했다.
다음 제보가 올라올 때 **이미지가 메시지에 붙어 있는지** 확인할 것.

## 환경

- 서버 `.env`: `DESKTOP_SECRET` 추가됨 (백업 `~/web/coinsect-api/.env.bak-20260908133940`)
- 집 `C:\dev\coinsect-api\capture_desktop\.env`: `API_BASE_URL`, `DESKTOP_SECRET`, `YT_DLP_PATH`, `FFMPEG_PATH`
  - `yt-dlp`를 winget으로 깔았는데 `WinGet\Links`가 PATH에 안 잡혀서 전체 경로를 박아뒀다
- 슬랙 앱 `코인충 봇`(`A03F1G319EU`)에 Interactivity 활성, Request URL `https://api.coinsect.io/slack/interactions`
  - 서명 검증과 승인자 허용 목록은 두지 않기로 했다 (설계 §6.3)

## 다음 할 일

### 1. 모델 벤치마크 완주 (`tools/bench_position_models.js`)

선행 스펙 §9의 픽스처가 **정답을 확보한 상태**라 모델 비교가 성립한다.
2026-09-08 실행은 요약 헤더까지만 찍히고 멈췄다.

- 원인 추정: Gemini 3.x가 기본으로 thinking을 돌아 호출당 수십 초가 걸린다
- `thinkingConfig: { thinkingBudget: 0 }`을 주고 다시 잴 것
- `usageMetadata.thoughtsTokenCount`가 **출력 토큰으로 과금**되므로 비용 추정에 반드시 포함할 것.
  이걸 빼고 센 기존 추정치는 틀렸을 가능성이 크다
- 출력을 파일로 리다이렉트하면 Node가 stdout을 버퍼링해 진행이 안 보인다. 터미널에 그대로 띄울 것

비교 대상: `gemini-3.8-flash`(현재 고정값), `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`.
Flash-Lite가 충분히 읽어내면 월 $24 → $5 수준으로 내려간다.

### 2. 비용 재추정

현재 추정(월 $1.6~$24)은 **thinking 토큰을 계산에 넣지 않았다.** 1번을 끝내면 실측값이 나온다.
`gemini-3.8-flash`는 2027-01-01에 단가가 두 배가 된다는 점도 감안할 것.

### 3. 정확도 계층 (선행 스펙 §4/§5)

`responseSchema` + `legible` 신고 + 프레임 합의 + 손익 역산.
운영자가 "어차피 사람이 눈으로 보고 승인하니 오인식은 큰 문제가 아니다"라고 판단해 우선순위를 내렸다.
1번 결과에 따라 싼 모델로 갈아탈 경우 필요성이 다시 올라갈 수 있다.

### 4. `coinsect-admin`의 죽은 버튼

"완전 딸깍 시도"가 호출하던 `/admin/contents/real_time_positions/auto_capture`를 제거했다.
별도 레포라 이번에 손대지 않았다.

## 알아두면 좋은 것

- 슬랙 mrkdwn 링크는 `[텍스트](URL)`이 아니라 **`<URL|텍스트>`** 다
- 배포는 GitHub Actions가 러너에서 빌드해 `dist/`만 서버로 복사한다. 서버는 `git pull`을 하지 않으므로
  서버 워킹트리가 더러워도 무관하다
- 테스트와 빌드는 `ormconfig.ts`가 로컬에 있어야 돈다 (gitignore 대상, `ormconfig.sample.ts`를 복사하면 됨)
- 서버는 UTC다. 사람에게 보이는 시각은 KST로 옮겨야 한다 (한국은 서머타임이 없어 +9 고정)
