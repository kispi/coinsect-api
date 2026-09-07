# 실시간 포지션 자동 캡처·인식 설계

- 작성일: 2026-08-10
- 범위: `coinsect-api`, `coinsect-admin`
- 상태: 설계 승인됨 (구현 계획 대기)

## 1. 배경

관리자 화면의 "포지션 자동인식"은 현재 **사람이 직접 스트리머 방송을 스크린샷으로 찍어 업로드**해야 동작한다.
`ModalAutoParsePosition.vue`가 이미지를 S3에 올리고, 그 URL을 `POST /admin/contents/real_time_positions/auto_parse`로 보내면
`realTimePositionService.autoParse`가 Gemini에 넘겨 진입가/청산가/규모/계약을 뽑는다.

자동화 시도는 `services/cron.ts:44-58`에 주석 처리된 채 남아 있고,
`// TODO: ffmpeg로 영상 다운로드 후 ffmpeg로 분석해서 포지션 업데이트하기`에서 멈춰 있다.

이번 스펙은 cron 전면 자동화가 아니라, **관리자가 버튼 한 번으로 라이브에서 직접 프레임을 떠 인식시키는 것**까지를 다룬다.
저장은 여전히 사람이 하므로 오인식이 `chatService.broadcast`나 푸시 알림으로 새어나갈 위험이 없다.
cron 자동화는 이 기능이 안정화된 뒤 별도 스펙으로 다룬다.

## 2. 사전 검증 (2026-08-10 실측)

설계의 모든 수치는 실제 라이브 방송(`@852hodoo`)에서 측정한 값이다.

### 2.1 캡처는 이미 성립한다

```bash
URL=$(yt-dlp -f "best[height<=1080]" --get-url "https://www.youtube.com/@852hodoo/live")
ffmpeg -i "$URL" -frames:v 1 -q:v 2 shot.jpg
```

- 단일 프레임: **1.2초**
- 12초 창에서 3프레임: **8.8초**
- yt-dlp의 라이브 URL 해석: 2~3초

**영상 다운로드는 불필요하다.** 기존 TODO의 "영상 다운로드 후"가 함정이었다.
HLS 매니페스트에 붙어 필요한 프레임만 받고 끊으면 되며, 디스크 쓰기도 없다.
매니페스트가 `playlist_type/DVR`이라 버퍼된 구간을 실시간보다 빠르게 읽는다.

### 2.2 YouTube Data API는 제거할 수 있다

현재 `real_time_position.ts:296,302`의 `autoCrawl`은 search 엔드포인트를 2회 호출한다.
search는 호출당 100 유닛이므로 기본 할당량 10,000 유닛 기준 **스트리머 1명당 200유닛 → 하루 총 50회**뿐이다.
5분 간격 × 5명이면 하루 1,440회가 필요하므로 애초에 성립하지 않는 설계였다.

`yt-dlp`에 `https://www.youtube.com/@{handle}/live`를 넘기면 **쿼터 소모 0으로** videoId와 `is_live`까지 함께 얻는다.

### 2.3 오버레이 구조 (박호두 기준)

하단 좌측 커스텀 OBS 바의 배치가 두 계약에서 동일하게 확인됐다.

```
{CONTRACT} Perp | Cross {N}x | {size} | {entry} | {liq}
```

- **흰색 = 진입가, 주황색 = 청산가, 부호 있는 색상 숫자 = 규모**
- BTCUSDT 프레임: `8.478 / 64,919.(흰) / 63,884(주황)` — 관리자 저장값 `8.478 / 64919.5 / 63885`와 일치
- SOXLUSDT 프레임: `-913.55 / 138.30(흰) / 145.79(주황)`
- **라벨이 전혀 없다.** 현재 프롬프트가 `'Entry Price'`, `'Liq'` 라벨을 찾도록 지시하는 주 전략이 이 화면에서는 통째로 무효다.

### 2.4 프레임마다 잘리는 위치가 다르다

60초를 5초 간격 12프레임으로 샘플링한 결과:

| 관측 | 값 |
|---|---|
| `contract`, `size`, `entry` | 12프레임 전부 동일 (`SOXLUSDT`, `-913.55`, `138.30`) |
| `liq` | `145.77` ~ `145.79` 사이에서 계속 변동 |
| 판독 가능성 | 프레임에 따라 `145.79` / `L45.79` / `45.78`, `138.30` / `l38.30` |

두 가지 결론:

1. **`liq`에 완전일치를 요구하면 항상 실패한다.** Cross 마진이라 청산가가 실시간 갱신된다.
2. **한 장만 뜨면 백의 자리가 통째로 날아갈 수 있다.** 흰색 KRW 손익 박스가 겹쳐 앞자리를 갉아먹는데, 갉히는 정도가 매 프레임 다르다.
   멀티프레임의 가치는 다수결이 아니라 **가장 온전하게 읽힌 판독을 고르는 것**이다.

### 2.5 역산이 성립한다

진입가가 화면에서 잘려 보이지 않는 프레임에서도 다른 값으로 복원할 수 있다.

```
entryDerived = markPrice + (pnlValue / fxRate) / size
```

BTCUSDT 프레임 실측 대입:

```
-3,120,707.50 KRW ÷ 1417.67 ÷ 8.478 = -259.66
64,658.07 (마크가) + 259.66       = 64,917.73
실제 정답                          = 64,919.5     → 오차 0.0027%
```

- 반드시 **마크가**를 써야 한다. Bybit 미실현손익은 마크가 기준이며, 차트 헤더의 최종체결가(`64,652.60`)를 쓰면 어긋난다.
- 환율은 `marketInfoService.indices()`가 이미 제공한다 (`market_info.ts:29`, coincodex `fiat_rates.KRW`, 60초 캐시).
- **소수점까지 정확하지는 않다.** 환율 제공자 차이, 수수료·펀딩비 반영, 오버레이와 차트의 갱신 시점 어긋남이 오차로 남는다.
  따라서 역산은 단독 정답이 아니라 **잘린 자릿수 복구와 교차검증 용도**이며, 화면에 온전히 보이면 화면값이 우선이다.

### 2.6 부수적으로 발견된 결함

- `constants/position_presets.ts:6`의 박호두 링크 `@852hodoo6`은 **404다.** 실제 핸들은 `@852hodoo`.
  (`@zzap9`, `@live-streamersatto`는 정상)
- 관리자 화면의 `방송 URL` 필드에 watch 링크(`youtube.com/watch?v=...`)가 들어가 있다. 방송을 껐다 켜면 죽는 값이다.
- 저장된 박호두 포지션(`BTCUSDT 8.478`)은 이미 낡았다. 실제로는 `SOXLUSDT` 숏 `-913.55`다.

## 3. 아키텍처

```
[완전 딸깍 시도] → POST /admin/contents/real_time_positions/auto_capture { id }
   1. 라이브 해석   yt-dlp: channelUrl → HLS URL       ~2-3s
   2. 캡처         ffmpeg: 3프레임 + 하단 크롭본        ~9s
   3. 추출         Gemini: 프레임별 독립 호출 3회       ~3s
   4. 판정         합의 + 역산 교차검증 → 신뢰도
   5. 업로드       대표 프레임 S3
   ← { position, url, confidence, warnings }
→ 모달이 기존 emit 그대로 → 폼 채움 → 사람이 확인 후 저장
```

총 15초 내외. `ModalAutoParsePosition.vue`에 `AppLoading`이 이미 있으므로 **동기 처리로 충분하며 잡 큐가 필요 없다.**

각 계층은 독립적으로 테스트 가능해야 한다.

| 계층 | 책임 | 입력 → 출력 |
|---|---|---|
| `liveResolver` | 채널 핸들에서 라이브 HLS URL 해석 | `channelUrl` → `{ hlsUrl, videoId, isLive }` |
| `frameCapturer` | HLS에서 프레임 N장 + 크롭본 생성 | `hlsUrl, opts` → `Buffer[]` |
| `positionExtractor` | 프레임 1장에서 원시 관측값 추출 | `Buffer` → `RawObservation` |
| `positionResolver` | 여러 관측값 합의 + 역산 검증 | `RawObservation[]` → `{ position, confidence, warnings }` |

`liveResolver`와 `frameCapturer`는 네트워크·프로세스를 다루므로 `positionResolver`와 반드시 분리한다.
`positionResolver`는 순수 함수여야 하며, 이 스펙에서 테스트 밀도가 가장 높은 부분이다.

## 4. 추출 계층: 모델은 읽기만, 산수는 서버가

LLM 산수는 신뢰할 수 없으므로 **역산을 프롬프트로 시키지 않는다.**
모델에는 `responseSchema`를 주고 가공된 결론이 아니라 원시 관측값을 받는다.

```ts
type RawObservation = {
  contract: string | null
  size: number | null          // 부호 포함. 롱 양수, 숏 음수
  entry: number | null
  liq: number | null
  leverage: number | null
  pnlValue: number | null
  pnlCurrency: 'KRW' | 'USD' | null
  markPrice: number | null
  marginBalance: number | null
  legible: {                   // 숫자가 다른 UI에 가려지거나 잘렸는지
    entry: boolean
    liq: boolean
    size: boolean
    pnlValue: boolean
  }
}
```

`legible`이 이 설계의 핵심이다. 현재는 모델이 `45.78`을 보면 그대로 45.78이라고 단정한다.
**잘렸다고 신고할 통로**를 주면 서버가 그 판독을 버리고 다른 프레임을 쓰거나 역산으로 복구할 수 있다.

`responseMimeType`만 지정된 현재 구조에서 `responseSchema`로 전환하면,
프롬프트가 `"Make sure ... are all numbers, not string representations"`로 애원하던 부분이 스키마로 강제된다.

### 프롬프트 재작성 지침

- 라벨 없는 커스텀 OBS 오버레이를 **기본 전제**로 둔다. 라벨이 보이면 당연히 그것을 우선한다.
- 위치·색 규칙을 명시한다 (§2.3).
- 미끼를 명시적으로 배제한다: 차트 헤더의 최종체결가·마크가·인덱스가, 호가창, 손익 툴팁, 차트 수평선 가격 라벨.
- `"usually ranges between 1 and 100 BTC"` 힌트를 **제거한다.** 사또의 `179.046`, SOXL의 `913.55`를 방해한다.
- 롱/숏 방향은 `entry`와 `liq`의 대소 관계로 판정한다.
- `"Bitcoin is currently at 5 figures"` 같은 시세 의존 표현을 제거한다. 시간이 지나면 썩는다.
- 프레임 3장을 한 번의 호출에 묶지 않고 **각각 독립 호출한다.** 독립 판독이어야 합의에 의미가 있다.

`gemini-flash-latest`는 떠다니는 별칭이라 배포 없이 동작이 바뀔 수 있다. 프롬프트를 튜닝해 쓰는 용도이므로 **구체 버전으로 고정한다.**
현재 이 별칭이 어떤 모델로 풀리는지는 `models.list`로 확인 후 결정한다.

## 5. 판정 계층: 합의 + 역산

### 5.1 필드별 합의 규칙

| 필드 | 규칙 | 근거 |
|---|---|---|
| `contract` | 3장 중 2장 이상 완전일치 필요 | §2.4 — 안정적 |
| `size` | 3장 중 2장 이상 완전일치 필요 | §2.4 — 안정적 |
| `entry` | `legible: true` 판독만 후보로 두고, 그중 **정수부 자릿수가 가장 많은 값** 채택. 동수면 최빈값 | §2.4 — 잘림이 프레임마다 다름 |
| `liq` | 중앙값. 완전일치 요구하지 않음 | §2.4 — 실시간 변동 |

### 5.2 역산 교차검증

```
entryDerived = markPrice + (pnlValue / fxRate) / size
```

| 조건 | 결과 |
|---|---|
| 읽은 값과 0.1% 이내 일치 | `confidence: 'high'` |
| 0.1% 초과 불일치 | `confidence: 'low'` + 경고. 폼은 채우되 관리자에게 표시 |
| 어느 프레임에서도 `entry`가 `legible`하지 않음 | 역산값 채택 + `'역산됨'` 표시 |
| `pnlValue` 또는 `markPrice` 판독 실패 | 역산 생략, `confidence: 'unverified'` |

`pnlCurrency`가 `KRW`면 `marketInfoService.indices().basePrice`로 나누고, `USD`면 그대로 쓴다.

### 5.3 방향 정합성

기존 `realTimePositionService.validate`의 규칙을 그대로 재사용한다
(롱인데 청산가가 진입가보다 높으면 거부, 숏인데 낮으면 거부).
합의·역산·방향검사 3중으로 걸러진다.

## 6. 데이터 모델 변경

- `IRealTimePosition`에 `channelUrl` 추가. 방송 껐다 켜도 변하지 않는 채널 핸들을 담는다.
  기존 `link`는 표시·이동용으로 그대로 유지한다.
- `constants/position_presets.ts`: `@852hodoo6` → `@852hodoo` 오타 수정, 각 프리셋에 `channelUrl` 지정.
- 관리자 폼(`방송 URL` 아래)에 채널 URL 입력칸 추가.

## 7. 관리자 UI

`ModalAutoParsePosition.vue`에 **"완전 딸깍 시도"** 버튼을 추가한다.

- `channelUrl`이 있는 포지션에서만 활성화
- 결과로 받은 캡처 이미지를 기존 `AppImg :src="payload.url"` 자리에 그대로 표시한다.
  **관리자가 "AI가 실제로 무엇을 봤는지" 눈으로 확인할 수 있어야 한다.**
- 신뢰도 배지와 경고 문구를 함께 노출한다 (`high` / `low` / `unverified` / `역산됨`)
- 실패 시 기존 업로드·붙여넣기 방식으로 자연스럽게 폴백한다. 기존 경로는 손대지 않는다.

## 8. 실패 처리

각 실패를 구분해 한국어 메시지로 안내한다. 뭉뚱그리면 원인 파악이 불가능해진다.

| 상황 | 처리 |
|---|---|
| 채널 핸들이 404 | "채널을 찾을 수 없습니다. 채널 URL을 확인해주세요." |
| 라이브 중이 아님 (`is_live: false`) | "현재 방송 중이 아닙니다." |
| yt-dlp 봇 차단 | "유튜브가 서버 접근을 차단했습니다." — §10 참조 |
| ffmpeg 타임아웃 | 30초 하드 타임아웃 후 중단 |
| 오버레이에 포지션이 없음 | "화면에서 포지션을 찾지 못했습니다." |
| 합의 실패 (프레임 간 불일치) | 값은 채우되 `confidence: 'low'` |

`yt-dlp`, `ffmpeg` 하위 프로세스는 반드시 타임아웃과 함께 실행하고, 실패해도 좀비 프로세스가 남지 않아야 한다.

## 9. 테스트

`positionResolver`는 순수 함수이므로 픽스처 기반으로 촘촘히 검증한다.
2026-08-10 캡처본이 `docs/superpowers/specs/fixtures/`에 보존되어 있으며, **정답이 이미 확보되어 있다.**
라이브 방송은 흘러가 버려 재캡처가 불가능하므로 이 이미지들은 레포에 함께 커밋한다.

| 픽스처 | 정답 | 검증 목적 |
|---|---|---|
| `btc-full.jpg` | `BTCUSDT / 8.478 / 64919.5 / 63885` | 라벨 없는 오버레이 기본 판독, 미끼 숫자 배제 |
| `soxl-full.jpg` | `SOXLUSDT / -913.55 / 138.30 / 145.79` | 알트 계약, 음수 규모(숏) |
| `soxl-crop-legible.jpg` | 위와 동일 | 크롭 보조본 판독 |
| `soxl-crop-truncated.jpg` | `entry` 판독 불가 | **`legible: false`가 나와야 한다.** `45.78`을 그대로 받아들이면 실패 |
| `soxl-60s-strip.jpg` | — | `liq` 변동 폭 참고자료 |

`btc-full.jpg`는 진입가가 `64,919.`로 잘린 프레임이므로 §5.2 역산 경로의 회귀 테스트로도 쓴다.

라이브 방송은 재현할 수 없으므로 `liveResolver`와 `frameCapturer`는 픽스처 기반 단위 테스트 대상이 아니다.
대신 실제 채널에 대한 수동 스모크 체크를 구현 시 1회 수행한다.

## 10. 미검증 리스크: 서버 IP 봇 차단

**구현 착수 전 반드시 확인해야 한다.**

모든 실측은 가정용 IP에서 수행됐다. YouTube는 데이터센터 IP를 봇으로 차단하는 경우가 흔하므로,
운영 서버에서 동일하게 동작한다는 보장이 없다.

```bash
yt-dlp --get-url "https://www.youtube.com/@852hodoo/live"
```

운영 서버에서 이 한 줄이면 5초 만에 판가름 난다.
차단된다면 쿠키 또는 PO token 우회가 필요하고, **스펙 범위가 크게 늘어나므로 그 시점에 재설계한다.**

부수 전제:
- 운영 서버에 `yt-dlp`와 `ffmpeg` 바이너리 설치 필요 (`deploy.sh`는 현재 `git pull && npm install && npm run build && pm2 restart`뿐)
- `yt-dlp`는 YouTube 변경에 맞춰 자주 갱신되므로 업데이트 경로를 정해둔다

## 11. 이번 범위에서 제외

- **cron 자동화.** 5~10분 주기 자동 갱신은 별도 스펙. 자동 반영은 `chatService.broadcast`와 푸시 알림을 유발하므로 승인 정책이 함께 설계되어야 한다.
- **다중 포지션.** 스트리머가 여러 포지션을 동시에 들 수 있으나 현재 데이터 모델은 포지션당 계약 1개다. 이번엔 화면에 보이는 것 하나만 다룬다.
- **YouTube 외 플랫폼.** 프리셋에 SOOP(아프리카) 이미지 URL이 섞여 있으나 `channelUrl`은 YouTube만 지원한다.
