# Slice 4 — Manual check 단계에서 발견한 갭 (post-merge)

Slice 4 본체와 follow-up(`2026-05-28-slice-4-follow-ups.md`)이 모두 머지된 뒤(`0f20fee`), 매뉴얼 점검(`docs/dev/ui-slice-4-manual-check.md`)을 실제로 돌리면서 드러난 UI 갭과 진단성 부족을 메운 기록.

본체 plan에는 들어가 있었는데 UI 작업 단위가 그것까지 못 따라간 케이스(M1)와, 매뉴얼 점검이 비정상 상태(예: 모든 status가 0)에 빠졌을 때 사용자가 자력 진단을 못 했던 케이스(M2/M3)가 섞여 있다. 다음 슬라이스 전에 이 두 종류의 갭을 모두 닫아두는 것이 목적.

**기준 base:** `0f20fee` (Slice 4 merge)
**점검 환경:** 별도 wiremock 컨테이너 + cargo dev + vite dev (매뉴얼 §0 그대로)

---

## 발견·처리 매핑

| 항목 | 증상 | 처리 |
|---|---|---|
| RunDialog가 `env`·`ramp_up_seconds`를 하드코딩 — UI에서 입력 불가 | `${BASE_URL}/login`이 풀리지 않아 모든 요청 status 0 / 비정상 RPS | M1 |
| Run 상세에 "어떤 URL을 때리는가"가 안 보임 (Step 컬럼이 ULID) | status 0이 났을 때 시나리오 설정이 틀린 건지 connectivity 문제인지 분간 불가 | M2 |
| 시나리오 URL이 `${BASE_URL}/login` 텍스트 그대로 표시 | 정상 동작 중에도 "env가 안 들어간 듯"하게 보임 | M3 |
| 매뉴얼이 wiremock stub 등록 방법을 적지 않음 | 점검자가 첫 단계에서 막힘 | M4 |
| Env 입력 폼이 add row 1칸이라 사용자가 placeholder를 값으로 오해 | 잘못된 entry(`key=http://localhost:9090, value=""`) 생성 → 다시 status 0 | M5 |

---

## M1 — RunDialog에 `env` / `ramp_up_seconds` 입력 추가

### 왜

Slice 4 plan은 엔진/컨트롤러까지 `ramp_up_seconds`와 `env`를 통과시켰지만, UI의 `RunDialog`가 두 값을 하드코딩(`ramp_up_seconds: 0`, `env: {}`)으로 보내고 있었다. 즉 어떤 시나리오든 사용자가 `${ENV}` 변수를 의도해도 적용할 방법이 없고, 매뉴얼 §3(ramp-up 점검)도 UI에서 실행 자체가 불가능했다.

엔진/컨트롤러/proto는 이미 모두 지원하고 있어서 백엔드 회귀는 없었음 — 순수히 UI 누락.

### 무엇이 바뀜

- `ui/src/components/RunDialog.tsx`:
  - 입력 필드 추가: **Ramp-up (s)**, **Env**(key·value 페어 리스트 + Add row).
  - 검증: `ramp_up_seconds > duration_seconds`면 Run 버튼 disabled + 에러 메시지.
  - 빈 key를 가진 env entry는 직렬화 시 자동으로 떨어짐(`key.trim()` 통과한 것만).
- `ui/src/components/__tests__/RunDialog.test.tsx` (신규):
  - Env add/remove 라운드트립
  - POST 페이로드에 env·ramp_up_seconds가 정확히 들어가는지
  - ramp_up > duration 시 Run disabled
  - 한 번에 name+value 페어 추가 (M5의 새 흐름)
  - key 비어있고 value만 있으면 Add disabled

### 다음 슬라이스 영향

- 새로운 run-time 옵션이 생기면 (예: tag/labels) 같은 폼 패턴 그대로 따라가면 됨.
- Profile 스키마는 이미 `ramp_up_seconds`를 가지고 있어 추가 작업 없음.

---

## M2 — Run 상세에 "Steps" 진단 패널 추가

### 왜

Slice 1·2 이래 Run 상세 페이지는 1초 윈도우 시계열만 보여줬다. step_id가 ULID로만 표시돼 사용자가 "지금 어떤 URL을 몇 번 때렸나"를 알 수 없었다. 매뉴얼 §1 점검 중 status 0이 100% 났을 때, 시나리오 설정 문제인지 wiremock 문제인지 첫 화면에서 분간 불가 → root cause 추적이 길어짐.

### 무엇이 바뀜

- `ui/src/pages/RunDetailPage.tsx`:
  - `useScenario(r.scenario_id)`로 시나리오 YAML 동시 로드 (실패해도 페이지 렌더링은 막지 않음 — defensive).
  - YAML을 `parseScenarioDoc`로 파싱해 `step.id → {name, method, url}` 맵을 메모.
  - 메트릭 windows를 step_id 기준으로 합산해 step별 total count/errors 계산.
  - 새 섹션 **Steps**(번호·이름·method·URL·요청수·에러수). 각 행의 URL은 M3의 resolver로 풀어서 표시.
  - **Env** 섹션(저장된 env entries)과 **Profile** 섹션(vus/duration/ramp_up)도 같이 노출 — 사용자가 한 화면에서 모든 입력값 검증 가능.
  - 기존 metric windows 표의 `Step` 컬럼도 ULID 대신 `name METHOD resolved-url`로 표시(맵 미적중 시 ULID로 fallback).
- `ui/src/pages/__tests__/RunDetailPage.test.tsx`:
  - 새 it: scenario YAML 모킹 → Steps 섹션에 name/method/URL과 누적 count·errors가 보이는지.
  - 기존 abort 테스트는 그대로(시나리오 fetch가 404로 떨어져도 페이지가 렌더링되는지 확인하는 부수효과 포함).

### 한계 / 다음 슬라이스 영향

- 시나리오 fetch는 **현재 시나리오**를 가져오므로, run 이후 시나리오가 수정되면 화면이 최신 정의를 보여준다 (run row의 `scenario_yaml` 스냅샷은 사용하지 않음). 매뉴얼 점검 중에는 문제 없지만, 정식 리포트(Slice 5)에서는 run row의 `scenario_yaml`을 fetch하는 별도 endpoint를 쓰는 게 정확. 현재 controller는 `runs` 테이블에 `scenario_yaml` 컬럼이 있지만 GET /api/runs/{id}에 노출 안 함 — Slice 5에서 노출 + 사용 권장.
- 1초 시계열의 단위 표시는 `ts_second` 그대로(유닉스 epoch). 사람 친화적 표시는 Slice 5 차트 단계에서.

---

## M3 — Client-side display-time template resolver

### 왜

M2로 URL이 보이게 됐어도 "${BASE_URL}/login" 문자열 그대로면, 매뉴얼 §1 사용자가 "Env에 BASE_URL을 넣었는데도 안 풀린 것 아닌가?"로 다시 헷갈렸다. 실제로는 엔진이 runtime에 풀어서 정상 요청을 보내고 있는데, **표시**가 시나리오 원본을 그대로 출력해서 진단을 어지럽힘.

### 무엇이 바뀜

- `ui/src/scenario/template.ts` (신규) — `resolveForDisplay(template, env)`:
  - 엔진 `crates/engine/src/template.rs`의 `${NAME}` / `${NAME:-default}` 시맨틱을 그대로 재현.
  - 단, **진단 표시용**이라 미해결 토큰을 에러로 처리하지 않고 그대로 둔다.
    - `${vu_id}` / `${iter_id}`(시스템 변수): 단일 display 값이 없으므로 그대로.
    - 알 수 없는 `${NAME}`(env에 없고 default도 없음): 그대로(엔진은 여기서 `UnknownVar` 에러).
    - `{{flow_var}}`: step별로 동적이므로 미리 풀 수 없음 — 그대로.
- `ui/src/scenario/__tests__/template.test.ts` (신규): 6개 케이스(정상 / 미해결 보존 / `:-` 기본값 / 시스템 변수 / flow var / 깨진 문법).
- `RunDetailPage`의 Steps URL과 metric windows의 Step URL이 이 함수를 거쳐 표시. 원본 템플릿은 작은 글씨로 함께(`template: ${BASE_URL}/login`) — resolved와 원본이 다를 때만.

### 시맨틱 동기화 책무

엔진과 UI가 같은 템플릿 문법을 두 번 구현했다(엔진 = runtime/엄격, UI = display/관대). 새 토큰(`${session_id}` 등)이나 새 문법(`${NAME?error}` 같은 zsh-style fallback)을 엔진에 추가하면, **반드시 `ui/src/scenario/template.ts`도 같이 수정**하고 `template.test.ts`에 케이스 추가. 둘 중 한쪽만 바뀌면 진단 표시가 거짓말을 한다.

---

## M4 — Manual runbook에 wiremock stub 사전 등록 절차

### 왜

§1·§2가 의존하는 `/login`·`/me`·`/profile` stub 등록 방법을 매뉴얼이 적지 않았다 (38행에 "wiremock에 미리 stub 등록"이라는 한 줄만 있어서, 어떻게 등록하는지를 점검자가 추측해야 했다). stub 미등록 시 모든 요청이 status 0(connection-level fail이 아니라 wiremock의 default 404 / no-match)을 받아, 점검자가 "엔진 문제인가?"로 시간 소모.

### 무엇이 바뀜

- `docs/dev/ui-slice-4-manual-check.md`:
  - 새 섹션 **사전 — wiremock stub 등록**: §1(토큰)과 §2(쿠키) 각각의 stub을 `__admin/mappings` admin API에 POST하는 curl 명령. 디버깅용 endpoint(`__admin/mappings`, `__admin/requests`, `DELETE __admin/mappings`)도 함께 명시.
  - §1·§2·§3·§4 본문에 "Env에 `BASE_URL=http://localhost:9090` 추가" 단계 명시(M1으로 가능해진 절차).
  - §1에 함정 주의 1줄: "이름 칸에 값을 잘못 넣으면 status 0 폭주가 다시 일어난다" (M5의 UX 함정 + M3 진단으로 catch 가능).

### 다음 슬라이스 영향

매뉴얼 §2·§3·§4도 Env 입력에 의존하므로 같은 패턴. Slice 5에서 차트 검증을 매뉴얼에 추가하면 같은 절차 위에 얹으면 됨.

---

## M5 — RunDialog Env Add 영역 UX 함정 수정

### 왜

M1의 초기 구현은 add row가 **이름 칸 하나**(placeholder="BASE_URL") + Add 버튼이었다. 점검자가 placeholder를 보고 "여기에 BASE_URL 값을 입력하라"로 해석 → URL을 통째로 이름 칸에 타이핑 → Add → `key="http://localhost:9090", value=""` 엔트리 생성 → ${BASE_URL}이 빈 문자열로 풀려서 다시 status 0. 본인이 만든 함정.

### 무엇이 바뀜

- `RunDialog.tsx`의 add row를 **두 칸**(name + value)으로 분리. value placeholder는 `http://localhost:9090` 예시.
- value만 채우고 name이 비어있으면 Add disabled (한쪽만 채우면 무엇이 잘못됐는지 즉시 보임).
- 테스트 2개 추가(한 번에 페어 등록 / name 비고 value만 있을 때 Add disabled).

### 일반화

키-값 페어 입력 폼은 **항상 두 칸을 함께** 두고, 두 칸의 라벨/placeholder가 어느 쪽이 key인지 모호하지 않게 한다. VariablesPanel(`ui/src/components/scenario/VariablesPanel.tsx`)은 이미 이 패턴 — RunDialog만 한 칸으로 빠져 있었다.

---

## 검증 합산

- `pnpm test` → 90 passed + 21 todo + 7 skipped (Slice 4 본체 후 81 → 새로 9개 추가; 회귀 0).
- `pnpm lint` → clean.
- `pnpm build` (tsc -b + vite) → OK.
- 매뉴얼 §1 토큰 점검 e2e: status 200 / errors 0 / step별 누적 count·errors 표시 확인.

## 다음 슬라이스(Slice 5/6) 이전 작업할 후보

- Run row의 `scenario_yaml` 스냅샷을 GET /api/runs/{id}에 노출하고, M2의 Steps 섹션이 그쪽을 쓰도록 변경(현재는 "현재 시나리오"를 가져옴 — 점검에는 문제 없으나 리포트로 정밀해질수록 어색).
- Display-time template resolver를 시나리오 편집기 inspector에서도 사용 가능하게(URL 미리보기 — 사용자가 env를 머릿속에 두지 않아도 미리 확인). Slice 5 차트와 함께 묶으면 자연스러움.
- 매뉴얼 §6의 lint/test/build 게이트가 매번 사람 손인데, UI 변경 PR엔 CI에서 `pnpm build`까지 도는 게 안전(Slice 3에서 한 번 강조).
