# RunDialog connect hint SR 연결 — Field hintId prop (rundialog-hint-sr)

- **날짜**: 2026-08-03
- **유형**: correctness-bug (a11y — 스크린리더 사용자 정보 접근)
- **출처**: timeout-knob-ui(머지 `e9c8ffd8`) 최종 리뷰 Minor park — "RunDialog connect hint SR 미연결(두 폼 a11y 비대칭이 이 슬라이스에서 최초 발생), fix 방향 = `Field`에 `hintId` additive optional prop"
- **스코프 결정(사용자, 2026-08-03)**: park 항목 1곳이 아니라 **같은 결함 클래스 전부 + 하드코딩 hint ko.ts 정리**. 1차 승인은 `Field` hint 3곳이었고, spec 리뷰 F2가 같은 사용자-결함 클래스의 4번째 사이트(ScheduleForm 루프 집계 상한 — caller-렌더 미연결 hint, 같은 문구 하드코딩 3번째 사본)를 적발해 **스코프 인**(4곳) — 안 넣으면 이 슬라이스가 "루프 집계 상한이 RunDialog에선 낭독·ScheduleForm에선 무음"이라는 새 비대칭을 만든다.

## 사용자 스토리 (US)

**US1** (park 항목 핵심): QA(스크린리더 사용)가 RunDialog 상세 모드에서 연결 수립 타임아웃을 설정하려고 입력에 포커스 — 성공하면 hint("비워두면 미설정 · connect 단계 정지를 요청 타임아웃과 구분해 분류합니다 · HTTP 타임아웃보다 작게 설정해야 합니다")를 낭독으로 듣는다.
- **재현**: SR 켜고 RunDialog(상세 모드) → **판정·고급 섹션**(index 5, `RunDialog.tsx:855-864` — collapsible, prefill 없으면 기본 접힘이라 **펼쳐야 함**) → 진단(`sectionDiag` h4, `:927`) → 연결 수립 타임아웃 입력 포커스
- **기대**: ScheduleForm의 같은 입력(`ScheduleForm.tsx:381` `aria-describedby={connectHintId}`)처럼 hint가 낭독됨
- **실측**: `Field`의 hint `<p>`(`ui/src/components/ui/Field.tsx:32`)에 id가 없어 연결 자체가 불가 → 무음. "HTTP 타임아웃보다 작게" 값 제약을 시각 사용자만 안다.

**US2** (같은 클래스 3곳): QA(스크린리더 사용)가 루프 집계 상한(RunDialog **및 ScheduleForm** — 후자는 Field 밖 caller-렌더 `<span>`이라 경로만 다르고 같은 무음 결함)·동시 요청 상한(open-loop — RunDialog와 ScheduleForm 양쪽에 마운트되는 LoadModelFields) 입력에서도 — 성공하면 각 hint를 낭독으로 듣는다.

**US3** (invalid 공존): QA(스크린리더 사용)가 잘못된 값(예: connect ≥ HTTP 타임아웃)을 입력 — 성공하면 에러 메시지와 hint를 **둘 다** 듣는다(에러 연결이 hint 연결을 대체·소거하지 않음).

**부수(내부)**: US: N/A — 하드코딩 한국어 hint 리터럴 3건(2건은 동일 문구 사본)을 ko.ts 키 2종으로 이동(ADR-0035 정합, 시각·와이어 0-diff). US2·US3의 테스트 오라클이 이 키들을 참조하므로 US를 실질 지탱한다(단순 creep 아님).

## 1. 배경 — 결함 클래스

`Field` 프리미티브는 `hint` prop을 시각적으로만 렌더한다(`<p className="mt-1 text-xs text-slate-500">{hint}</p>` — id 없음). timeout-knob-ui에서 ScheduleForm은 caller-렌더 `<p id={connectHintId}>` + `aria-describedby` 상시 연결로 구현됐지만, RunDialog는 `Field` 경유라 hint에 도달할 id가 없어 `aria-describedby`가 invalid 시 에러만 가리킨다 → SR이 hint를 읽지 않는 비대칭.

**결함 사이트 전수** — 두 층위로 나눠 센다. ① `Field` hint prop 클래스(§8 C1·C2로 확정 — 소비처 2파일, hint 사용 3곳 = #1~#3), ② 같은 *사용자 결함*(시각 렌더·SR 무음 hint)의 caller-렌더 변종(spec 리뷰 F2 적발 — #4 스코프 인, think hint 1건은 §6 사유와 함께 스코프 아웃):

| # | 위치 | hint 원천 | error 요소 id | 경로 |
|---|---|---|---|---|
| 1 | `RunDialog.tsx:942-958` connect timeout | `ko.loadModel.connectTimeoutHint` | `connect-timeout-error` | Field |
| 2 | `RunDialog.tsx:962-977` 루프 집계 상한 | 인라인 하드코딩 `"0 = 끄기 · 루프 스텝의 loop_index별 집계 상한"` | `loop-cap-error` | Field |
| 3 | `LoadModelFields.tsx:667-684` max in-flight | 인라인 하드코딩 `"동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"` | `max-in-flight-error` | Field |
| 4 | `ScheduleForm.tsx:404-406` 루프 집계 상한 | 인라인 하드코딩(#2와 **동일 문구** — 3번째 사본) | (없음 — ScheduleForm은 인라인 에러 `<p>` 대신 제출 차단 사유 목록) | caller-렌더 `<span>` (id·describedby 없음, 입력 `:398`의 `aria-label`이 label 텍스트를 accname에서 덮어 SR 완전 무음) |

#3은 `LoadModelFields`가 RunDialog·ScheduleForm 양쪽에 마운트되므로 fix가 양 폼에 자동 적용된다. #4를 빼면 "루프 집계 상한이 RunDialog에선 낭독·ScheduleForm에선 무음"이라는 새 비대칭이 생기므로 스코프 인.

## 2. 설계

### 2.1 `Field` 프리미티브 — `hintId` additive optional prop

`ui/src/components/ui/Field.tsx`:

```tsx
hintId?: string;   // props에 추가 (errorId와 대칭)
…
{hint != null && (
  <p id={hintId} className="mt-1 text-xs text-slate-500">
    {hint}
  </p>
)}
```

- 미전달 시 `id={undefined}` → React가 속성 자체를 생략 → 기존 소비처(hint 있는 3곳 포함, hintId 미배선 상태) DOM byte-identical.
- `errorId` prop과 정확히 대칭(같은 파일 선례). caller가 id를 소유하고 `aria-describedby`를 직접 배선하는 계약 — Field는 children을 불투명하게 받으므로 자동 주입 불가(§5 기각 대안 ①).
- **계약 노트(코드 주석으로)**: `hintId`를 `aria-describedby`에 참조하는 caller는 `hint`를 무조건 렌더할 것(조건부 hint + 상시 참조 = dangling reference). 이번 3곳은 모두 hint 무조건 렌더.

### 2.2 Field 사이트 3곳 배선 — 공통 패턴

각 사이트에 `useId()` 하나 추가(RunDialog는 기존 `connectTimeoutId` 옆에 2개, LoadModelFields는 `ids` 객체(`LoadModelFields.tsx:118`)에 `maxInFlightHint` 키 추가), `Field`에 `hintId` 전달, Input의 `aria-describedby`를:

```tsx
aria-describedby={invalid ? `<error-id> ${hintId}` : hintId}
```

- **invalid 시 에러 먼저**: 낭독 순서 = describedby id 순서. 문제(에러)를 먼저 듣고 제약(hint)이 이어진다. hint가 소거되지 않는 것이 US3.
- 유효 시에도 hint 상시 연결(ScheduleForm `:381`과 동일 거동).
- 불변인 것: `aria-invalid` 로직·에러 `<p>` 렌더 조건·에러 요소의 **id 리터럴**. **변하는 것: `aria-describedby` 속성 값** — 유효 시 `undefined` → `hintId`, invalid 시 `"<error-id>"` → `` `<error-id> ${hintId}` ``. 이 값을 완전일치로 단언하는 기존 테스트 1건(`RunDialog.test.tsx:1329`, §8 C8로 유일성 확정)은 §3⑦로 갱신한다.

### 2.2b ScheduleForm 루프 집계 상한 (#4) 배선

`ScheduleForm.tsx`에 `loopCapHintId = useId()` 추가(기존 `connectHintId :106` 옆), hint `<span>`(`:404-406`)에 `id={loopCapHintId}` 부여, 입력(`<Input` `:394-403`)에 `aria-describedby={loopCapHintId}` 추가(상시 — 같은 폼 connect timeout `:381`과 동일 거동. ScheduleForm은 인라인 에러 `<p>`가 없어 에러 병합 불요). 문구는 §2.3의 `ko.loadModel.loopCapHint` 참조로 교체. `aria-label`(`:398`)·`<label>` 구조·시각 렌더는 불변.

### 2.3 ko.ts 정리 (부수, ADR-0035)

`ko.loadModel`에 신설(현 리터럴 문구 **그대로** — 카피 변경 0):

- `loopCapHint: "0 = 끄기 · 루프 스텝의 loop_index별 집계 상한"`
- `maxInFlightHint: "동시 요청 상한 — 서비스가 목표 속도를 못 따라가면 초과분은 drop되어 리포트에 표시됩니다"`

인라인 리터럴 **3건**(RunDialog:965 · LoadModelFields:671 · ScheduleForm:405 — #4 스코프 인으로 `loopCapHint` 사본 2개가 한 키로 수렴)을 키 참조로 교체. **양방향 부분문자열 충돌 주의**(thinkboard-defaults 함정): `maxInFlightHint`는 기존 `ko.loadModel.maxInFlight`("동시 요청 상한")를 **접두사로 포함**한다 — 이 두 문구를 한 화면에서 substring 매처(`getByText`/`toHaveTextContent` 비정규식)로 단언하는 테스트는 전체일치로 써야 한다. `toHaveAccessibleDescription`이 안전한 이유는 요소-스코프가 아니라 **완전일치 비교**이기 때문(jest-dom 구현이 `this.equals(actual, expected)` — `toHaveTextContent`의 `includes`와 다름). plan에 충돌 전수 grep 명령 포함(§8 C6).

## 3. 테스트 계획

- **`Field.test.tsx`** (단위): ① `hintId` 전달 → hint `<p>`가 그 id를 가짐 ② 미전달 → hint `<p>`에 `id` 속성 부재(`not.toHaveAttribute("id")` — byte-identical 가드).
- **`RunDialog.test.tsx`**: connect·loopCap 입력은 상세 모드 + 판정·고급 펼침을 **둘 다** 통과해야 DOM에 존재 — 케이스 선두 2스텝은 기존 선례 그대로: `await toDetailed(user);` + `await user.click(screen.getByRole("button", { name: /판정·고급/ }));`(`RunDialog.test.tsx:3364-3365`). ③ connect 입력 `toHaveAccessibleDescription(ko.loadModel.connectTimeoutHint)`(US1 — 선례 `ScheduleForm.test.tsx:320`과 동일 matcher) ④ loopCap 입력(`hasLoop`은 RunDialog **prop**(`RunDialog.tsx:60`) — 테스트는 `hasLoop={true}` 전달로 게이트 통과, 시나리오 fixture 불요) `toHaveAccessibleDescription(ko.loadModel.loopCapHint)`(US2) ⑤ invalid connect(예: connect=60, http=30) → **순서 고정 전체일치 1건으로 확정**: ``toHaveAccessibleDescription(`${ko.validation.connectTimeout} ${ko.loadModel.connectTimeoutHint}`)``(US3 — 에러-먼저 순서까지 핀; `stringContaining` 2건 방식은 순서를 고정하지 못해 기각).
- **`LoadModelFields.test.tsx` + `ScheduleForm.test.tsx` 둘 다**: ⑥a LoadModelFields 직접 렌더(open-loop) maxInFlight 입력 `toHaveAccessibleDescription(ko.loadModel.maxInFlightHint)`(수정 지점 단위 증명) ⑥b ScheduleForm(open-loop 모드) 같은 단언(폼 통합 증명 — RunDialog 쪽 통합은 ③~⑤가 이미 커버) ⑥c ScheduleForm 루프 집계 상한 입력 `toHaveAccessibleDescription(ko.loadModel.loopCapHint)`(#4, US2). **⑥c만 fixture 비용이 다르다**: ScheduleForm의 `hasLoop`은 RunDialog(④)처럼 prop이 아니라 **fetch 파생**(`ScheduleForm.tsx:70` — `useScenario(:63)` 응답 yaml을 `parseScenarioDoc`해 loop 스텝 유무 판정)이고, 기존 `ScheduleForm.test.tsx:15-23`의 전역 fetch stub은 모든 요청에 `{scenarios: []}`를 줘 `hasLoop=false` → 입력이 DOM에 없다. ⑥c는 (scenario_id 세팅 + `getScenario` 응답 stub(`ScenarioSchema` 전 필드 필수) + 유효 ULID loop 스텝 YAML fixture + `findByLabelText`/`waitFor` async 대기) 한 세트가 필요 — 실패는 loud(라벨 not-found)라 공허 위험은 없지만 이 예산을 plan이 책정해야 구현자가 ⑥c를 드롭하지 않는다(#4의 유일한 테스트).
- ⑦ **기존 단언 갱신**: `RunDialog.test.tsx:1329`의 `toHaveAttribute("aria-describedby", "max-in-flight-error")`는 §2.2 적용 시 반드시 RED — `toContain`/정규식으로 풀면 "에러 id가 먼저" 이빨이 사라지므로([[plan-mandated-vacuous-tests]] 클래스), hint 요소의 실제 id를 DOM에서 resolve해 **완전일치** 유지: ``expect(maxInFlightInput).toHaveAttribute("aria-describedby", `max-in-flight-error ${hintEl.id}`)``(hintEl = `getByText(ko.loadModel.maxInFlightHint)`).
- **이빨 실증**(구현 task에서): hintId 배선(Field 전달 또는 describedby)을 고의 제거 → ③~⑥ RED → 원복 GREEN. ①은 prop 추가 자체가 대상이라 신규 기능 RED-first로 충분.
- 접근성 계산 주의: `toHaveAccessibleDescription`은 describedby 참조 요소들의 텍스트를 **공백으로 연결**한 값을 **완전일치** 비교(§2.3) — invalid 케이스(⑤)의 기대값은 `"에러문구 힌트문구"` 순서(§2.2 에러-먼저)로 조립.

## 4. 라이브 검증 (가볍게)

UI-only·payload 0-diff이지만 aria 계산은 실 브라우저 검증 가치가 있다(jsdom accname 계산과 브라우저가 다를 수 있는 클래스): Playwright로 ① RunDialog connect 입력의 accessible description 실측(스냅샷 또는 `browser_evaluate`로 `aria-describedby` resolve) ② **이 슬라이스가 ScheduleForm에서 실제로 바꾸는 표면** = 동시 요청 상한(open-loop)·루프 집계 상한(#4) describedby 실측([[live-verify-all-mount-paths]] — ScheduleForm connect는 무변경 표면이라 A/B 기준점으로만) ③ invalid 상태에서 에러+hint 공존. **selector 주의**: React `useId`는 `:r7:` 형태라 `document.querySelector("#"+id)`가 SyntaxError — `document.getElementById(id)`(또는 `[id="…"]`)로 resolve. run 생성/엔진 경로 무접촉이라 full live-verify 스택 불요 — vite dev 또는 `--ui-dir` 정적 서빙으로 충분.

## 5. 기각한 대안

1. **Field 내부 `useId` + `cloneElement`로 자식 input에 `aria-describedby` 자동 주입** — 자식이 단일 input이 아닐 수 있고(`children: ReactNode` 불투명), 기존 describedby(에러 병합 로직)를 clobber, 비-additive라 기각.
2. **ScheduleForm처럼 Field 밖 caller-렌더 `<p id>`로 우회** — 프리미티브 이원화·마크업 중복. 오히려 장기적으로는 ScheduleForm이 Field로 수렴하는 방향이 맞다(이번 범위 밖).

## 6. 비목표

- `Section`(`variant="card"` 포함 — 구 InspectorSection은 흡수돼 현존하지 않음)·`ConfirmDialog`의 `hint`(접힘 카운트 힌트 등) — 다른 컴포넌트·다른 UX 의미(disclosure 상태 표시)라 범위 밖.
- **`RunDialog.tsx:922` think hint(`"min=max면 고정 지연"`)** — 같은 무음 클래스지만 스코프 아웃: think-time-error와 **삼항 배타 렌더**(invalid면 에러 `<p>`, 유효면 hint `<p>`)라 §2.1 계약("hintId 참조 시 hint 무조건 렌더")에 정면으로 걸리고, 조건부 describedby 전환 설계가 별도로 필요하다. 잔여 결함으로 명시적으로 남긴다(후속 후보 — roadmap 연기 항목에 기록).
- ScheduleForm의 caller-렌더 hint 마크업을 `Field` 프리미티브로 수렴하는 **구조 리팩터** — #4는 3줄 배선(id+describedby)으로 SR 결함만 고치고, 마크업 수렴은 별도 슬라이스(이번 범위는 a11y 결함 해소).
- hint 카피 변경 — 문구는 byte-그대로 이동만.

## 7. 완료 기준 (DoD)

- 게이트: `cd ui && pnpm lint && pnpm test && pnpm build` 전부 green — **변경-후 상태 기준**. baseline도 green이지만 §2.2 적용은 기존 완전일치 단언 1건(`RunDialog.test.tsx:1329`)을 반드시 RED로 만들므로 ⑦ 갱신이 같은 task에 포함되어야 게이트가 닫힌다(단언 갱신 없이 green 불가 — 이 인과를 DoD에 명시).
- 4입력(connect·RunDialog loopCap·maxInFlight·ScheduleForm loopCap) 모두 유효 상태에서 hint가 accessible description으로 계산됨(테스트 ③④⑥a~c + 라이브 §4).
- invalid 상태에서 에러∧hint 공존(테스트 ⑤ + 라이브 §4-③).
- `git diff`에 `crates/`·payload 빌더(`buildProfile`/`profileForm`) 0-diff.
- 하드코딩 한국어 hint 리터럴 3건이 ko.ts 경유로 이동, `ui/src/components/{RunDialog,LoadModelFields,ScheduleForm}.tsx`에서 해당 리터럴 grep 0건.

## 8. Claims ledger (사실 주장 → 생성 명령)

| # | 주장 | 명령 | 결과 (2026-08-03, worktree rundialog-hint-sr) |
|---|---|---|---|
| C1 | `Field` 프리미티브 import는 비테스트 2파일뿐(배럴 없음) | `grep -rln 'from "[^"]*ui/Field"\|from "./Field"' ui/src --include="*.tsx" \| grep -v __tests__` + `ls ui/src/components/ui/index.ts` | `RunDialog.tsx`·`LoadModelFields.tsx` 2건 / no barrel |
| C2 | `Field`의 `hint=` 사용은 3곳(RunDialog:945·965, LoadModelFields:671) | `grep -rn 'hint=' ui/src --include="*.tsx" \| grep -v __tests__` 후 각 사이트의 감싸는 컴포넌트를 열어 판별(`<Field` vs `<Section`(`variant="card"` 포함)/`<ConfirmDialog`) | Field 3곳 / Section·ConfirmDialog 사이트는 범위 밖(disclosure 카운트 힌트 등 — §6). 이 grep은 *prop 이름* 기준이라 caller-렌더 무prop hint(#4·§6 think hint)는 별도 층위(②)로 셈 |
| C3 | hint `<p>`에 id 없음·`errorId` prop 선례 존재 | `Field.tsx` 전문 Read (`wc -l` = 40줄) | `:32` hint 무id, `:11`/`:20`/`:34` errorId |
| C4 | ScheduleForm은 connect hint를 상시 `aria-describedby` 연결 | `grep -n "connect\|hint\|describedby" ui/src/components/ScheduleForm.tsx` | `:106` useId, `:381` describedby, `:384` `<p id>` |
| C5 | `toHaveAccessibleDescription` 가용 + 동일 용도 선례 | `grep -n '"@testing-library/jest-dom"' ui/package.json` + `grep -rn "toHaveAccessibleDescription" ui/src` | jest-dom `^6.6.3` / `ScheduleForm.test.tsx:320` |
| C6 | 신규 ko 키 2종 부재·`maxInFlightHint` 문구가 기존 `maxInFlight` 라벨을 접두사 포함 | `grep -c "loopCapHint\|maxInFlightHint" ui/src/i18n/ko.ts` / 문구 육안 대조(§2.3) — **plan에서 신규↔기존 양방향 전수 충돌 grep 재실행** | 0건 / 포함 확인 |
| C7 | 에러 `<p>` id 3종 실존 | RunDialog `:981`/`:987`/`:993` Read·`grep -n "max-in-flight-error" ui/src/components/LoadModelFields.tsx` | `loop-cap-error`·`http-timeout-error`·`connect-timeout-error`·`max-in-flight-error`(`:687`) |
| C8 | `aria-describedby` **속성 값**을 완전일치 단언하는 기존 테스트는 이번 변경 표면에서 1건뿐 | `grep -rn "aria-describedby" ui/src --include="*.test.tsx"` (경계 없는 전수 — spec 리뷰어 재실행, 총 24 hits/5파일) | `RunDialog.test.tsx:1329`(max-in-flight — **영향**), `:1170/:1182/:1186`(think-time — 무접촉), `:1316`(target-rps — 무접촉), `ScheduleForm.test.tsx:312`(hint-only 값이라 불변). 나머지 hits = GenVarEditor·ScenarioImportPage(무접촉) + `Field.test.tsx:38,43`(이 슬라이스가 편집하는 파일이지만 해당 케이스는 hint/hintId 없이 자체 리터럴 `"t-err"` errorId만 배선 — 무접촉) |
| C9 | ScheduleForm 루프 집계 상한 hint는 무연결 `<span>`·입력은 `aria-label` 보유(SR 무음) + 같은 문구 3번째 사본 | `sed -n 390,408p ui/src/components/ScheduleForm.tsx`(구조) + **부재 주장은 전수로**: `grep -n "aria-describedby" ui/src/components/ScheduleForm.tsx` | `:398` aria-label, `:404-406` id·describedby 없는 span(describedby는 파일 전체에서 `:381` connect 1건뿐), 문구 = RunDialog:965와 동일 |
