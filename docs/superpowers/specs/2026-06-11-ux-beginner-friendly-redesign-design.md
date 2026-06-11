# UX 초보자 친화 재설계 — 디자인 (영역 U)

날짜: 2026-06-11
상태: 사용자 승인 완료 (brainstorming 섹션 1–6 개별 승인)
범위: **UI-only** — 엔진·컨트롤러·proto·migration 무변경

## 1. 문제와 목표

### 1.1 문제

기능은 LoadRunner 대체 수준으로 갖춰졌으나(시나리오 DSL·부하 모델·SLO·리포트·스케줄), UI가 부하테스트 도메인 지식을 전제해서 초보 QA가 **전 여정**(첫 화면 → 시나리오 작성 → run 설정 → 결과 해석)에서 막힌다. 2026-06-11 6영역 병렬 UX 감사에서 확인된 핵심 friction:

- **첫인상**: 홈 빈 상태가 "No scenarios yet. Create one to get started." 한 줄(`ui/src/pages/ScenarioListPage.tsx`). 4개 네비(Scenarios/Datasets/Environments/Schedules)가 동급 나열로 "뭘 먼저 해야 하지?"에 무응답(`ui/src/components/Layout.tsx`).
- **에디터**: 새 시나리오가 빈 `steps: []`에서 시작(`ui/src/pages/ScenarioNewPage.tsx` STARTER_YAML), URL 필수 표시·placeholder 없음(`ui/src/components/scenario/Inspector.tsx`), `{{var}}` vs `${ENV}` 표기 학습 장벽, Zod 검증 에러가 test-run까지 잠복.
- **Run 설정**: VU/Closed-loop/Open-loop/ramp-up/SLO 등 용어 무설명 노출, 기본값 근거 부재, 8개 섹션 평면 나열, 검증 메시지 한영 혼재(`ui/src/components/RunDialog.tsx`, `LoadModelFields.tsx`).
- **리포트**: p50/p95/p99 무설명, SLO 미설정 시 "성공인가?"에 대한 답 부재, insight가 다음 행동 미제시(`ui/src/components/report/Summary.tsx`, `InsightPanel.tsx`).
- **보조 리소스**: 데이터셋/환경/스케줄이 "언제 왜 필요한지" 설명 없음.

### 1.2 성공 기준

- 부하테스트 경험이 없는(단, **HTTP 기본 — GET/POST·상태코드·헤더 — 은 아는**) QA가 **문서나 옆자리 도움 없이** ① 첫 시나리오를 만들고 ② run을 실행하고 ③ 결과에서 "합격인가, 문제는 어느 스텝인가"를 스스로 판단할 수 있다.
- 고급 사용자(개발자)의 **주 동선**(YAML 직접 편집, 프리셋 CRUD, retry prefill, 부하 정의 입력)은 클릭 수가 늘지 않는다. 진단 필드(HTTP 타임아웃·루프 캡)는 "진단" 접힘 그룹 이동으로 **+1 클릭 허용**(값 있으면 자동 펼침으로 prefill/retry 경로는 무손실) — §6.1.
- Run 생성 제출 payload는 **byte-identical** (부하 모드 선택기 슬라이스 전례의 불변식 테스트로 락인).

### 1.3 확정된 설계 결정 (brainstorming 2026-06-11)

| # | 결정 | 비고 |
|---|---|---|
| 1 | 기본 철학 = **단일 UI 점진 노출(progressive disclosure) 재설계** | 간단/전문가 모드 토글 기각(2벌 유지보수), 전면 위저드 기각 |
| 2 | 홈에만 **가이드 레이어** = 시작 가이드 카드 + 시나리오 템플릿 갤러리 | 3단계 실행 위저드 미채택(추후 추가 가능 구조). 위저드의 "부하 크기 프리셋" 아이디어는 RunDialog chips로 흡수 |
| 3 | UI 언어 = **한국어 통일**, 기술 고유명사(VU·RPS·p95·cron·YAML)는 원어 유지 + 첫 등장 지점 설명 | |
| 4 | 신규·변경 문구는 **메시지 카탈로그(`ui/src/i18n/ko.ts`) 경유** | i18n 라이브러리 미도입(YAGNI). 언어 토글은 범위 밖 — 나중에 `en.ts` + 컨텍스트만 추가하면 되는 구조 준비 |
| 5 | **UI-only** | 알려진 백엔드 갭(워커 사망 시 영영 running)은 범위 밖이되, UI의 *안내*는 범위 안(§7.4) |

## 2. 공통 인프라 (모든 슬라이스의 기반)

### 2.1 메시지 카탈로그 `ui/src/i18n/ko.ts`

- 도메인별 네임스페이스의 **typed 상수 객체** (예: `ko.runDialog.vusLabel`), 컴포넌트가 직접 import. 런타임 치환 함수·라이브러리 없음.
- 매개변수 문구는 함수 상수로: `ko.report.summaryLine(count, p95s, errPct)`.
- 이번 작업에서 **새로 쓰거나 바꾸는 문구만** 카탈로그로 이동 — 기존 미변경 문구의 소급 추출은 비목표(반쪽 토글을 만들지 않기 위해 토글 자체를 범위 밖으로 뒀으므로 모순 없음).

### 2.2 `<HelpTip>` 공유 컴포넌트

- ⓘ 버튼 + **클릭 토글** popover (hover 전용 금지 — 터치·키보드 접근성). ESC/외부 클릭으로 닫힘.
- a11y: `<button aria-expanded aria-controls>` + popover `role="note"`. 이 repo의 a11y 컨벤션(중복 aria-label 금지, 형제 span 패턴) 준수.
- 용어 정의는 §2.3 사전을 참조해 렌더 — 화면마다 설명이 달라지는 것을 구조적으로 방지.

### 2.3 용어 사전 (`ko.ts` 내 `glossary` 네임스페이스)

단일 소스 정의: VU(동시 사용자), RPS(초당 요청 수), p50/p95/p99(백분위 응답시간 — "전체 요청의 95%가 이 시간 안에 응답, 낮을수록 좋음"), ramp-up(점진 시작), closed/open-loop(사용자 수 기준/요청 속도 기준), think time(요청 간 대기), max in-flight(동시 요청 상한), SLO(합격 기준), 시나리오/스텝/run의 개념 정의.

## 3. 홈 온보딩 · 빈 상태 · 길찾기

### 3.1 시작 가이드 카드 (홈 = 시나리오 목록 상단)

- 3단계 체크리스트: ① **시나리오 만들기** — 테스트할 API 요청 정의 ② **실행하기** — 동시 사용자 수·시간을 정해 부하 발사 ③ **결과 읽기** — 응답속도·에러로 합격 판단. 각 단계에 해당 화면 링크.
- 진행 판정: ①은 서버 진실(`useScenarios().data`는 `{scenarios: […]}` 래퍼 — **`data.scenarios.length > 0`**, 34c CRITICAL 전례 주의), ②·③은 **localStorage 플래그**(run 생성 성공 시·리포트 열람 시 기록). 전역 run 목록 API가 없으므로(`GET /api/runs` 부재 — 루트 CLAUDE.md) 서버 파생은 ①만.
- localStorage 키: `handicap.onboarding.v1` = `{ runCreated: boolean, reportViewed: boolean, dismissed: boolean }`.
- 3단계 모두 완료 또는 ✕ dismiss 시 영구 숨김.

### 3.2 빈 상태 문구 전면 교체 — "무엇 + 언제 + 다음 행동" 3요소 패턴

| 페이지 | 교체 문구(요지) |
|---|---|
| 시나리오 목록 | "시나리오는 부하를 줄 API 요청 흐름입니다. 템플릿에서 시작해보세요. → 새 시나리오" |
| 데이터셋 | "시나리오의 `{{변수}}`에 줄 단위로 주입할 CSV/XLSX 표입니다. 시나리오가 변수를 쓸 때만 필요해요. → CSV 업로드" |
| 환경 | "`${BASE_URL}` 같은 환경 변수 묶음입니다. 같은 시나리오를 dev/stage에 번갈아 쏠 때 씁니다. → 환경 만들기" |
| 스케줄 | "시나리오를 정해진 시각(1회) 또는 주기(cron)로 자동 실행합니다. 합격 기준과 함께 쓰면 회귀 감시가 됩니다. → 스케줄 만들기" |
| run 목록(0건) | "아직 실행 기록이 없습니다. → 실행하기" |

### 3.3 길찾기

- 네비 한국어화: `시나리오 · 데이터셋 · 환경 · 스케줄`. 주 동선(시나리오)과 보조 리소스(나머지 3개) 사이 **시각 구분(구분선)** — 구조·라우트 변경 없음.
- **breadcrumb**: run 상세 `시나리오 > {이름} > 실행 목록 > #run`(현재 상위 복귀 링크 부재 해소), 에디터·비교 페이지 동일 패턴. 공유 `<Breadcrumb>` 컴포넌트. 비교 페이지는 현재 `useScenario`를 호출하지 않아 시나리오 이름을 모름 — fetch 1개 추가(캐시 히트라 저비용, plan에 반영).

## 4. 시나리오 템플릿 갤러리

- "새 시나리오" 진입 시 템플릿 선택부터: **빈 시나리오 / 단순 GET(헬스체크 1스텝) / 로그인 흐름(POST→토큰 extract→인증 GET) / 데이터 기반(CSV 변수 주입)**.
- 클라 상수 `ui/src/scenario/templates.ts` — UI-only. 각 템플릿은 유효 ULID id·`version: 1`·step `name` 필수 규칙을 충족하는 완전한 YAML.
- 템플릿 YAML에 **한국어 주석** 포함("# 여기에 테스트할 URL을 넣으세요") — 에디터가 Document API로 주석을 보존하므로 YAML 탭에서 그대로 보여 "고치며 배우는" 자료가 됨. 알려진 한계: 캔버스의 `moveStep`/`removeStep`은 스텝 노드를 통째 교체해 그 스텝의 주석이 소실됨(ui/CLAUDE.md 기존 함정) — 보장 범위는 "편집 전 열람 자료"까지.
- 선택 시 기존 `ScenarioNewPage` 에디터에 해당 YAML이 시드된 채 진입(STARTER_YAML 자리 대체). 라우트 신설 없이 진입 화면 내 단계로 처리 — 단 `EditorShell.initialYaml`은 mount 시 1회 고정(`initialRef`)이므로 **템플릿 선택 화면을 EditorShell mount 이전 단계로** 배치(선택 완료 후 EditorShell 렌더).

## 5. 시나리오 에디터

### 5.1 빈 캔버스 → 행동 유도
- 빈 상태 문구: "HTTP 스텝을 추가해 시작하세요. 스텝 = 부하 중 반복 실행될 HTTP 요청 1개."
- 추가 버튼 4종 재라벨 + 한 줄 부연: `+ HTTP 스텝`(기본) / `+ 반복(loop)` / `+ 조건(if)` / `+ 동시 실행(parallel)`. 고급 3종은 시각 톤 다운(기본 동선 = HTTP 스텝). 컨테이너 내부용 변형 라벨("+ Add step in loop" 등 CanvasView의 5번째 변형)도 재라벨 대상에 포함.

### 5.2 스텝 설정 패널(Inspector) 재라벨링 + 필수 표시
- 패널 제목 "Inspector" → **"스텝 설정"**. Assertions → "응답 검증", Extracts → "값 추출 — 응답에서 꺼내 다음 스텝에서 `{{이름}}`으로 사용".
- URL 필드: 필수 표시(\*) + placeholder `https://api.example.com/login 또는 ${BASE_URL}/login` + 빈 값이면 인라인 경고 + **캔버스 노드 ⚠ 배지**. 저장은 막지 않음(작성 중 상태 허용).
- **선행 모델 변경(이 결정 없이는 위 UX 도달 불가)**: `RequestModel.url`의 `z.string().min(1)`을 **빈 문자열 허용으로 완화**. 현 구조에선 URL을 비우면 reparse가 Zod에 실패해 모델이 stale로 남고(store가 yamlError만 세팅) 경고·배지·카운트가 전부 불성립. 엔진 와이어는 `url: String`(빈 값 허용)이라 완화는 와이어 1:1에 **더 가까워지는** 방향이고, 빈 URL run은 기존 fail-fast(status 0) 동작 그대로. U3에 포함.
- 스텝 추가 직후 자동 선택(현행 유지) + "오른쪽 패널에서 설정하세요" 힌트 1회 노출.

### 5.3 변수 표기 치트시트
- Variables 패널·스텝 설정 텍스트 입력 근처 공유 popover: **`{{var}}` = 흐름 변수**(시나리오 변수·값 추출·데이터셋 바인딩) / **`${ENV}` = 환경 변수**(실행 시 선택한 환경에서 주입) / **`${vu_id}` 등 = 시스템 변수**. ADR-0014의 3분류를 사용자 언어로.

### 5.4 검증 피드백 조기화
- 에디터 상단 **시나리오 문제 요약 배너**(상시). 항목을 두 계층으로 분리:
  - **모델-가용 항목**(빈 URL 스텝 등 파싱 성공 상태에서 검출): 클릭 시 해당 스텝 선택.
  - **게이트 에러 항목**(YAML 파싱 실패·Zod 게이트 실패 — 이때 모델은 stale): 스텝 선택 **비활성** + "YAML 탭에서 확인" 유도(stale 모델 기준 선택은 거짓 정보). 현재 yamlError가 YAML 탭에서만 보이는 갭(캔버스 탭 무표시)도 이 배너가 해소.
- 에러 문구는 Zod 원문이 아니라 카탈로그의 한국어 문구로 매핑(매핑 불가 항목은 원문 fallback).
- 빈 URL 검출은 §5.2의 `url` 모델 완화(U3)에 의존 — U4가 U3 뒤인 이유.

### 5.5 test-run 발견성
- 페이지 하단 `TestRunSection`을 헤더 버튼 **"미리 1회 실행"**으로 승격(클릭 시 기존 섹션으로 스크롤 + 실행 트리거). "저장 없이 현재 내용으로 실제 요청 1회를 보내 확인합니다" 설명 부착.
- 트리거 메커니즘: `TestRunSection`은 env/maxRequests 등 입력이 전부 내부 state인 자족 유닛이므로, **`forwardRef` + `useImperativeHandle`로 `runNow()` 핸들 노출**(state 리프트 대신 — mutation 호출 경로는 무변경, 컴포넌트 API만 확장). 소비자는 `ScenarioNewPage`·`ScenarioEditPage` 둘 다 — 두 헤더 모두 배선.

## 6. Run 설정 (RunDialog 재구성)

### 6.1 3그룹 재편 (8개 섹션 평면 나열 → 관련 필드 묶기)
1. **부하 정의** — 크기 프리셋 chips + 동시 사용자/시간 + 부하 모델 전환
2. **대상 설정** — 환경 선택 + 데이터 바인딩(현행 조건 유지 = **시나리오 YAML 파싱 성공 시 표시**; 변수 없으면 패널이 자체적으로 "매핑 없음" 상태. loop 조건은 루프 캡 컨트롤에만 해당)
3. **판정·고급**(기본 접힘) — 합격 기준(SLO) / 페이싱(think time — **현행 closed-loop 전용 조건 유지**, open-loop에선 비노출) / 진단(타임아웃·루프 캡·measure_phases — 현재 상시 노출이던 타임아웃·루프 캡이 접힘으로 이동, §1.2의 +1 클릭 허용 대상). 펼침은 **single-level** — 기존 `sloOpen`/`pacingOpen` 자체 토글을 그룹 펼침으로 통합해 이중 접힘(2클릭) 금지, "값 있으면 자동 펼침 + N개 설정됨 힌트"는 유지.

기존 collapsible 패턴(값 있으면 자동 펼침 + "N개 설정됨" 힌트 — 사용자 선호 메모)을 유지·확장.

### 6.2 부하 크기 프리셋 chips
- `가볍게 10명·30초 / 보통 50명·1분 / 세게 200명·3분 / 직접 입력`. 선택 시 VU·duration 필드를 채우는 **단순 prefill**(ramp-up 등 다른 필드 불변, 제출 payload 형식 불변). chips는 closed-loop 모드에서만 표시.
- 소속: **`LoadModelFields` 내부**(VU/duration 입력이 거기 있음) — 따라서 §6.7대로 ScheduleForm에도 자동 노출(스케줄에서도 부하 크기 프리셋 의미 동일, 정합).

### 6.3 용어 한국어화 + HelpTip
- "VU" → "동시 사용자(VU)" ⓘ, "Closed-loop (VU)/Open-loop (rate)" → "사용자 수 기준/요청 속도 기준(RPS)" + 각각 언제 쓰는지 한 줄, ramp-up → "점진 시작", max in-flight → "동시 요청 상한", SLO criteria → "합격 기준". 원어 괄호 병기.

### 6.4 막힘 해소
- Run 버튼 비활성 시 **이유를 버튼 옆에 명시**("데이터 바인딩에서 `{{user}}` 변수의 열을 선택하세요").
- 변수명 수준 사유를 위해 `DataBindingPanel` contract 확장: `onValidityChange(ok: boolean)` → **`onValidityChange(ok, reasons: string[])`** (현재는 boolean만 emit이라 일반 문구밖에 못 만듦). 두 번째 소비자 `ScheduleForm`에도 같은 reasons UX 적용(U1b의 ScheduleForm 정리에 포함 — TS상 기존 1-인자 콜백도 컴파일은 통과하므로 누락 주의).
- 데이터 바인딩 자동 매칭 시 "자동 연결됨" 배지(현재는 무신호).

### 6.5 검증 메시지 한국어 통일 — 한영 혼재를 카탈로그 경유로 통일.

### 6.6 고급 사용자 보존 (불변식)
- 모든 기존 필드·프리셋 CRUD·retry prefill 동선 보존. 클릭 수 불변의 정확한 범위는 §1.2(주 동선 불변, 진단 필드 +1 허용).
- **제출 payload byte-identical** — 같은 입력이면 `POST /api/runs` payload가 재구성 전과 동일. 불변식 테스트 추가(부하 모드 선택기 전례).
- 기존 RunDialog 테스트의 취급을 두 부류로 분리(전부 무수정 통과는 §6.1 재배치·§6.3 재라벨·§6.5 한국어화와 **양립 불가** — 접힌 입력은 DOM에 없고 라벨·에러 원문 단언이 깨짐):
  - **payload/제출 동작 단언**: 무수정 통과 필수.
  - **라벨·문구·펼침 상태 단언**: 카탈로그 문구·새 그룹 구조 기준으로 갱신 허용(단 payload 의미 변경은 금지). plan 단계에서 두 부류의 테스트 식별 목록을 작성.

### 6.7 ScheduleForm 자동 수혜 — `LoadModelFields`/`CriteriaFields`/`profileForm` 공유 컴포넌트라 같은 개선이 그대로 적용. ScheduleForm 고유 문구만 별도 정리.

## 7. 결과 해석 (리포트 · run 목록)

### 7.1 "쉬운 요약" 헤더
- 기존 카드 위 한 문장 요약: "1분 동안 동시 사용자 50명이 12,345회 요청 — 95%가 0.21초 안에 응답, 에러 0.3%". **클라 파생**(백엔드 무변경). open-loop run은 "목표 N RPS로 M회 요청…" 변형.
- VU/target_rps 출처: `ReportRunSchema.profile`은 `z.unknown()`이라 직접 못 읽음 — RunDetailPage가 이미 fetch한 typed `run.data.profile`을 **ReportView에 prop으로 전달**(재파싱 대신).
- SLO verdict 있으면 **합격/불합격을 페이지 최상단에 크게**. 없으면 "합격 기준을 설정하면 다음부터 자동 판정합니다" 한 줄(SLO 발견성).

### 7.2 통계 용어 해설 — p50/p95/p99 라벨에 HelpTip(§2.3 사전 참조), Summary 카드·StepStatsTable 등 표 헤더 한국어화("Total requests" → "총 요청").

### 7.3 인사이트 행동화 — 기존 결정론적 insight **7종**의 **렌더링에** "다음 행동" 한 줄 추가(클라 매핑, 백엔드 insight 구조 무변경). kind 전수표:

| kind | 다음 행동 문구(요지) |
|---|---|
| `slowest_step` | "이 API가 병목 — 스텝 표를 내보내 개발팀과 공유하세요" |
| `error_hotspot` | "이 스텝의 응답 검증 조건과 서버 로그를 확인하세요" |
| `no_request_step` | "이 스텝에 요청이 없었습니다 — 조건 분기·시나리오 구조를 확인하세요" |
| `status_class` | "4xx면 요청 형식(인증·파라미터), 5xx면 서버 측 문제부터 확인하세요" |
| `status_temporal` | "테스트 후반 5xx 증가 — 서버 자원 고갈 의심, 더 긴 soak 테스트를 고려하세요" |
| `slo_failure` | "미달 기준 행을 확인하고 임계값 또는 서버 성능 중 무엇을 조정할지 정하세요" |
| `slo_pass` | (행동 없음 — 명시적 제외, 현행 렌더 유지) |

### 7.4 running 상태 진단 힌트
- run 상세가 **15초 넘게 요청 0건 + status=running**이면 배너: "워커가 시작하지 못했을 수 있습니다 — 시나리오 URL과 컨트롤러 로그를 확인하세요" (알려진 "영영 running" 백엔드 갭의 UI 측 완화 — 갭 자체 수정은 범위 밖).
- 경과 기준 시각 = `started_at`(running이면 워커 register 시점에 세팅돼 non-null; 방어적 fallback `created_at`). 판정 데이터는 기존 `useRun`/`useRunMetrics` 1s 폴링으로 이미 가용 — 신규 fetch 없음. pending 고착 변형은 reaper fail-fast(2026-06-05)가 백엔드에서 이미 처리하므로 범위 밖.
- run 목록의 running 행에 경과 시간 표시(`started_at` 기준 클라 계산).

### 7.5 소소한 정리
- VerdictBadge FAIL 사유를 hover 전용 `title`에서 클릭 popover로(HelpTip 패턴 재사용). (감사가 지적했던 "failed 사유가 리포트 로딩에 가려짐"은 재검증 결과 이미 사유 배너가 무조건 위에 렌더되고 있어 비항목.)

## 8. 슬라이스 분해 (각각 독립 머지 가능)

| 슬라이스 | 내용 | 본문 | 의존 |
|---|---|---|---|
| **U1a** | 카탈로그(`ko.ts`)+HelpTip+용어 사전 구축 — 최소 소비처 1곳(**리포트 Summary 카드**의 p50/p95/p99 HelpTip로 핀; StepStatsTable 등 나머지 표면은 U5 잔여)과 함께 출하해 dead code 금지 | §2 (+§7.2 일부) | — |
| **U1b** | RunDialog 재구성 전체(3그룹·chips·재라벨·막힘 해소·검증 한국어화) + ScheduleForm 고유 문구 정리 | §6 | U1a |
| **U2** | 홈 가이드 카드 + 빈 상태 전면 교체 + 네비 한국어화·구분 + breadcrumb | §3 | U1a |
| **U3** | 템플릿 갤러리 + 에디터 진입 장벽(빈 캔버스·스텝 설정 재라벨·필수 표시·치트시트·`url` 모델 완화) | §4, §5.1–5.3 | U1a |
| **U4** | 에디터 검증 피드백 배너 + test-run 승격 | §5.4–5.5 | U3 (배너의 빈 URL 검출이 U3의 `url` 완화에 의존 — 완화가 빠지면 U4 불성립) |
| **U5** | 리포트 해석(요약 헤더·용어 해설 잔여·인사이트 행동화·running 힌트·소소한 정리) | §7 | U1a |

- U1a 첫 번째 고정(기반). U1b/U2/U3/U5는 U1a 뒤 순서 조정·병렬 가능, U4만 U3 뒤.
- 각 슬라이스는 별도 plan(writing-plans) + subagent-driven 구현 + task별 2단계 리뷰 + 최종 handicap-reviewer (repo 관행).

## 9. 테스트 전략

- 슬라이스마다 RTL + vitest(기존 컨벤션). **U1b는 payload byte-identical 불변식 테스트** — 기존 RunDialog 테스트(`__tests__/RunDialog.test.tsx`)는 §6.6의 두 부류 분리 적용(payload 단언 무수정 통과 / 라벨·문구·펼침 단언은 갱신 허용).
- 템플릿 YAML: `parseScenarioDoc` round-trip + 주석 보존 + 4종 전부 Zod 게이트 통과 테스트.
- U3의 `url` 완화 락인 테스트: 빈 url 시나리오가 모델 파싱을 통과하고 인라인 경고 + 캔버스 ⚠ 배지가 렌더됨을 단언.
- HelpTip: 키보드(Enter/ESC)·aria 단언.
- localStorage 온보딩 로직: 순수 헬퍼로 추출해 단위 테스트(jsdom localStorage).
- 게이트: 슬라이스 머지 전 `pnpm lint && pnpm test && pnpm build` + **라이브 Playwright 1회**(S-D 교훈 — run 생성/응답 파싱 경로는 RTL로 안 잡힘).

## 10. 명시적 비목표 (범위 밖)

- 언어 토글(en 카탈로그·설정 UI) / 기존 미변경 문구의 소급 카탈로그 추출
- 3단계 실행 위저드(미채택 — 추후 별도 슬라이스 가능)
- 노드 드래그 재배치, YAML 전체 포맷 단축키, 응답 기반 extract authoring
- 차트 기준선 오버레이, 비교 뷰 개선, test-run 히스토리
- 백엔드 status-transition 갭 수정, 신규 API/엔드포인트, 엔진·proto·migration 변경 일체
- 보조 페이지의 구조 개선(빈 상태 문구 교체 §3.2만 범위)

## 11. 참고

- 감사 출처: 2026-06-11 6영역 병렬 UX 감사(이 brainstorming 세션, 워크플로 `ux-surface-audit`).
- 관련 ADR: 0003(GUI↔Code 양방향), 0014(변수 표기 3분류 — §5.3의 근거), 0024(프리셋), 0028(SLO).
- 전례 spec: `2026-06-05-load-model-mode-selector-design.md`(payload byte-identical UX 리팩터), `2026-06-01-header-form-bulk-entry-design.md`(순수 UI QoL).
- **ADR 후보**: "UI 문구 한국어 통일 + 메시지 카탈로그 경유" 정책은 이후 모든 UI 작업을 구속하는 컨벤션이므로 ADR-0035로 기록할 가치가 있음 — spec 리뷰 시 사용자 결정.
