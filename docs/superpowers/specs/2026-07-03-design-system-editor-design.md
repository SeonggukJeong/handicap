# 디자인 시스템 확산 3차 — 에디터/Inspector 토큰 이주 (설계) (§B12)

- **날짜**: 2026-07-03
- **상태**: 설계 — spec-plan-reviewer 검토 대기. plan = `docs/superpowers/plans/2026-07-03-design-system-editor.md`(작성 예정)
- **출처**: 사용자 요청 (roadmap §B12 "나머지 화면 토큰 이주 — 에디터/Inspector 화면군"). C-2(`2026-06-27-rundialog-design-system-design.md`)가 토대(프리미티브 6종 + accent 토큰)를 세우고, design-system-spread(폼 4화면)·design-system-results-screens(결과·표시 8화면)가 확산했다. 두 슬라이스가 공통으로 **연기**한 마지막 표면 = `scenario/` 에디터 디렉토리(입력 집약·dnd-kit/Monaco/Zustand 고위험). 이 슬라이스가 그걸 실행한다.
- **연관**:
  - **토대(이번 슬라이스가 *확장*)**: `ui/src/components/ui/Input.tsx`·`Select.tsx`에 `size?: 'sm'` additive prop 추가. `Callout.tsx`·`Field.tsx`·`Badge.tsx`·`Section.tsx`·`Segmented.tsx`·`tailwind.config.ts`·`Button.tsx` = **0-diff**(소비만).
  - **이주 대상(JSX 재구성)**: `ui/src/components/scenario/`(Inspector·KeyValueGrid·InsertTemplateModal·SaveTemplateDialog·TestRunPanel·TestRunSection·ExtractConfirmRow·VariablesPanel·ValidationBanner) + 에디터 페이지(`ScenarioEditPage`·`ScenarioNewPage`).
  - 문구: `ui/src/i18n/ko.ts`(ADR-0035) — 신규 인라인 문자열 0이 원칙.
- **ADR**: **신규 없음.** ADR-0043("UI 디자인 시스템 점진 채택")의 *실행*이다. `Input`/`Select`의 `size` 변형 추가도 **additive 프리미티브 기능**(기본 무변경 = 기존 소비처 byte-identical)이라 ADR-0043 "점진 채택" 범위 안 — 새 아키텍처 결정이 아니다. roadmap §B12 완료 항목 이동·새 연기 적재만.

## 범위 결정 (사용자, 2026-07-03)

1. **단일 슬라이스로 에디터 전면 이주** (사용자 선택 — 범위 질문). 에디터 전 `<input>`/`<select>` → `Input`/`Select` + 블록 경고 박스·독립 오류/경고 문단 → `Callout`. 한 슬라이스·한 머지.
2. **조밀 입력 밀도 보존 = `Input`/`Select`에 `size='sm'` 변형 추가** (사용자 선택 — 밀도 질문, before/after 목업 검토 후 확정). 에디터는 `text-xs`+`font-mono`로 조밀한 코드형 입력(URL·헤더·조건·추출 경로 등)을 쓰는데, `Input` BASE가 `text-sm`을 강제하고 Tailwind가 `text-sm`을 `text-xs`보다 뒤에 emit해 className override가 무력 → **밀도를 지키려면 토대에 size 변형이 필요**(옵션 B[canon만 이주=패치워크]·C[text-sm 정규화=밀도 시각 회귀] 기각). 이 확장은 이번 프로그램에서 처음으로 프리미티브를 건드리지만, additive·기본 무변경이라 "토대 동결"의 위험 통제 정신을 유지한다.
3. **`Section` 프리미티브 전면 제외** (탐색 결과 구조적 결정, 질문 아님). 에디터 fieldset은 전부 카드형(`border … rounded p-3 min-w-0`)이거나 접이식 `InspectorSection`(카드형 + localStorage 영속)이라, `border-t` 디바이더 전용인 `Section`을 끼우면 카드 룩·`min-w-0` overflow 가드(canvas-fix)가 깨진다. → `Section` 소비 0.
4. **시각 회귀 방지 > 적용 깊이** (design-system-spread R6 / results-screens 정신). 프리미티브가 깨끗이 안 맞는 표면(데이터-viz 색·인라인-옆-입력 경고·카드 fieldset·로컬 `Field`·Button-accent 드리프트)은 **변환하지 않고 동결**.

---

## 1. 문제와 목표

에디터/Inspector(`scenario/`)는 앞선 두 확산 슬라이스가 폼·결과 화면을 통일한 뒤에도 **손수 만든 raw Tailwind 입력·경고 박스**가 그대로 남은 마지막 표면이다 — 같은 의미의 `<input>`이 화면마다 `border border-slate-300 rounded px-2 py-1 text-xs`처럼 손으로 반복되고(포커스 링·`aria-invalid` 없음), 경고 박스도 `rounded border-amber-300 bg-amber-50 p-3`과 Callout 캐넌이 미묘하게 다르다. 이 슬라이스는 **C-2가 만든 `Input`/`Select`/`Callout` 프리미티브를 에디터 입력·경고에 적용**해 룩·포커스·역할(role)·여백을 통일한다. 단, 에디터 특유의 조밀 밀도를 지키기 위해 `Input`/`Select`에 `size='sm'` 변형을 **딱 하나** 더한다.

- **목표**:
  1. `Input`/`Select`에 **additive `size?: 'sm'`** 추가(기본=현재 `text-sm`, `'sm'`=`text-xs`). 기존 소비처는 **byte-identical**.
  2. 에디터 전 text/number/search `<input>` → `Input`(또는 `Input size="sm"`), `<select>` → `Select`(또는 `size="sm"`). 조밀 입력이 인디고 포커스 링·`aria-invalid` 스타일을 획득하되 **밀도(글자 크기) 보존**.
  3. 블록-레벨 경고/오류 박스 + 독립 오류/경고 문단 → **`Callout`**(role·variant·문구 1:1 보존, 세부 패딩/색조는 캐넌 정규화).
  4. **동작 byte-identical** — 핸들러·onBlur-commit draft·react-query·도출·상태·combobox role·ref·전송 payload 0-diff. JSX 마크업만 교체.
  5. **데이터-식별 색·구조·Button-accent 드리프트 동결** — 억지 적용보다 명시적 비-적용.
- **비목표(연기)**: §7. `Section` 소비·카드 fieldset의 Section화·Button/링크 accent 드리프트(indigo/blue) 이주·데이터-식별 색 토큰화·InspectorSection의 Section화·success Callout variant·status Badge tone.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> UI-only 표시/구조 폴리시. 와이어/뮤테이션 계약 변경 없음(R11이 0-diff 불변식 소유) → `seam` 열은 비어 있고, 라이브 검증(R16)은 에디터 JSX 리팩터 회귀 방지용(경량 — 읽기/편집 표면, run-생성/report-파싱/Zod 경로 아님).

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `MUST` **토대 확장** — `Input.tsx`·`Select.tsx`에 `size?: 'sm'` additive optional prop 추가. 기본(미전달) = 현재 `text-sm`, `'sm'` = `text-xs`(font-size+line-height 동반). ⚠ **Props 타입은 반드시 `Omit<…HTMLAttributes, "size">`** — native HTML `size?: number`와 교집합하면 `(number\|undefined)&('sm'\|undefined)`=`never`로 collapse돼 `<Input size="sm">`가 `TS2322`로 `pnpm build`(`tsc -b`) 실패(리뷰 CRITICAL). native `size=` 소비처 0(`grep '<Input\b[^>]*size=' → 0`)이라 omit 안전. 구현은 BASE에서 `text-sm`을 size 매핑으로 분리(기본 경로는 현재와 렌더 클래스 집합 동등) | `Input`/`Select` Props에 `Omit<…,"size">`; `size='sm'` 렌더가 `text-xs` 보유·`text-sm` 부재; 기본 렌더 `text-sm` 보유 단언 | |
| R2 | `MUST`(불변식) **기본 size 렌더 클래스 집합 동등** — 기존 모든 소비처(RunDialog·폼 4화면·결과 8화면·ScheduleForm)가 `size` 미전달 → 렌더 클래스가 재구성 전과 **동등**(`text-sm` 유지, `text-xs` 없음). (엄밀히 "class-set-identical" — `text-sm` 토큰이 className 문자열 내 위치만 이동, CSS cascade는 순서 무관이라 시각/동작 동일; 기존 소비처 테스트가 전부 `toHaveClass`/`className.toContain`=집합 멤버십이라 무영향) | 기본 `<Input>`/`<Select>` 렌더 `toHaveClass("text-sm")`·`.not text-xs`; 기존 프리미티브·소비처 테스트 전부 통과 | |
| R3 | `MUST` 에디터 전 text/number/search `<input>` → `Input`, `<select>` → `Select`(§4 매핑). checkbox·radio·`<textarea>`·`type="file"`·Monaco는 정당 예외(R9) | 각 대상 파일 diff가 `Input`/`Select` 적용; §4 매핑 대조 | |
| R4 | `MUST` **이주 기계 규칙** — ① `text-xs` 입력/셀렉트 → `size="sm"`; canon(크기 미지정/`text-sm`) → 기본 ② `font-mono`는 `className`으로 append(BASE에 폰트 없음=안전) ③ 고정폭(`w-24`/`w-28`/`w-32`/`w-56`) → 래퍼 `<div className="w-NN">`(Input은 `block w-full`로 채움) ④ `flex-1 min-w-0` → 래퍼 `<div className="flex-1 min-w-0">` ⑤ **`min-w-0`은 마이그레이션된 `<Input className="min-w-0 …">`에도 유지**(래퍼 *와* 입력 양쪽) — `w-full` Input에 `min-w-0`은 무해(no-op)하고, 기존 4개 `toHaveClass("min-w-0")` 단언(Inspector.test:519/534/546·KeyValueGrid.test:94)이 입력 요소를 직접 검사하므로 R5 유지 ⑥ auto-width `<select>`는 `w-auto` 아니라 **`w-fit` 래퍼**(§4.1 — `w-auto`는 block 자식을 채워 full-width가 됨) | 각 이주 입력이 규칙대로: 조밀→`size="sm"`·mono→className·폭→래퍼·min-w-0 입력 유지·auto-select→`w-fit`(리뷰) | |
| R5 | `MUST`(불변식) **동작 byte-identical** — 핸들러·onBlur-commit draft·react-query·도출(`useMemo`/필터)·상태 round-trip·전송 payload가 재구성 전과 동일. JSX 마크업만 교체. 특히 verbatim 보존: `commitTimeout`/`commitThinkTime`(짝-입력 one-empty 가드)·`commitRepeat`·`commitFromBlur`(extract)·branch `commitName`·`StepNameField` 하이브리드 커밋·KeyValueGrid `commitRows`·**ScenarioEditPage `commitName`+`nameEscapedRef` Escape 트랩**. **기존 RTL 전부 통과** — 단 입력 요소 클래스를 직접 검사하는 단언은 R4⑤(min-w-0 입력 유지)로 green 유지(테스트 자체 수정 없음) | 각 파일 기존 RTL 통과(min-w-0 단언 4곳 포함); 커밋 로직 함수 0-diff(리뷰) | |
| R6 | `MUST` **블록 경고/오류 박스 + 독립 오류/경고 문단 → `Callout`**, **기존 `role` 1:1 보존**(없으면 안 만든다): `role="alert"`→`Callout role="alert"`·`role="status"`→`Callout role="status"`·roleless→role 미부여. variant = 빨강(`bg-red-*`/`text-red-*`) 오류→`error`·호박(`bg-amber-*`) 경고→`warn`. 세부 패딩/색조/모서리는 Callout 캐넌으로 정규화(`p-3`→`p-2`·`rounded`→`rounded-md`·`bg-amber-100`→`bg-amber-50`·`text-red-600/800`→`text-red-700` — 의도된 통일, 시각 1:1 *아님*) | 전환 박스/문단 role이 전환 전과 1:1 + variant 계열 일치 + 문구 보존; 기존 role RTL 통과 | |
| R7 | `MUST`(불변식·동결) **입력-옆 인라인 경고 유지** — 입력/행 안·옆에 붙은 인라인 경고(박스 아님)는 그대로: Inspector URL-empty `<p role="alert" text-amber-600>`·dup-branch `<span role="alert">`·invalid-regex `<span>`·JSON `<p text-red-600>`·MonacoYamlView "YAML invalid" 상태줄·BulkEditPanel skip 노트·TestRunSection 성공 emerald 상태. 박스화하면 레이아웃 시프트/시각 회귀 | 그 요소들 0-diff(grep); 인라인 경고 보존(리뷰) | |
| R8 | `MUST`(불변식·동결) **데이터-식별 색 동결(토큰화 금지)** — `methodBadge.ts` 팔레트(GET/POST/… 색)·FlowOutline accent-500 드래그/선택/드롭 어휘·TestFlowChips ✓/✗/○·method·violet branch 색·TestRunPanel status pill/verdict/if/branch/extract/unbound 칩 색·ResponseBodyTree 다크 트리 색 | 그 마크업 0-diff(grep) | |
| R9 | `MUST`(불변식·동결) **구조적 동결** — Inspector 로컬 `function Field`(암시적 label 래퍼, `htmlFor` 프리미티브 `Field`와 별물·이름 충돌 위험 → 손대지 않음)·`InspectorSection`(카드형 disclosure + localStorage → `Section` 부적격)·모든 카드형 fieldset(`border … rounded p-3 min-w-0`)·checkbox·radio·`<textarea>`·Monaco·dnd-kit 드래그 핸들·disclosure 토글·`type="file"` | 그 요소 0-diff(grep) | |
| R10 | `MUST`(불변식) **Button/링크 accent 드리프트 범위 밖** — 기존 indigo/blue 컨트롤 색(ExtractConfirmRow `bg-indigo-600`·ResponseBodyTree `bg-indigo-600` +추출 버튼·ConditionNode `border-indigo-200` 레일)은 **Button-accent 도메인**이라 이 Input/Select/Callout 슬라이스 범위 밖(별도 슬라이스로 연기, results-screens R11 선례). 이 슬라이스가 **신규** blue/indigo 컨트롤 색을 *추가*하지 않는다 | 만진 입력/박스에 신규 blue/indigo 0(diff 리뷰); 기존 드리프트는 §5 동결 목록에 명시 | |
| R11 | `MUST`(불변식) 백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·`scenario/model.ts`·`yamlDoc.ts`·`store.ts`·`reorder.ts`·`dropRules`·`tailwind.config.ts`·`Button.tsx`·`Callout/Field/Badge/Section/Segmented.tsx` **0-diff** — 순수 UI 표시/구조 | `git diff --name-only`에 그 경로 부재; diff는 `ui/src/components/{ui/Input,ui/Select,scenario/*}`·`ui/src/pages/Scenario{Edit,New}Page`·`ko.ts`·`docs`만 | |
| R12 | `MUST` **URL 입력 빈 값 허용 유지**(Inspector:326, U3) — 이주가 검증/`aria-invalid` 동작을 *추가*하지 않는다(`Input`의 `aria-[invalid=true]` 스타일은 `aria-invalid` 미설정이면 비활성 → 무변화) | URL 입력에 `aria-invalid`/`.min(1)` 신규 부재; `model.test.ts` 빈-URL 락인 통과 | |
| R13 | `SHOULD` **ScenarioEditPage 이름 입력 이주(플래그)** — `text-xl font-semibold`(Inspector 이름 아닌 페이지 헤더 rename)는 `text-xl`이 Tailwind 스케일상 `text-sm` 뒤라 className override가 이김 → `<Input className="text-xl font-semibold">`로 이주 가능. **단 `commitName`+`nameEscapedRef` Escape 트랩(scenario-delete-name-sync) verbatim 보존 필수.** ⚠ 이주는 `text-xl`뿐 아니라 **`block w-full`(auto→full-width)·`rounded-md`·accent 포커스 링**도 얹는다 — full-width rename 필드가 헤더 레이아웃에 어색하면 **동결로 후퇴**(이 한 입력만). 라이브검증에서 폭/룩 실측 후 결정 | 이름 입력 `Input` 적용·`text-xl` 렌더 유지·Escape-ref 보존·full-width 룩 수용가능; `ScenarioEditPage.name.test` 통과 (또는 동결 근거 기록) | |
| R14 | `MUST` 신규/변경 사용자-노출 문구는 `ko.ts` 경유(ADR-0035) — **신규 인라인 문자열 0**이 원칙(기존 ko 키 그대로 유지). `Callout title=`을 *새로* 다는 경우만 ko 재사용/추가. `aria-label`도 ko 경유 | 만진 파일 인라인 영어 0·신규 노출 텍스트 ko 참조(grep) | |
| R15 | `MUST` 라벨↔컨트롤 연결·셀렉터 lockstep — `Input`은 `list`/`ref`/`aria-label`/`placeholder`/`type`을 `{...rest}`+forwardRef로 패스스루(KeyValueGrid key `list=` → combobox role 보존·value `ref` 보존); `Callout`은 `role`/children/`aria-label` 패스스루. 기존 `getByRole`/`getByLabelText`/`getByText`/combobox∪textbox 셀렉터 통과 | 기존 combobox/textbox/role/label 셀렉터 통과 | |
| R16 | `MUST` 라이브 검증(경량) — 에디터는 run-생성/report-파싱/Zod 경로가 **아니라**(읽기/편집) S-D Zod 갭 비해당. `/scenarios/new` 에디터에서 console 에러 0·입력 포커스 링(accent)·KeyValueGrid combobox·dnd-kit 드래그·YAML/스텝 편집 모달 스모크 | `/live-verify`(워크트리 자체 바이너리 + Playwright) 또는 plan에서 근거와 함께 축소 | ✅(편집 화면) |

- **seam**: 와이어/뮤테이션 계약 변경 없음 — R5·R11이 "0-diff/byte-identical" 불변식을 명시 소유.

---

## 3. 핵심 통찰 (설계 근거)

1. **확산은 *적용*이지 *발명*이 아니다**(R3·R6). C-2가 프리미티브를, 앞 두 슬라이스가 적용 패턴(폼·결과)을 확립했다. 이 슬라이스는 그 패턴을 에디터에 소비할 뿐 — 유일한 *발명*은 size 변형 하나(R1), 그마저 additive.
2. **에디터는 폼·결과보다 위험하다 — 그래서 규칙이 더 엄격하다**(R5). design-system-spread(뮤테이션 폼)·results-screens(읽기 표시)와 달리 에디터는 **입력 집약 + onBlur-commit draft + dnd-kit/Monaco/Zustand 양방향 sync**다. 그래서 R5가 커밋 핸들러·combobox role·ref·Escape 트랩을 verbatim 보존으로 못 박고, 마크업만 교체한다. 기존 RTL(거의 전 파일 커버)이 회귀 가드.
3. **`Input` BASE의 `text-sm` 강제가 size 변형을 필연으로 만든다**(R1). Tailwind가 `text-sm`을 `text-xs`보다 뒤에 emit(스케일 순서 xs→sm→base…)해 `<Input className="text-xs">`가 무력 → 에디터 조밀 밀도를 지키는 유일한 길이 프리미티브 size 변형. before/after 목업이 옵션 A(size 변형)를 확정(B=패치워크·C=밀도 회귀 기각).
4. **`font-mono`는 안전, `text-xs`만 위험**(R4). BASE에 폰트-family가 없어 `font-mono` append는 무충돌. 폭(`w-24` 등)은 래퍼 div로 흡수(`Input`=`block w-full`). 유일한 충돌은 폰트-*크기*(text-xs↔text-sm)뿐이고 그게 size 변형으로 해결된다.
5. **`Section`·카드 fieldset은 구조적으로 부적격**(R9). 에디터 fieldset은 카드형(`border rounded p-3 min-w-0`) — `Section`(`border-t` 디바이더 전용, `min-w-0` 없음)으로 바꾸면 카드 룩·overflow 가드가 깨진다(canvas-fix). 접이식 `InspectorSection`은 `Section`의 `collapsible` API *모양*과 닮았지만 카드 비주얼 + localStorage라 부적격. → `Section` 소비 0, 이 슬라이스는 Input/Select/Callout 3종만.
6. **`Callout`의 `role`은 호출자 지정 — 프리미티브가 강제 안 함**(R6). blocking 오류=`alert`·비차단 advisory=`status`·roleless 경고=role 없음. 기존 role 1:1 보존해야 a11y·셀렉터 byte-identical(C-2 Callout role 함정). ValidationBanner warn 색(`border-amber-300 bg-amber-50 text-amber-800`)은 Callout `warn` variant와 정확 일치 → children 중첩으로 통째 교체.
7. **변환 경계 = "블록 박스/독립 문단"만, "입력-옆 인라인 경고"는 유지**(R6·R7). 빨강/호박 박스(ValidationBanner·SaveTemplate 확인·TestRunPanel 상한)·독립 오류/경고 문단(페이지 로드/뮤테이션 오류·모달 role=alert)은 Callout로 통일하되, **입력/행 안에 붙은 인라인 경고**(URL-empty·dup-branch·invalid-regex·JSON·Monaco status)는 유지 — 박스화가 레이아웃 시프트/시각 회귀이기 때문. 이 경계가 "통일(좋음)"과 "회귀(나쁨)"를 가른다. cross-file 일관성은 whole-branch 리뷰가 담보(design-system-spread가 화면별 매핑에서 놓친 트랩).
8. **드롭인이 a11y를 *공짜로* 올린다**(R15). raw 에디터 `<input>`엔 포커스 링·`aria-invalid`가 없지만 `Input`은 토큰화된 accent 포커스 링·invalid 빨강 링을 BASE로 갖는다. 조밀 입력도 size 변형 덕에 밀도를 지킨 채 그 이득을 받는다(URL 빈 값 예외 R12는 aria-invalid 미설정이라 무해).
9. **파일별 단계 = subagent-driven 자연 매핑**(§8). 각 파일이 독립 green 커밋이고, 파일 경계가 리뷰·롤백 단위. 토대(R1/R2)를 첫 task로 세운 뒤 소비 파일들이 그 위에서 이주.

---

## 4. 변경 상세 (파일별)

> 각 항목에 **충족 R** 태그. 전부 `ui/src`·`ko.ts`·`docs/` 범위. **file:line은 탐색 시점(2026-07-03) 기준 — 구현 시 재확인**(입력이 많아 라인 드리프트 가능; 규칙[R4/R6/R7]이 라인보다 권위).

### 4.0 토대 — `ui/src/components/ui/Input.tsx`·`Select.tsx` — 충족 R: `R1,R2`
- **Props 타입은 `Omit<…HTMLAttributes, "size">`** (CRITICAL — R1): 현재 `InputHTMLAttributes<HTMLInputElement> & { numeric?: boolean }`에 `& { size?: 'sm' }`를 그냥 더하면 native `size?: number`와 교집합 → `never`로 collapse → `<Input size="sm">`가 `TS2322`로 `pnpm build` 실패. 반드시 `type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { numeric?: boolean; size?: 'sm' }`. Select도 `Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: 'sm' }`. native `size=` 소비처 0이라 omit 무해.
- `size?: 'sm'` 구현: 현재 BASE의 `text-sm`을 size 매핑으로 분리: 예 `const SIZE = { md: "text-sm", sm: "text-xs" } as const;` + BASE에서 `text-sm` 제거 후 `${BASE} ${SIZE[size ?? "md"]} ${numeric?…}` 조립(`size` 미전달 기본 → 렌더 클래스 집합이 현재와 동등). `numeric`(tabular-nums)·forwardRef·`{...rest}` 패스스루 무변경.
- `Select`도 동형(`Select`엔 `aria-invalid` 스타일 없음 — 그대로).
- 락인 테스트(`ui/src/components/ui/__tests__/Input.test.tsx` — Select도 커버): 기본 `<Input>`/`<Select>` `toHaveClass("text-sm")`·`.not.toHaveClass("text-xs")`; `size="sm"` 반대. 기존 소비처 테스트는 전부 집합-멤버십(`toHaveClass`/`className.toContain`)이라 무영향(R2).

### 4.1 Inspector.tsx (HEAVY) — 충족 R: `R3,R4,R5,R7,R8,R9,R11,R12,R15`
- **입력 → Input**: URL(`:326` `font-mono text-xs w-full` → `Input size="sm" className="font-mono"`, **R12 빈 값 허용·검증 무추가**)·timeout(`:363` number w-full → `Input numeric` 기본, onBlur `commitTimeout` 보존)·thinkMin/Max(`:375`/`:386` number w-full → `Input numeric` 기본, `commitThinkTime` 짝-가드 보존)·assert code 기존행(`:613` `w-24` → 래퍼 `w-24`+`Input numeric`)·assert 신규(`:647` `w-24 text-xs` → 래퍼+`Input numeric size="sm"`)·extract var(`:755` `font-mono w-24` → 래퍼+`Input size?` mono, `commitFromBlur` 보존)·extract body path(`:774` `font-mono flex-1 min-w-[120px]` → 래퍼 `flex-1 min-w-[120px]`+`Input className="font-mono"`)·extract header/cookie name(`:783` 동형)·parallel branch name(`:880` `w-full text-xs` in `flex-1 min-w-0` → `Input size="sm"`, `commitName` 보존)·loop repeat(`:1032` `w-24` number → 래퍼+`Input numeric`, `commitRepeat` 보존)·cond left(`:1234` `font-mono text-xs w-28 min-w-0` → 래퍼 `w-28 min-w-0`+`Input size="sm" className="font-mono"`, `commitText` 보존)·cond right(`:1262` 동형).
- **셀렉트 → Select** (auto-width는 **`w-fit` 래퍼**로 compact 유지 — `w-auto`는 block 자식을 채워 full-width가 됨, R4⑥): method(`:311` auto-width → `<div className="w-fit"><Select></div>`)·body kind(`:470` `text-sm mb-2` auto-width → `<div className="w-fit"><Select className="mb-2"></div>` — **§4.1의 다른 auto-width select와 동일하게 w-fit**(초안의 full-width 이주는 폭 불일치 = 정정))·extract from(`:762` auto-width → `w-fit` 래퍼+`Select`)·cond group all/any(`:1169` `text-xs w-32` 고정폭 → `w-32` 래퍼+`Select size="sm"`)·cond op(`:1242` `text-xs` auto-width → `w-fit` 래퍼+`Select size="sm"`). (`w-fit`=Tailwind 3 `width:fit-content` — 구현 시 config 지원 확인, 미지원이면 래퍼 `inline-block` 폴백.)
- **StepNameField**(`:1445` `w-full` → `Input` 기본, 하이브리드 커밋[onChange non-empty + onBlur "Untitled"] verbatim, R12 아님 — 이름은 Untitled 폴백 있음).
- **동결(R7)**: 인라인 경고 `:334`(URL-empty)·`:900`(dup-branch)·`:1272`(invalid-regex)·`:554`(JSON 오류) 유지. **동결(R8/R9)**: 로컬 `Field`(`:1424`)·카드 fieldset(`:302`/`:1360`/`:1379`)·`InspectorSection`(`:169`)·`<textarea>`(`:537`/`:590`)·`SmallButton`·ConditionNode `border-indigo-200`(`:1168`, R10 범위밖).
- **테스트**: `Inspector.test.tsx`+`Inspector.sections.test.tsx`(섹션 disclosure·localStorage clear·`getByRole("button",{name:섹션제목})` 토글 커플링 — editor-space-qol 함정). 셀렉터 취약 — lockstep 주의.

### 4.2 KeyValueGrid.tsx (MEDIUM-HEAVY·RISKY) — 충족 R: `R3,R4,R5,R9,R11,R15`
- **입력**(전부 R4⑤ — `min-w-0`을 **입력 className에도 유지**; flex 아이템인 **래퍼에도 `min-w-0`**을 둬 원본 flex-shrink 충실도 보존): row key(`:208` `w-32 min-w-0 text-xs font-mono` + **`list=` combobox**) → 래퍼 `w-32 min-w-0`+`Input size="sm" className="min-w-0 font-mono" list={…}`(combobox role 보존, `commitRows` onBlur 보존)·row value(`:217` `flex-1 min-w-0 text-xs` + `ref`) → 래퍼 `flex-1 min-w-0`+`Input size="sm" className="min-w-0"` ref 패스스루·newKey(`:244` combobox 동형)·newValue(`:257` 동형).
- **동결**: enabled checkbox(`:201`)·CommonHeaderMenu listbox 팝오버·datalist.
- **RISK**: 모든 입력이 `flex-1`/`w-32`/`min-w-0` 레이아웃 + key는 combobox role → 래퍼로 폭 흡수 + 입력 `min-w-0` 유지(R4⑤ — 4곳 단언) + `list=` 패스스루로 role 유지. **combobox-union 회귀 가드는 `Inspector.test.tsx:530`**(`HeadersEditor`를 `commonKeys` 주입해 key 입력이 combobox role → `getAllByRole("combobox")∪getAllByRole("textbox")` 유니온; `KeyValueGrid.test.tsx:92`의 Harness는 `commonKeys` 미주입이라 key가 textbox role뿐 = combobox 가드 아님). `KeyValueGrid.test:94`는 `min-w-0` 단언(R4⑤). `Inspector.test`+`KeyValueGrid.test` 둘 다 lockstep.

### 4.3 InsertTemplateModal.tsx (MEDIUM) — 충족 R: `R3,R4,R5,R6,R7,R11,R15`
- **입력**: rename(`:306` `w-56 text-sm font-mono` + **`list=` combobox**) → 래퍼 `w-56`+`Input className="font-mono" list={…}`(canon size, combobox 보존, `aria-label` 보존)·literal(`:332` `w-56 text-sm`) → 래퍼 `w-56`+`Input`.
- **Callout(R6)**: `:136`/`:197`/`:205` `<p role="alert" text-red-600>` **독립** 오류 문단 → `Callout variant="error" role="alert"`.
- **동결·인라인 유지(R7)**: `:325` `<p role="alert" text-xs>{badRename}</p>`는 rename `<input>` **바로 아래 per-token 인라인 오류**(구조상 R7 invalid-regex `<span>`과 동류) → Callout 박스화하면 compact rename 행 레이아웃 시프트 → **인라인 유지**(R6 아님).
- **동결**: keep/rename/literal radios(`:280`/`:288`/`:296`)·datalists·`Button`/`Modal`. ParamForm fieldset(`:269` plain `min-w-0`, no border-t·legend `font-medium`) → Section 부적격, 동결.
- **테스트**: `InsertTemplateModal.test.tsx` lockstep.

### 4.4 SaveTemplateDialog.tsx (LIGHT-MEDIUM) — 충족 R: `R3,R4,R5,R6,R11`
- **입력**: name(`:111` `px-3 py-2 text-sm focus:ring-slate-400`) → `Input`(패딩 `px-3 py-2`→캐넌 `px-2 py-1`·포커스 slate→accent 정규화, `handleNameChange` 보존)·description(`:126` 동형).
- **Callout(R6)**: overwrite 확인(`:158` roleless amber 박스 `rounded-md bg-amber-50 px-3 py-2`) → `Callout variant="warn"`(roleless, `px-3 py-2`→`p-2`)·error(`:165` `<p role="alert" text-red-600>` 독립 문단) → `Callout variant="error" role="alert"`.
- **동결**: step checkboxes(`:141`)·fieldset(`:136` plain, Section 부적격)·`Button`/`Modal`.
- **테스트**: `SaveTemplateDialog.test.tsx` lockstep.

### 4.5 TestRunPanel.tsx (MEDIUM·대부분 동결) — 충족 R: `R6,R7,R8,R11`
- **Callout(R6·warn·roleless)**: BodyViewer truncated(`:63` `bg-amber-100 px-3 py-2`)·non-JSON/truncated extract 안내(`:189` `bg-amber-50 px-2 py-1`)·limit-reached(`:455` `bg-amber-100 px-3 py-2`) → `Callout variant="warn"`(roleless, `bg-amber-100`→`bg-amber-50` 정규화).
- **동결(R7)**: 인라인 red `{step.error}`(`:320`)·`{trace.error}`(`:453`). **동결(R8)**: statusClass pill(`:227`)·verdict 칩(`:446`)·method/loop-index/extracted/unbound/if/branch 칩 색(데이터 식별).
- **입력/셀렉트 0** — copy/format/wrap/tree 토글 버튼·`<pre>`·Modal·HeaderTable 동결.
- **테스트**: `TestRunPanel.test.tsx`+`.extract.test.tsx` lockstep.

### 4.6 TestRunSection.tsx (LIGHT) — 충족 R: `R3,R4,R5,R6,R7,R11`
- **입력**: maxRequests(`:67` `w-28 text-sm` number in `<label>` row) → 래퍼 `w-28`+`Input numeric`.
- **Callout(R6)**: error(`:89` `<p text-sm text-red-700>` 독립 문단) → `Callout variant="error"`(roleless — 기존 role 없음). **동결(R7)**: 성공 emerald 상태(`:105` `role="status" text-emerald-700`, 데이터-ish 인라인 유지).
- **동결**: applyThinkTime checkbox(`:77`)·card `<section>`(`:46`, Section 부적격).
- **테스트**: `TestRunSection.test.tsx`+페이지 `ScenarioEditPage.testrun`/`ScenarioNewPage.testrun`.

### 4.7 ExtractConfirmRow.tsx (LIGHT) — 충족 R: `R3,R4,R5,R10,R11`
- **입력**: varName(`:46` `w-32 px-1 py-0.5 font-mono`, onChange 즉시) → 래퍼 `w-32`+`Input className="font-mono"`(패딩 `px-1 py-0.5`→캐넌 `px-2 py-1`·`aria-label` 보존). 컴팩트 룩 필요 시 `size="sm"`은 폰트만 바꿔 패딩엔 무영향 — 패딩 정규화 수용(리뷰 판단).
- **동결(R10)**: 행 `bg-indigo-50`(`:44`)·confirm 버튼 `bg-indigo-600`(`:62`) = accent affordance(범위밖). **테스트**: 전용 없음(TestRunPanel.extract/ResponseBodyTree 간접 커버 → 이주 시 타깃 렌더 단언 추가, F1).

### 4.8 VariablesPanel.tsx (LIGHT) — 충족 R: `R3,R4,R5,R11`
- **입력**: newKey(`:71` `flex-1 min-w-0 text-sm font-mono`) → 래퍼 `flex-1 min-w-0`+`Input className="font-mono"`(canon size).
- **동결**: `AutoGrowTextarea`(`:53`, textarea). **테스트**: `VariablesPanel.test.tsx`(getSnapshot 핀 — 첫 마운트 민감, EMPTY_VARS 상수 함정).

### 4.9 ValidationBanner.tsx (LIGHT·통째 Callout) — 충족 R: `R6,R14,R11`
- **Callout(R6·warn·role=status)**: 배너 전체(`:22` `role="status" aria-label rounded border-amber-300 bg-amber-50 p-3 text-amber-800`) → `Callout variant="warn" role="status" aria-label={…}`. warn 색이 정확 일치 → title-row/클릭 행 리스트를 children으로 중첩(`p-3`→`p-2`·`rounded`→`rounded-md` 정규화). aria-label·role·클릭→스텝선택 동작 보존.
- **테스트**: `ValidationBanner.test.tsx` lockstep(`getByRole("status")` 통과).

### 4.10 ScenarioEditPage.tsx (LIGHT·에디터 chrome) — 충족 R: `R3,R5,R6,R13,R11`
- **입력(R13 플래그)**: name-rename(`:132` `text-xl font-semibold px-2 py-1`, onBlur `commitName`+`nameEscapedRef` Escape 트랩) → `Input className="text-xl font-semibold"`(text-xl override 이김·Escape-ref+commitName verbatim). 리스크 시 동결 후퇴.
- **Callout(R6)**: 로드 오류(`:63` roleless `<p text-red-600>` early-return) → `Callout variant="error"`(roleless)·update 오류(`:213` roleless) → `Callout variant="error"`·복제 오류(`:215` `<p role="alert">`) → `Callout variant="error" role="alert"`.
- **테스트**: `ScenarioEditPage.{clone,dirty,name,save,testrun}.test.tsx`(name 테스트 `:132` 고결합 — lockstep 주의).

### 4.11 ScenarioNewPage.tsx (TRIVIAL·에디터 chrome) — 충족 R: `R6,R11`
- **Callout(R6)**: 생성 오류(`:135` roleless `<p text-red-600>`) → `Callout variant="error"`(roleless). 템플릿 갤러리 버튼(`:80`) = plain 버튼, 범위밖.
- **테스트**: `ScenarioNewPage.{gallery,import,testrun}.test.tsx`.

### 4.12 ZERO 표면 (reviewed-no-change) — 충족 R: `R8,R9,R10`
- **MonacoYamlView**(Monaco + `:91` 인라인 "YAML invalid" 유지 R7)·**ResponseBodyTree**(`:67` `bg-indigo-600` 버튼 R10·다크 트리 R8)·**EditorShell**(레이아웃 그리드 + 토글 버튼)·**FlowOutline**(dnd-kit·METHOD_BADGE·accent-500 어휘 R8/R9)·**TestFlowChips**(✓/✗/○·method·violet 데이터 팔레트 R8)·**BulkEditPanel**(`<textarea>` R9·`:30` 인라인 skip 노트 R7)·**YamlFileActions**(`type="file"` R9·`:77` 인라인 role=alert 유지 R7 — 파일 액션 모달 인라인)·**VarCheatSheet**·**methodBadge.ts**(FROZEN 팔레트 단일 소스): 입력/셀렉트/블록 박스 없음 또는 전부 동결 → **변경 없음**.

### 4.13 문구 — `ui/src/i18n/ko.ts` — 충족 R: `R14`
- **신규 인라인 문자열 0.** Callout children·`aria-label`은 기존 ko 키/문구 그대로. `Callout title=`을 *새로* 다는 경우만 ko 재사용(이번엔 신규 title 불필요 예상 — 대부분 title 없는 문단/박스). dead-key 위생: 변환으로 미참조 ko 키 생기면 제거(role/children 보존이라 발생 안 함 예상).

---

## 5. 무변경 / 불변식 (명시)

- **토대(size 외 0-diff)**: `Callout`/`Field`/`Badge`/`Section`/`Segmented.tsx`·`tailwind.config.ts`·`Button.tsx` 0-diff. `Input`/`Select`는 **additive size prop만**(기본 렌더 byte-identical, R1/R2).
- **백엔드·proto·migration·`ui/src/api/*`·`schemas.ts`·`scenario/model.ts`·`yamlDoc.ts`·`store.ts`·`reorder.ts`·`dropRules`**: 0-diff(R11).
- **각 파일 로직**: 핸들러·onBlur-commit draft·react-query·도출·상태 round-trip·combobox role·ref·Escape 트랩 0-diff(R5) — 마크업만 교체.
- **데이터-식별 색**: `methodBadge.ts`·FlowOutline accent-500 어휘·TestFlowChips ✓/✗/○·method·violet·TestRunPanel status/verdict/if/branch/extract/unbound 칩·ResponseBodyTree 다크 색 0-diff(R8).
- **구조**: 로컬 `Field`·`InspectorSection`·카드 fieldset·checkbox/radio/textarea/Monaco/dnd-kit 핸들/disclosure/file 0-diff(R9). `Section` 소비 0.
- **입력-옆 인라인 경고**: URL-empty·dup-branch·invalid-regex·JSON·Monaco status·Bulk skip·TestRunSection 성공 emerald 0-diff(R7).
- **Button/링크 accent 드리프트(범위 밖·동결)**: ExtractConfirmRow `bg-indigo-600`·ResponseBodyTree `bg-indigo-600`·ConditionNode `border-indigo-200` 등은 Button-accent 도메인이라 이 슬라이스에서 손대지 않는다(R10 — 별도 슬라이스, §7). 신규 드리프트만 금지.
- **공유 컴포넌트 경계**: `EmptyState`·`Button`·`Modal`·`HelpTip`·`AutoGrowTextarea` 시그니처/동작 무변경.
- **정당 예외(프리미티브 비대상)**: checkbox·radio·`<textarea>`·`type="file"`·Monaco·dnd-kit 핸들·disclosure 토글·인라인-옆-입력 경고 — 구조 보존(R7/R9).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `Input`/`Select` diff에 size prop·`size='sm'` 렌더 `text-xs` 단언 | |
| R2 | 기본 `<Input>`/`<Select>` `toHaveClass("text-sm")`·`.not text-xs`; 기존 프리미티브·소비처 RTL 전부 통과 | |
| R3 | 각 대상 파일 diff에 `Input`/`Select` 적용(리뷰) + §4 매핑 대조 | |
| R4 | 조밀→`size="sm"`·mono→className·폭→래퍼·flex→래퍼(diff 리뷰) | |
| R5 | 각 파일 기존 RTL 전부 통과·커밋/핸들러 함수 0-diff(리뷰) | |
| R6 | 전환 박스/문단 role/variant 1:1 RTL(`getByRole("alert")`/`getByRole("status")`)·variant 색 매칭·문구 보존 | |
| R7 | 인라인 경고(URL-empty·dup-branch·invalid-regex·JSON·Monaco·Bulk·TestRunSection emerald) 0-diff(grep) | |
| R8 | methodBadge/FlowOutline accent-500/TestFlowChips/TestRunPanel 칩 색 0-diff(grep) | |
| R9 | 로컬 Field·InspectorSection·카드 fieldset·checkbox/radio/textarea/Monaco/dnd-kit/file 0-diff(grep) | |
| R10 | 만진 입력/박스에 신규 blue/indigo 0(grep); 기존 드리프트 §5 동결 목록 대조 | |
| R11 | `git diff --name-only`(ui/src/components/{ui/Input,ui/Select,scenario/*}·pages/Scenario{Edit,New}Page·ko.ts·docs만) | |
| R12 | URL 입력 신규 `aria-invalid`/`.min(1)` 부재(grep)·`model.test.ts` 빈-URL 락인 통과 | |
| R13 | 이름 입력 `Input`+`text-xl` 유지·Escape-ref 보존·`ScenarioEditPage.name.test` 통과(또는 동결 근거) | |
| R14 | 인라인 영어 0·신규 노출 텍스트 ko 참조(grep) | |
| R15 | 기존 combobox∪textbox/role/label 셀렉터 통과(KeyValueGrid F1 유니온 포함) | |
| R16 | `/live-verify`: `/scenarios/new` 에디터 console 0·포커스 링(accent)·combobox·dnd-kit 드래그·모달 스모크 | ✅ |

- **UI 게이트**: 각 파일 커밋마다 그 파일 + 의존 테스트 GREEN, 슬라이스 종료 시 `pnpm lint && pnpm test && pnpm build`(전체).
- **회귀 가드 보강(F1)**: R5의 "기존 테스트가 회귀 가드"는 *이주 입력/박스가 테스트로 실제 행사되는* 곳에만 성립. 미행사 표면은 **타깃 lockstep 단언 추가**(렌더 + 포커스 링 클래스 or `getByRole`) — tdd-guard pending diff 겸함. 특히: ExtractConfirmRow(전용 테스트 없음)·`Input`/`Select` size 락인·ScenarioNewPage 생성 오류 Callout.
- **tdd-guard(F2)**: JSX-only + size prop 변경은 auto-pass 밖 → 각 파일 test에 렌더/셀렉터/포커스-링 단언을 *먼저* 추가(pending RED diff)한 뒤 src 편집. test-path 편집은 항상 허용(`is_test_path`). 단언 불요 파일엔 keepalive `it.todo` 선-배치 후 task 끝 `rm`(커밋 금지) — orchestrator는 명시 경로만 `git add`(`-A` 금지).
- **라이브 검증(R16)**: results-screens보다도 경량 — run-생성/report-파싱/Zod 경로 비해당(편집 표면). `/scenarios/new`는 클라-only(백엔드 불필요)라 컨트롤러 없이 스모크 가능하나, `/live-verify` 스택으로 저장된 시나리오 편집·combobox·드래그·모달까지 포함해 실측(에디터 dnd-kit 드래그는 `browser_drag` 포인터·Monaco 모달 높이는 `getBoundingClientRect`, `ui/CLAUDE.md`·`docs/dev/live-verify-playwright.md`).

---

## 7. 의도적 연기 (roadmap §B12에 누적)

- **Button/링크 accent 드리프트 이주**: 에디터 indigo/blue 컨트롤 색(ExtractConfirmRow `bg-indigo-600` confirm·ResponseBodyTree `bg-indigo-600` +추출·ConditionNode `border-indigo-200` 레일)은 Button-accent 도메인 — 별도 슬라이스(결과 화면 R11 드리프트와 묶어 "Button-accent 이주"로). 이 슬라이스는 Input/Select/Callout만.
- **`Section` 소비·카드 fieldset의 Section화**: 에디터 카드형 fieldset을 카드 룩 보존한 채 `Section`화하려면 `Section`에 카드 variant(+`min-w-0`) 필요 = 토대 변경 — 연기(data 식별 색 정책과 별개).
- **`InspectorSection`의 `Section` 통합**: `collapsible` API가 닮았지만 카드 비주얼 + localStorage 배선 → 프리미티브 확장 후 별도 검토.
- **데이터-식별 색 토큰화**(methodBadge·✓/✗/○·chip 색): 별 도메인 — 별도 검토(results-screens §7 그대로).
- **`RunListControls` 컴팩트 툴바**(results-screens 연기 그대로)·**success Callout variant**·**status Badge tone**: 토대 변경, 데이터-식별 색 정책과 함께.
- **기존 프리미티브(`Button`/`Modal`/`HelpTip`) `ui/` 폴더 통합**·**기존 HelpTip aria 텍스트 ko 이주**: C-2 §7 그대로 유지.

---

## 8. 구현 순서 (plan 입력)

> 전부 `ui/`(+`ko.ts`)·`docs/` — cargo 게이트 비대상(UI 게이트 `pnpm lint && pnpm test && pnpm build`만). **파일별 단계** — 각 파일 독립 커밋(그 파일 + 의존 테스트 GREEN). 단일 슬라이스·단일 머지. 토대 size 기본 byte-identical(R2)·와이어(R11) 0-diff가 전 phase 공통 불변식.
>
> ⚠ **tdd-guard 사전조치(F2)**: 각 task는 그 파일 test에 렌더/셀렉터/포커스-링 lockstep 단언을 *먼저* 추가(pending diff) 후 src 편집. keepalive는 커밋 금지. orchestrator는 명시 경로만 `git add`.

1. **토대** `ui/Input.tsx`·`ui/Select.tsx` size 변형 + 락인 테스트(R1/R2). **먼저·필수 선결** — ⚠ Props는 `Omit<…,"size">`(안 하면 `tsc -b` 빨강, R1)·`size ?? "md"` 기본. 이후 소비 파일이 `size="sm"`을 쓰고, KeyValueGrid는 `min-w-0`을 입력에 유지(R4⑤)·auto-width select는 `w-fit`(R4⑥) — 이 세 결정이 Task 1에 확정돼야 downstream이 red-build/red-test 상속 안 함. 기존 소비처 전부 green(class-set 동등) 확인.
2. **Inspector.tsx**(HEAVY — 14 input + 5 select) → size/래퍼/mono 규칙·auto-width select `w-fit`·커밋 핸들러 보존·인라인 경고 동결. `Inspector.test`+`Inspector.sections.test` lockstep(섹션 토글·localStorage clear·**combobox-union `Inspector.test:530`**·min-w-0 `:519/534/546`).
3. **KeyValueGrid.tsx**(RISKY — combobox·flex-1) → 래퍼+`size="sm"`+입력 `min-w-0` 유지(R4⑤)+`list=` 패스스루. `KeyValueGrid.test:94` min-w-0 단언·combobox 가드는 `Inspector.test:530`(KeyValueGrid.test Harness는 commonKeys 미주입=textbox뿐) 확인.
4. **InsertTemplateModal.tsx** → w-56 래퍼 입력(combobox 1)·role=alert **독립** 오류 3(`:136`/`:197`/`:205`) → Callout error(`:325` per-token 인라인은 R7 유지). lockstep.
5. **SaveTemplateDialog.tsx** → name/desc Input(패딩/포커스 정규화)·overwrite warn Callout·error Callout. lockstep.
6. **TestRunPanel.tsx** → 3 호박 박스 → warn Callout(칩 색 동결). `.test`+`.extract.test` lockstep.
7. **TestRunSection.tsx + ExtractConfirmRow.tsx + VariablesPanel.tsx** → 각 1 입력 + TestRunSection error Callout. ExtractConfirmRow 타깃 단언 신규(F1).
8. **ValidationBanner.tsx** → 통째 warn Callout(role=status·클릭 행 보존). lockstep.
9. **ScenarioEditPage.tsx**(name 입력 R13·로드/업데이트/복제 오류 Callout) + **ScenarioNewPage.tsx**(생성 오류 Callout). name 테스트 고결합 lockstep.

**마무리**
10. 전체 UI 게이트(`pnpm lint && pnpm test && pnpm build`) + grep 불변식(R7·R8·R9·R10·R11·R12·R14) + whole-branch `handicap-reviewer`(cross-file 일관성·인라인-vs-박스 경계·wire 1:1) + 라이브 검증(R16).
11. roadmap **§B12** 완료 항목 이동(에디터/Inspector) + 새 연기 적재(Button-accent 이주·Section 카드 variant·InspectorSection 통합) + build-log 단락 + 루트 CLAUDE.md 상태줄.
