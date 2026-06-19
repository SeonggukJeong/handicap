# 에디터 test-run UX 정리 + 스킴-없는 URL 검출 — 헤더 중복 제거·미리 테스트 목적 자명화·검증 배너 일반화 (영역 U 후속 폴리시, roadmap §A8 ① 묶음)

- **날짜**: 2026-06-19
- **상태**: 설계 승인(사용자 2026-06-19) → plan 대기
- **출처**: 사용자 요청(2026-06-19) — 오랜만에 에디터를 보니 헤더 `미리 1회 실행` 버튼이 "왜 여기 있는지" 모르겠고, 아래 `TestRunSection`이 같은 일을 하는데 중복으로 헷갈린다. roadmap §A8 ① "에디터/검증 UX 폴리시"(U4 잔여 "헤더 '미리 1회 실행' pending 피드백 없음" + "스킴-없는 호스트 URL 미검출") 묶음을 test-run 재배치 중심으로 흡수. **왜 지금**: 내부 테스트 단계 — 편의(QoL) 트랙(§B10) 완결 후 초보자 친화 폴리시 마무리.
- **연관**: ADR-0035(UI 한국어·`ko.ts` 단일 소스), U4 spec `2026-06-11-ux-beginner-friendly-redesign-design.md`(§5.4 검증 배너·§5.5 test-run 헤더 승격 — 이 슬라이스가 그 §5.5 결정을 일부 되돌림), C-2 `2026-06-01-scenario-editor-test-run-design.md`(`TestRunSection` 출처). 파일: `ui/src/components/scenario/TestRunSection.tsx`·`ui/src/pages/ScenarioEditPage.tsx`·`ui/src/pages/ScenarioNewPage.tsx`·`ui/src/scenario/problems.ts`·`ui/src/components/scenario/ValidationBanner.tsx`·`ui/src/i18n/ko.ts`.
- **ADR**: 신규 불필요(ADR-0035 범위 내 UI 폴리시·additive). U4 §5.5 "헤더 승격" 미세 조정이라 ADR supersede 불요(U4 ADR-0035 자체는 "한국어 단일 소스"가 본질이고 헤더 배치는 비-normative).

---

## 1. 문제와 목표

에디터(`/scenarios/:id`·`/scenarios/new`) 헤더에 `미리 1회 실행` 버튼이 있고(`runNow()` → 아래로 스크롤 + **현재 보이지 않는 기본값**[max 50·env 없음·think 없음]으로 즉시 실제 요청 발사), 동시에 에디터 아래 `TestRunSection`이 같은 라벨("미리 1회 실행")로 env·max·think 컨트롤 + 자체 실행 버튼 + 결과 패널을 갖는다. 결과: ① **라벨 중복**("왜 둘?") ② **숨은-기본값 발사**(컨트롤이 한참 아래 있는데 헤더 클릭은 안 보이는 설정으로 실행) ③ 헤더 6버튼 과밀 ④ 돌아왔을 때 헤더 버튼 **목적 불명**. 또한 검증 배너(`collectProblems`)는 빈 URL·`/`-prefix(host 없음)만 잡고 `example.com/api`처럼 **스킴 없는 리터럴 URL**은 놓쳐(엔진은 동일하게 fail-fast=status 0) 초보자가 침묵 속에 깨진 시나리오를 돌린다.

- **목표**: test-run 진입을 **에디터 아래 섹션 하나**로 통합(헤더 중복·숨은-발사 제거)하고 그 섹션의 **목적을 자명**하게(미리보기 ≠ 실제 부하 run) 만든다. 검증 배너 URL 검사를 일반화해 스킴-없는 host URL도 잡는다(false-negative-safe).
- **비목표(연기)**: §7 참조. ①의 게이트 문구 한국어 매핑 확장·errPct floor 등 비-test-run 항목은 ① 잔여로 남김.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 헤더 `미리 1회 실행` 버튼 + 인접 HelpTip을 `ScenarioEditPage`·`ScenarioNewPage` **양쪽**에서 제거한다. **이때 unused가 되는 `HelpTip` import도 함께 제거한다**(양 페이지에서 HelpTip 유일 소비처 = 이 버튼, line 109 — 안 지우면 `lint --max-warnings=0` 실패; `useRef`는 `baselineSeededRef`/`didImportSeed`가 계속 써서 유지). | 두 페이지 RTL에서 헤더에 `미리 1회 실행`(구 `testRunNow`) role=button **부재** 단언 + `pnpm lint` green. | |
| R2 | MUST `TestRunSection`을 ref-free 평범 컴포넌트로 전환한다(`forwardRef`/`useImperativeHandle`/`TestRunHandle`/`runNow()`/`rootRef`+scrollIntoView 제거). 발사 경로 = 섹션 자체 버튼 하나뿐. | `TestRunHandle` export 제거 + `pnpm build`(tsc) green + 섹션 버튼만으로 test-run 발사하는 RTL. | |
| R3 | MUST `TestRunSection` 제목과 한 줄 안내를 목적-자명하게 한다(저장·부하 없이 1회 보내 확인 + 실제 부하는 ‘실행 기록’에서). 문구는 `ko.ts` 경유, **확정 카피는 §4.2**(`testRunTitle`="시나리오 미리 테스트" ≠ 현재값 "미리 1회 실행"). | 섹션에 §4.2의 정확한 제목 + 안내 문구가 렌더됨을 RTL `getByText`로 단언. | |
| R4 | MUST `TestRunSection`의 컨트롤 region `aria-label`(`testRunControlsAria`, `TestRunSection.tsx:64`)과 결과 region `aria-label`(`testRunResultAria`, `TestRunPanel.tsx:451`)을 **둘 다 보존**하고 실행 버튼은 primary 스타일로 둔다. | 기존 `getByRole("region",{name})` 셀렉터 통과 + 버튼 렌더. | |
| R12 | MUST 공유 키 `testRunTitle`을 분리한다 — 현재 `TestRunSection.tsx:67`(컨트롤 `<h3>`)와 `TestRunPanel.tsx:455`(결과 패널 `<h3>`)가 **같은 키를 공유**하므로, 컨트롤 제목만 rename(R3, `testRunTitle`="시나리오 미리 테스트")하면 결과 패널 제목도 조용히 바뀐다. 결과 패널은 신규 키 `testRunResultTitle`(="미리 테스트 결과")로 교체해, 컨트롤 제목 ≠ 결과 제목이 되게 한다. | `TestRunPanel.test`: 결과 패널 제목 "미리 테스트 결과" 렌더 + 컨트롤 제목과 불일치 단언. | |
| R5 | MUST `collectProblems`의 URL 검사를 일반화: **변수-prefix(`${`/`{{`)가 아닌 리터럴**이 `http://`·`https://`(대소문자 무시)로 시작하지 **않으면** flag한다(기존 빈-URL·`/`-prefix·`//host`·신규 `example.com/api`·`localhost:8080`·`api/users` 포괄). | `problems.test`: `example.com/api`·`localhost:8080`·`api/x`·`/login`·`//host` flag, `http(s)://…` non-flag. | |
| R6 | MUST (false-negative-safe 불변식) 변수로 **시작하는** URL(`${...}`·`{{...}}`)은 **절대 flag하지 않는다**(런타임 해석값 미지 → 유효 시나리오 차단 금지). 변수를 *포함하되 변수로 시작하지 않는* 리터럴(`api/${X}`)은 R5대로 flag(리터럴 prefix가 이미 깨짐). | `problems.test`: `${BASE_URL}/api`·`{{host}}/x`·`${BASE_URL}` non-flag; `api/${X}` flag. | |
| R7 | MUST 스킴-없는/host-없는 URL 메시지를 초보자용 **단일 한국어 문구**로 둔다(`http(s)://` 또는 `${BASE_URL}` 예시 포함). `ko.ts` 경유. 기존 `problemHostlessUrl`을 이 일반 문구(`problemUrlNeedsScheme`)로 대체(통합). | 배너에 통합 메시지 렌더 단언 + `problemHostlessUrl` 잔존 참조 0. | |
| R8 | MUST `ko.ts`에서 `testRunNow`·`testRunNowHelpLabel`·`testRunNowHelp`(헤더 버튼 카피)를 제거하고, `ko.opsSettings`의 `max_test_run_requests` 참조 문구 **2개**(`desc`[ko.ts:805] + `effect`[ko.ts:820-821], 둘 다 `SettingsPage.tsx`가 렌더)를 새 제목과 lockstep으로 갱신한다. | `grep` 잔존 참조 0 + `pnpm build` green. | |
| R9 | SHOULD `TestRunSection`의 인라인 한국어 `"think time 적용 (천천히 전송)"`(`TestRunSection.tsx:92`)을 `ko.ts` 키(`editor.testRunThinkTime`, **값 verbatim 보존** — `name:/think time/i` 셀렉터 유지)로 이전한다(half-catalog 잔여, ADR-0035 고유명사 원어 병기 허용). | 컴포넌트에서 인라인 리터럴 제거 + `ko` 키 렌더 + 기존 `name:/think time/i` 통과. | |
| R10 | MUST (무변경 불변식) 엔진·proto·controller·migration 0, `POST /api/test-runs` 요청 payload(`apply_think_time` 포함)와 `ScenarioTrace` 파싱은 byte-identical(test-run **동작** 무변경 — UI 배치/라벨만). | 머지 diff = `ui/`(+docs) only + `useTestRun`/`createTestRun`/`ScenarioTraceSchema` 무변경 확인. | |
| R11 | MUST 페이지 test-run 테스트(`ScenarioEditPage.testrun`·`ScenarioNewPage.testrun`)의 **영향받는 4개 테스트 전부**(각 파일의 primary 테스트 `:70`/`:61` + U4 테스트 `:91`/`:101` — 넷 다 현재 헤더 버튼 `미리 1회 실행`으로 발사)를 **섹션 버튼**(`testRunRun`="미리 실행") 발사로 재작성한다. 셀렉터는 정확/앵커 매치(구 "미리 1회 실행"의 부분문자열 "미리 실행" 오매치 주의 — 단 헤더 버튼 제거 후엔 충돌 소멸). | `pnpm test` 전체 green(두 파일 포함). | |

- **`seam?`**: 이 슬라이스는 계약 경계(UI Zod ↔ serde / proto / migration / CSV·XLSX)를 **건드리지 않는다** — `seam ✅` R 없음. R10이 그 무경계성(test-run 와이어 byte-identical)을 명문화한다. 그래서 최종 리뷰는 1:1 와이어 대조 부담이 없고 라이브 검증도 waivable(§6).

---

## 3. 핵심 통찰 (설계 근거)

1. **R1+R2(헤더 제거)가 ③ 죄(중복·숨은-발사·과밀)를 한 번에 없앤다.** 헤더 버튼의 본질 문제는 "컨트롤을 못 본 채로 실행"이다 — 발사 경로를 섹션 버튼 하나로 collapse하면 사용자는 항상 env·max·think를 본 뒤 실행하게 되어 숨은-기본값 surprise가 구조적으로 불가능해진다. U4 §5.5가 "발견성"을 위해 헤더로 승격했으나, 섹션이 캔버스 **바로 아래**(긴 페이지가 아님)라 강화된 제목(R3)만으로 발견성은 충분 — 승격이 만든 혼란 > 발견성 이득.
2. **R3은 "왜 여기 있지?"에 직접 답한다.** test-run의 목적(저장·부하 없이 동작을 1회 확인하는 **미리보기**)과 실제 부하 run(`실행하기`, 별도 페이지)의 구분을 한 줄로 못 박아, 초보자가 두 실행을 혼동하지 않게 한다. (오늘은 `testRunTitle`(`ko.ts:344`)이 헤더 버튼 라벨 `testRunNow`(`ko.ts:275`)와 **글자까지 동일**=`"미리 1회 실행"`이라 중복이 더 심하다 — R3 rename이 이 동일성을 깬다.)
3. **R5의 일반화 규칙이 R6(false-negative-safe)을 만족시키는 유일한 안전한 형태**: "리터럴인데 `http(s)://` 없음 → flag, 변수-prefix → skip". 변수(`${BASE_URL}`)는 런타임에 전체 URL로 해석될 수 있어 UI가 정적으로 판단 불가 → skip해야 유효 시나리오를 거짓 차단하지 않는다(기존 `/`-prefix-only 검사의 보수성을 유지·확장). 이 한 규칙이 기존 `/`-prefix(host 없음)와 신규 스킴-없음을 **포괄**하므로 별도 분기 누적이 아니라 일반화다.
4. **R7 메시지 통합**: `/login`(host 없음)과 `example.com/api`(스킴 없음)는 root cause가 미묘히 다르나, 초보자의 **행동 처방은 동일**("전체 URL `https://…` 또는 `${BASE_URL}/…` 사용"). 단일 문구가 인지 부담이 낮다 → 기존 `problemHostlessUrl`을 흡수.
5. **R10(무변경)이 이 슬라이스를 안전하게 만든다.** test-run의 엔진 trace·payload·파싱은 손대지 않고 UI 배치/라벨만 바꾸므로 S-D 갭(서버 응답경로 버그)과 무관 → 라이브 waivable.

---

## 4. 변경 상세

### 4.1 `ui/src/pages/ScenarioEditPage.tsx` / `ScenarioNewPage.tsx` — 충족 R: R1, R2
- 헤더의 `<Button variant="secondary" onClick={() => testRunRef.current?.runNow()}>{ko.editor.testRunNow}</Button>` + 인접 `<HelpTip>` 제거(양 파일, 현재 각 ~line 106–109).
- `const testRunRef = useRef<TestRunHandle>(null)` 및 `<TestRunSection ref={testRunRef} …>`의 `ref` prop 제거 → `<TestRunSection yamlText={yamlText} />`. `TestRunHandle` import 제거.
- **`HelpTip` import 제거**(양 페이지에서 유일 소비처가 이 버튼 — `ScenarioEditPage.tsx:7`·`ScenarioNewPage.tsx:6`; 안 지우면 `eslint --max-warnings=0` 실패). `useRef`는 다른 ref(`baselineSeededRef`/`didImportSeed`)가 계속 쓰므로 **유지**.

### 4.2 `ui/src/components/scenario/TestRunSection.tsx` — 충족 R: R2, R3, R4, R9
- `forwardRef`/`useImperativeHandle`/`TestRunHandle` 인터페이스/`runNow()`/`rootRef`(+`scrollIntoView`) 제거 → 평범한 `export function TestRunSection({ yamlText }: { yamlText: string })`. 이제 unused가 되는 import(`forwardRef`/`useImperativeHandle`/`useRef`)도 정리(`useMemo`/`useState`는 유지).
- **확정 카피(이 값이 R3/R9 테스트의 정확 문자열)**:
  - `editor.testRunTitle` = **"시나리오 미리 테스트"** (현재값 "미리 1회 실행" 대체).
  - 신규 `editor.testRunIntro` = **"저장·부하 없이 현재 내용으로 요청을 1회 보내 동작을 확인합니다. 실제 부하 실행은 ‘실행 기록’에서 합니다."** — `<h3>` 아래 `<p className="text-sm text-slate-600">`로 렌더(‘실행 기록’은 강조 텍스트, 링크화는 비목표).
  - 실행 버튼: 기존 `<Button onClick={fire}>` 유지(default=primary). 라벨 `editor.testRunRun` = **"미리 실행" 유지(불변)** — 헤더 버튼 제거 후엔 "미리 1회 실행" 텍스트가 사라져 부분문자열 충돌 없음.
  - 신규 `editor.testRunThinkTime` = **"think time 적용 (천천히 전송)"**(현 line 92 인라인과 verbatim 동일 → `name:/think time/i` 셀렉터 유지).
- region `aria-label`(`testRunControlsAria`, line 64)은 그대로(R4).
- **공유 키 분리(R12)**: `testRunTitle`(`ko.ts:344`)은 현재 이 파일 `:67` **그리고** `TestRunPanel.tsx:455`(결과 패널)가 공유한다. 컨트롤 제목만 rename하면 결과 패널도 같이 바뀌므로, 결과 패널은 §4.2a에서 별도 키로 분리한다.

### 4.2a `ui/src/components/scenario/TestRunPanel.tsx` — 충족 R: R12, R4
- 결과 패널 `<h3>`(`TestRunPanel.tsx:455`)의 `{ko.editor.testRunTitle}`을 신규 `{ko.editor.testRunResultTitle}`("미리 테스트 결과")로 교체 — 이것만 변경(결과 region `aria-label`·ok/fail chip·timing·본문 트리·`onAddExtract` 경로 등 **나머지 전부 무변경**, test-run 동작·와이어 byte-identical=R10 유지). 이 파일은 *제목 라벨 한 줄*만 손댄다.

### 4.3 `ui/src/scenario/problems.ts` — 충족 R: R5, R6, R7
- `collectProblems` 내부 http-step 루프의 URL 분기를 일반화:
  ```
  const url = s.request.url.trim();
  if (url === "") → problemEmptyUrl
  else if (startsWithVar(url)) → (skip)               // ${ 또는 {{ 로 시작 = 변수, 판단 불가 (R6)
  else if (!/^https?:\/\//i.test(url)) → problemUrlNeedsScheme  // 리터럴인데 스킴 없음 (R5/R7)
  ```
  `startsWithVar(url)` = `url.startsWith("${") || url.startsWith("{{")`. 기존 `url.startsWith("/")` 분기는 이 일반 규칙에 흡수(`/login`·`//host`도 `http(s)://` 없음 → flag)되므로 제거. 변수를 *포함하되 시작은 리터럴*(`api/${X}`)이면 R5대로 flag(R6).
- 메시지 키 `problemHostlessUrl` → `problemUrlNeedsScheme`로 대체(R7 통합, name 인자 시그니처 동일). `formatGateMessages` 등 나머지는 무변경.

### 4.4 `ui/src/i18n/ko.ts` — 충족 R: R3, R7, R8, R9, R12
- 제거: `editor.testRunNow`·`editor.testRunNowHelpLabel`·`editor.testRunNowHelp`.
- 수정/추가: `editor.testRunTitle`="시나리오 미리 테스트"(컨트롤 제목) + 신규 `editor.testRunResultTitle`="미리 테스트 결과"(결과 패널, R12) + 신규 `editor.testRunIntro` + 신규 `editor.testRunThinkTime`(값은 §4.2 확정). `editor.problemHostlessUrl` → `editor.problemUrlNeedsScheme`(초보자용 통합 문구, name 인자 함수형 유지 — 예: ``(name) => `${name}: URL은 http:// 또는 https:// 로 시작해야 합니다 (예: https://api.example.com/path 또는 \${BASE_URL}/path)` ``; **`${BASE_URL}`은 TS 템플릿 리터럴이라 `\${BASE_URL}`로 escape 필수**(ui/CLAUDE.md 함정, 현 `problemHostlessUrl`도 escape). 정확 문안은 plan 확정·키/시그니처 고정).
- `ko.opsSettings`의 `max_test_run_requests` 참조 문구 **2개** 갱신(F2): `desc.max_test_run_requests`(ko.ts:805, `'에디터 "미리 1회 실행"이…'`) + `effect.max_test_run_requests`(ko.ts:820-821, "…미리 실행됩니다") — 새 제목/용어와 lockstep, 의미 유지. (네임스페이스는 `ko.opsSettings`, `ko.opsConfig` 아님.)

### 4.5 테스트 — 충족 R: R1, R3, R5, R6, R9, R11
- `ScenarioEditPage.testrun.test.tsx`·`ScenarioNewPage.testrun.test.tsx`: **각 파일 4개 중 영향받는 테스트 전부** 재작성(R-2) — primary 테스트(`:70 POSTs the current buffer…` / `:61 test-runs the unsaved draft…`)와 U4 테스트(`:91`/`:101`) 모두 현재 헤더 `미리 1회 실행` 버튼으로 발사하므로, 섹션 버튼(`name:"미리 실행"`)으로 전환 + "헤더에 구 버튼 부재" 단언 추가.
- `TestRunSection.test.tsx`: `describe("runNow handle")` 블록 전체(`:85-113`) + `scrollIntoView` afterEach 폴리필(`:59`) + unused 될 `createRef`/`act` import(`:1,3`) 제거; 새 제목(`시나리오 미리 테스트`)·안내·`testRunThinkTime`(`name:/think time/i` 유지) 단언. `apply_think_time`/`addedNote` 블록은 ref 없이 유지.
- `TestRunPanel.test.tsx`(R12): 결과 패널 제목이 신규 `미리 테스트 결과`(`testRunResultTitle`)로 렌더됨을 단언(컨트롤 제목 `시나리오 미리 테스트`와 달라야 함 — 공유 키 회귀 방지).
- `ScenarioEditPage.clone.test.tsx`·`ScenarioEditPage.save.test.tsx`(R-3): `vi.mock`의 `forwardRef(function TestRunSection(){return null})`를 plain 함수 컴포넌트로 단순화(R2 ref-free와 일관, `forwardRef` 잔존 참조 제거).
- `problems.test.ts`: R5/R6 케이스 추가(`example.com/api`·`localhost:8080`·`api/x` flag / `${BASE_URL}/api`·`{{host}}/x` non-flag / `http(s)://…` non-flag / `api/${X}` flag) + **기존 `//host`(protocol-relative, `:114-128`) 케이스의 기대 메시지를 `problemUrlNeedsScheme`로 마이그레이션**(R-4, 케이스 유지·키만 변경) + 빈-URL·`/`-prefix(통합 메시지) 회귀.
- `ValidationBanner.test.tsx`(있으면): 메시지 키 변경 반영.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·proto·controller·migration·워커 0** — 머지 diff = `ui/`(+docs)만. (R10)
- **test-run 와이어 byte-identical**: `api.createTestRun`/`useTestRun`/`ScenarioTraceSchema`/`POST /api/test-runs` payload 무변경 — UI 배치·라벨·컴포넌트 구조만 변경. `TestRunPanel`은 **제목 라벨 한 줄(`:455`)만** 교체(R12)하고 결과 동작·aria·본문 트리·extract 경로는 무변경. (R10)
- **검증 배너 변수-URL 동작 보존**: `${...}`/`{{...}}` 시작 URL은 이전에도(`/`-prefix만 잡아서) 안 잡혔고 이후에도 안 잡힘 — 거짓 차단 0. (R6)
- `formatGateMessages`/게이트 문구 매핑·캔버스 ⚠ 배지(`emitStep` `urlMissing`=빈 URL only)·Inspector URL 인라인 경고는 무변경(스킴-없음 검출은 **배너 한정**, `problemHostlessUrl` 출처와 동일 위치).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | 두 페이지 RTL: 헤더에 구 `미리 1회 실행` 버튼 부재 + **`pnpm lint` green**(unused `HelpTip` import 제거 확인) | |
| R2 | `pnpm build`(tsc) green + 섹션 버튼 발사 RTL + `TestRunHandle` export 제거 | |
| R3 | `TestRunSection.test`: 새 제목 "시나리오 미리 테스트" + 안내 `getByText` | |
| R4 | 기존 컨트롤 region `aria-label` 셀렉터 통과 | |
| R5 | `problems.test`: `example.com/api`·`localhost:8080`·`api/x`·`/login`·`//host` flag | |
| R6 | `problems.test`: `${BASE_URL}/api`·`{{host}}/x`·`${BASE_URL}` non-flag; `api/${X}` flag | |
| R7 | 배너 통합 메시지 렌더 + `problemHostlessUrl` grep 참조 0 | |
| R8 | `grep`(testRunNow* 잔존 0) + `max_test_run_requests` desc+effect 2개 갱신 + `pnpm build` | |
| R9 | 인라인 리터럴 제거 + `ko.editor.testRunThinkTime` 렌더(`name:/think time/i` 통과) | |
| R10 | 머지 diff `ui/`(+docs) only + `useTestRun`/`createTestRun`/`ScenarioTraceSchema` 무변경 | |
| R11 | `pnpm test` 전체 green(2 testrun 파일 4 테스트 재작성 + clone/save mock 단순화 + problems.test) | △ |
| R12 | `TestRunPanel.test`: 결과 패널 제목 "미리 테스트 결과" 렌더 + 컨트롤 제목과 불일치 | |

- **△ R11/라이브**: test-run 와이어·엔진 경로 무변경(R10)이라 S-D 갭 무관 → 전체 `/live-verify` 스택 불요. 단 컴포넌트 ref 제거로 구조가 바뀌었으니 머지 전 **빠른 Playwright/수동 1회**(섹션 버튼 클릭 → trace 패널 표시)만 확인.

- **라이브 검증**: test-run **동작**(payload·trace 파싱)·엔진 경로 무변경(R10)이라 S-D 갭 무관 → **waived 후보**. 단 `TestRunSection` 컴포넌트 구조(ref 제거)를 바꿨으니 머지 전 **빠른 수동/Playwright 1회**로 "섹션 버튼 클릭 → trace 패널 표시"만 확인(전체 `/live-verify` 스택 불요). 게이트: `pnpm lint && pnpm test && pnpm build`.

---

## 7. 의도적 연기 (roadmap §A8 ①에 누적)

- **게이트 문구 한국어 매핑 확장**(Zod discriminator-mismatch·`.strict()` Unrecognized key·컨테이너 `min(1)`): 검증 배너 `formatGateMessages` 후속, test-run 비인접 → ① 잔여.
- **headline `errPct` "<0.1%" floor**: 리포트 헤드라인 항목, 에디터 무관 → ① 잔여.
- **test-run 발견성 추가 보강**(빈 시나리오 시 in-editor 포인터 등): R3 제목 강화로 충분하다고 판단, 부족하면 후속.
- **스킴-없음 검출을 캔버스 ⚠ 배지/Inspector로 확장**: 이번엔 배너 한정(`problemHostlessUrl` 출처와 동일). 캔버스 badge는 빈-URL only 유지.

---

## 8. 구현 순서 (plan 입력)

UI-only라 cargo 게이트 무관·whole-feature 단일 흐름. 권장 task 경계(각 green 커밋):

1. **검증 배너 일반화**(R5·R6·R7): `problems.ts` URL 규칙 일반화 + `ko.ts` `problemHostlessUrl`→`problemUrlNeedsScheme` + `problems.test` 케이스(신규 + `//host` 키 마이그레이션). 자족적(test-run과 독립) — 먼저.
2. **TestRunSection ref-free + 목적 자명화 + 공유키 분리**(R2·R3·R4·R9·R12): `forwardRef`/handle/unused import 제거 + 제목("시나리오 미리 테스트")/안내/think-time 카피 `ko.ts` + **`TestRunPanel.tsx:455` 결과 제목을 신규 `testRunResultTitle`("미리 테스트 결과")로 분리**(공유 `testRunTitle` 회귀 방지). `TestRunSection.test`(runNow 블록·폴리필·unused import 삭제) + `TestRunPanel.test`(결과 제목) 갱신.
3. **헤더 버튼 제거 + 페이지/mock 테스트 재작성**(R1·R8·R11): 두 페이지에서 버튼/`HelpTip`(JSX+**import**)/ref/`TestRunHandle` import 제거 + `ko.ts` 헤더 키 3종 제거 + `max_test_run_requests` desc+effect 2개 lockstep + 두 testrun 테스트 **영향 4개** 섹션-버튼화 + clone/save mock `forwardRef` 단순화. (R2가 `TestRunHandle`을 지우므로 이 task는 그 뒤 — tsc widening 순서.)
4. **최종**: `pnpm lint && pnpm test && pnpm build` 전체 green + handicap-reviewer(UI 일관성·a11y·ko.ts 단일소스) + (path-gate상 security-reviewer N/A — 요청실행/템플릿/바인딩/업로드/trace-뷰어 *로직* 무변경) + 라이브 빠른 1회(§6).
