# genvar-preview-ux — 생성 변수 미리보기·입력 UX 개선 설계

- **날짜**: 2026-07-24
- **유형**: user-path (사용자 도그푸딩 신고 — dynamic-vars 슬라이스[`877964c`] 후속 폴리시)
- **범위**: UI-only. `ui/src/scenario/genVars.ts` + `ui/src/components/scenario/{GenVarEditor,VariablesPanel}.tsx` + `ko.ts`. 모델(Zod `GenSpecModel`)·store·yamlDoc·엔진·컨트롤러·proto·migration **0-diff**.
- **원문 앵커** (사용자 신고, 2026-07-24): ① "'랜덤 정수' 또는 '랜덤 문자열'을 골랐을 때 줄바꿈이 발생하여 보기 좋지 않은데 … 줄바꿈을 하지 않으면 변수 내용을 보기가 힘듬" (= **헤더 행**: 토글·변수명·연필·타입 배지·× — 사용자 재확인) ② "길이가 음수가 될 수 없음에도 감소 버튼을 통해서 음수가 입력되는 것을 볼 수 있는데 … 예시 값이 갱신되어 오인할 가능성" ③ "증가/감소 버튼을 누를때마다 길이는 그대로인채 예시 값만 바뀌다보니 오류가 있다고 오인 … 증가/감소 버튼을 누를때 바로 반영이 됐으면 좋겠음" ④ "이외에도 가변 값에 따라 사람이 인지 시 오해할 수 있는 동작 점검 필요".

## 사용자 스토리 (US)

- **US1**: QA가 gen 변수 펼침 편집기에서 길이/최소/최대/단위를 증감 버튼이나 타이핑으로 조정할 때 — 성공하면 클릭·입력 즉시 예시가 새 파라미터를 반영해 다시 뽑히는 것을 본다.
- **US2**: QA가 변수 패널에서 검색 타이핑·행 펼침/접힘·다른 변수 편집 같은 무관한 조작을 할 때 — 성공하면 랜덤 예시(랜덤 정수/문자열/UUID)가 제자리에서 재추첨되지 않고, 파라미터 변경 또는 펼침 편집기의 ↻(다시 뽑기) 클릭 시에만 갱신되는 것을 본다.
- **US3**: QA가 랜덤 문자열 길이를 감소 버튼으로 내릴 때 — 성공하면 스피너가 1 아래로(65 위로) 내려가지 않고, 타이핑으로 범위 밖 값(0·-1·65·3.5)을 넣으면 그 자리에서 "1~64 정수" 인라인 안내를 본다.
- **US4**: QA가 랜덤 정수의 최소를 최대보다 크게 두고 다른 곳을 클릭했을 때 — 성공하면 "적용되지 않음(최소>최대)" 인라인 안내를 보고, 입력칸의 값과 실제 YAML/예시가 다른 이유를 오해하지 않는다.
- **US5**: QA가 좁은 변수 패널에서 gen 변수의 헤더 행(토글·변수명·연필·배지·삭제)을 볼 때 — 성공하면 그 행이 항상 한 줄로 유지되고(배지 때문에 두 줄로 꺾이지 않고), 변수명이 잘리면 툴팁으로 전체를 확인할 수 있다.

(사용자 승인: US 초안 + 배지→요약 줄 이동안·결정적 2행·폭-적응 그리드·↻ 펼침-전용, 2026-07-24 brainstorming.)

## 1. 배경 — 현재 동작과 근본 원인 (코드 확정)

| # | 증상 | 근본 원인 |
|---|---|---|
| P1 | 증감 버튼마다 예시 값만 재추첨, 길이는 blur 후에야 반영 | ① `GenSampleLine`이 렌더마다 `sampleFor(spec)` 재호출, `sampleFor`가 렌더 중 무시드 `Math.random()` 직접 호출(`genVars.ts:189,193,207`) → 아무 재렌더에나 재추첨. ② 길이/min/max/step은 draft+commit-on-blur(F5 관례 — min/max `GenVarEditor.tsx:147-154`의 `useIntPairDraft` 배선·step `:161-176`·길이 `:186-201`)인데 예시는 **커밋된 spec**만 읽음 → "옛 파라미터로 새 랜덤" |
| P2 | 길이가 스피너로 음수 진입 | 길이 `<Input type="number">`에 `min`/`max` HTML 속성 없음(`GenVarEditor.tsx:333-343`); 1~64 검증은 blur의 `commitLength`뿐이고 불합격은 **조용히 revert** |
| P3 | gen 변수 헤더 행(토글·이름·연필·배지·×)이 두 줄로 꺾임 | 헤더 행이 `flex-wrap`(`VariablesPanel.tsx:289`)이고 타입 배지(`:309-316`, "랜덤 문자열" ≈70px)가 별도 flex 아이템으로 폭을 차지해 `ml-auto` 묶음(덮어씀+×, `:318-335`)을 아랫줄로 밀어냄 — 극단 폴백이 gen 행에선 일상 발동 |
| P4 | (점검 발견) min>max blur 시 소리 없는 no-op — 입력칸 값과 YAML/예시가 달라도 안내 없음 | `useIntPairDraft.commit`(`useIntPairDraft.ts:69`)의 계약된 no-op(draft 보존) + 피드백 부재 |
| P5 | (점검 발견) 접힘↔펼침 토글·검색 타이핑 등 무관 조작마다 패널의 모든 랜덤 예시 일제 재추첨 | P1-①과 동일(무시드 렌더-시 랜덤 + 마운트마다 새 추첨) |

## 2. 목표 / 비목표

**목표**
1. 랜덤 예시를 **(변수명, 파라미터, 재추첨 틱)의 순수 함수**로 — 무관 재렌더·접힘↔펼침 전환에 불변, 파라미터 변경·↻ 클릭에만 변경 (US1·US2).
2. 펼침 편집기의 예시는 **유효한 draft를 겹친 미리보기 spec** 기준 — 증감 버튼 클릭 즉시 반영 (US1).
3. 범위 있는 숫자 입력에 native 구속(`min`/`max`/`step` 속성) + draft 무효 동안 인라인 안내(`aria-invalid`) (US3·US4).
4. 헤더 행에서 타입 배지를 요약 줄 선두로 이동 — 배지로 인한 꺾임을 구조적으로 제거 (US5).
5. 접힘 표시를 "요약 1줄 + 예시 1줄" 결정적 2행으로(각 truncate+title).

**비목표**
- blur 커밋 정책 변경(짝 no-op·단독 필드 revert는 유지 — 인라인 안내로 가시화만 한다).
- 날짜(date) 필드 배치 재구성(형식 select·오프셋·타임존은 이질 폭이라 현행 `flex-wrap` 유지), 날짜 예시의 시각 틱 억제(렌더 시점 시계 반영은 올바른 동작), **오프셋 무효 인라인 안내**(같은 silent-revert 클래스지만 US·테스트 앵커가 없어 범위 제외 — 후속 nit 후보).
- 접힘 행 ↻ 노출(사용자 선택: 펼침 전용), RunDialog 등 다른 화면의 숫자 스피너 정책, 모델/와이어 변경.
- `덮어씀`(overwritten) 경고 배지의 위치 변경 — 헤더 행 잔류(§4.3 폴백 참고).

## 3. 설계 A — 예시 미리보기 안정화 (US1·US2)

### 3.1 시드 결정적 샘플

`sampleFor(spec, now?)`에 난수원 파라미터를 추가한다: `sampleFor(spec, now?, rand: () => number = Math.random)`. 랜덤 3종(random_int·random_string·uuid) 분기는 `rand`만 사용하고, date 분기는 기존 그대로(난수 없음 — NaN 가드 `genVars.ts:179` 불변).

새 순수 헬퍼(`genVars.ts`):
- `canonicalGenKey(spec): string` — kind별 수동 직렬화(`ri:{min}:{max}:{step??1}` / `rs:{length??8}` / `uuid` / `date:...`). `JSON.stringify` 키 순서 비의존.
- `hashSeed(s: string): number` — 문자열 → uint32 (FNV-1a 또는 동급).
- `seededRand(seed: number): () => number` — mulberry32.
- `samplePreview(spec, name, tick): SamplePreview` — `sampleFor(spec, new Date(), seededRand(hashSeed(`${name}|${canonicalGenKey(spec)}|${tick}`)))`.

결과: 같은 (이름, 파라미터, 틱)이면 **어느 마운트/렌더에서든 같은 예시 텍스트** — 접힘 행과 펼침 편집기가 항상 일치하고(P5 해소), RTL이 랜덤 모킹 없이 텍스트를 단언할 수 있다.

### 3.2 재추첨 틱 (↻)

- `VariablesPanel`에 `sampleTicks: Record<string, number>` 로컬 state + `bumpSampleTick(name)` — 컴포넌트 로컬·영속화 비목표(기존 `expanded` Set과 동급). 접힘↔펼침을 오가도 틱이 살아 있어 예시가 이어진다.
- `GenSampleLine` props를 `{spec, name, tick}`으로 확장(3.1의 `samplePreview` 사용). 소비처 2곳(접힘 요약 행, 펼침 편집기) 모두 `VariablesPanel`이 내려준 같은 `tick`을 쓴다.
- ↻ 버튼: **펼침 편집기의 예시 줄에만**. icon-only(`↻`), `aria-label = ko.editor.genSampleRefreshAria(name)`, `title = ko.editor.genSampleRefreshTitle`(문구에 "실행 시 반복마다 새 값이 생성됩니다" 포함 — 랜덤 어포던스 힌트 겸용). 클릭 = `bumpSampleTick(name)`. 미리보기-전용 로컬 상태 조작이므로 `yamlError` 동안에도 **활성**(읽기 전용 크롬 관례 — 접기 토글과 동급, store 무접촉).
- 변수 rename 시 틱 키가 이름 기반이라 리셋(새 이름 → tick 0) — 예시가 한 번 바뀐다. 수용(드문 조작·무해).

### 3.3 draft 겹침 미리보기 (펼침 편집기)

`GenVarEditor`가 `previewSpec`을 도출해 자기 `GenSampleLine`에 넘긴다: 커밋된 spec에서 출발해, **유효한 draft만** 겹친다 —
- length: `lengthDraft`가 1..64 정수면 그 값, 아니면 커밋값(=YAML이 실제로 쓸 값).
- min/max: 두 draft 모두 정수이고 min≤max면 그 쌍, 아니면 커밋 쌍.
- step: draft가 ≥1 정수면 그 값, 아니면 커밋값.

유효성 판정식은 각 commit 함수(`commitLength`/`commitStep`/`useIntPairDraft.commit`)와 **같은 규칙**을 공유 헬퍼로 추출해 드리프트를 막는다. 이 추출은 **동작-보존 리팩터로 한정** — `parseValidInt`(`useIntPairDraft.ts:30`, 현재 module-private) export 포함, blur 시 commit/revert/no-op 분기의 특성화 테스트가 추출 전후 동일함을 고정한다(§2 "blur 커밋 정책 불변"의 증명 의무). 증감 버튼 클릭 = `onChange` → draft 갱신 → `previewSpec` 파라미터 변경 → `canonicalGenKey` 변경 → 예시 즉시 재계산(US1). 접힘 행은 draft가 없으므로 커밋 spec 그대로.

## 4. 설계 B — 입력 구속·무효 피드백 (US3·US4)

### 4.1 native 구속

- 길이: `min={1} max={64} step={1}` — 스피너가 범위 밖으로 못 나감(US3 전반부). 타이핑은 여전히 자유(HTML min/max는 스피너만 구속) → 4.2 안내가 보완.
- 단위(step): `min={1} step={1}`.
- 최소/최대(pair): 속성 구속 없음(임의 정수 유효).

### 4.2 인라인 안내 (draft 무효 동안 라이브 표시, blur 정책 불변)

renameError 관용구(`<p className="mt-0.5 text-xs text-red-600">`, `VariablesPanel.tsx:234`)를 따른다. 표시는 draft 상태에서 도출(별도 state 불요):
- 길이 draft가 비어있지 않고 1..64 정수가 아니면 → 해당 입력 `aria-invalid` + 필드 아래 `ko.editor.genLengthInvalid`("1~64 정수만 적용됩니다" 류). `Input` BASE가 `aria-[invalid=true]:border-red-400` 스타일을 이미 제공(`Input.tsx:6`).
- 단위 draft가 비어있지 않고 ≥1 정수가 아니면 → 동일 패턴, `ko.editor.genStepInvalid`.
- 최소/최대: 각 draft가 비어있지 않고 정수가 아니면 per-field `ko.editor.genIntInvalid`; 둘 다 정수인데 min>max면 그리드 아래 한 줄 `ko.editor.genMinMaxConflict`("최소가 최대보다 커서 적용되지 않습니다" 류) + 두 입력 `aria-invalid` (US4). 안내 `<p>`에 id를 주고 관련 입력 `aria-describedby` 연결.
- 빈 draft는 항상 무-안내(길이/단위 빈 값 = 기본값 복귀 의미론 유지).

단위·비정수 안내(`genStepInvalid`/`genIntInvalid`)는 US3·US4가 세운 "무효 입력을 그 자리에서 안내" 메커니즘을 같은 편집기의 동일-클래스 필드에 일관 적용한 것(원문 앵커 ④의 점검 산출)이며 §6 RTL ⑤·⑥이 검증한다. 오프셋 안내는 범위 제외(§2 비목표).

blur 시 기존 정책(commit/revert/no-op) 그대로 — revert가 일어나면 draft가 유효값으로 돌아가 안내도 자연 소멸.

### 4.3 헤더 행·접힘 레이아웃 (US5·목표 5)

**헤더 행** (`VariablesPanel.tsx:289-336`):
- 타입 배지(`isGenSpec && <span …indigo…>` 블록)를 헤더 행에서 **제거**하고 요약 줄 선두로 이동. 헤더 행은 토글·이름(flex-1 truncate+`title`)·연필·(`덮어씀`)·× — static 행과 동일 구성이 되어 **타입 배지로 인한 꺾임의 원인이 제거된다**(헤더 min-content ≈214px→≈138px < 열 ~184px; 덮어씀 극단 폴백은 §7).
- `flex-wrap`은 유지 — `덮어씀` 경고 배지(+긴 이름) 극단 케이스의 의도된 폴백(badge-x-wrap-fix 선례)을 남긴다. gen 행의 일상 케이스는 배지가 없으므로 한 줄(라이브 rect로 실증).

**접힘 표시(2행 결정적)** — gen 변수의 접힘 상태(`VariablesPanel.tsx:345-349` 교체):
- 1행(요약): `[타입 배지] 파라미터 요약` — 배지는 기존 pill 시각 그대로(indigo-50), 요약 텍스트는 새 `genParamsSummary(spec)`(타입명 중복 제거): date `오늘+7일 · Asia/Seoul`(현행 유지) / random_int `1 ~ 100`(step≠1일 때만 `· N 단위` — 현행 `genVars.ts:71-72` 조건 유지) / random_string `{length??8}자` / uuid **빈 문자열**(배지 단독). 줄 전체 truncate + `title`(파라미터가 비면 `genTypeLabel`만, 아니면 `genTypeLabel · 파라미터` — 매달린 구분자 금지).
- 2행(예시): `예: …` — `GenSampleLine` **자신이** `block truncate` + `title`(전문) 렌더를 담당(부모 래핑 불요 — 텍스트가 컴포넌트 내부에서 도출되므로 title도 같은 곳에서. 접힘·펼침 양쪽 동일 표시). `flex-wrap` 나란히 배치를 폐지해 우발 wrap 제거.
- `genSummary`는 소비처가 재편된다: 접힘 요약은 `genParamsSummary`, 검색은 `declSearchText = genTypeLabel(v) + " " + genParamsSummary(v)`(타입명 검색 유지 — 기존엔 random_int/date가 타입명 미포함이라 "정수" 검색이 안 걸리던 것도 개선), 배지 title은 요약 줄 title로 대체. 재편 후 무소비처가 되면 `genSummary` 자체는 제거 가능(plan에서 grep 확정).

**펼침 편집기 필드 그리드** (`GenVarEditor.tsx:291,331`):
- **random_int 컨테이너만** `flex flex-wrap` → `grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-x-2 gap-y-1`로. 좁은 열(~168px 내부폭)에선 2열(최소|최대 / 단위), 넓은 열(varsWide)에선 자연히 한 행 — CSS-only 폭-적응, 레이아웃 점프 없음(사용자 확인 반영: 고정 2열 대신 폭-적응). 셀 안 `Input`은 고정폭(w-20/w-16) 제거(셀이 폭 결정). **random_string은 현행 단일 길이 필드(w-16) 유지** — 필드가 하나라 wrap 자체가 없고, auto-fit 단일-아이템 grid는 길이 입력을 전폭으로 늘리는 미검증 시각 변화라 제외.
- date 컨테이너는 현행 유지(비목표).

## 5. 와이어·게이트 영향

- YAML/모델/store 0-diff: `GenSpecModel`·`setVariableGen`·yamlDoc 무접촉. 커밋 시점/값 의미론 불변(F5 유지) → 저장되는 YAML byte-identical.
- 보안 게이트: 요청실행·템플릿/캐스트·env/데이터셋·업로드·trace 무접촉 — `finish-slice §0` grep이 최종 판정(N/A 예상은 가설일 뿐).
- 신규 ko 키(7): `genSampleRefreshAria(name)`/`genSampleRefreshTitle`/`genLengthInvalid`/`genStepInvalid`/`genIntInvalid`/`genMinMaxConflict`/`genLengthSuffix`(= `"자"` — `genParamsSummary`의 "N자" 접미, `genStepUnit` 선례와 동형·ADR-0035 하드코딩 회피) — **기존 카탈로그 전체와 양방향 부분문자열 충돌 검사 필수**(thinkboard-defaults 함정, `toHaveTextContent` 부분매칭). 사전 플래그: `genSampleRefreshTitle`의 "실행 시" 조각은 기존 `genSampleUnsupported`("미리보기 불가 — 실행 시 적용", `ko.ts:542`)와 공유되므로 관련 단언은 부분문자열 금지·전문 또는 `/^…$/` 앵커로.

## 6. 테스트 전략

- **단위(genVars)**: `canonicalGenKey` 안정성(동일 spec 재구성 → 동일 키), `samplePreview` 결정성(같은 (spec,name,tick) → 같은 텍스트; tick/파라미터 변경 → 랜덤 3종 텍스트 변경), length 반영(rs 길이 n → 텍스트 길이 n), date 분기 기존 테스트 불변. **이빨 실증**: 시드 경로를 일시 `Math.random`으로 되돌려 결정성 테스트 RED 확인(plan-mandated-vacuous-tests 의무).
- **RTL GenVarEditor**: ① `fireEvent.change`(스피너 등가)로 길이 draft 변경 → 예시 텍스트가 즉시 새 길이 반영(blur 없이, US1) ② 무효 draft(0/65) → `aria-invalid`+안내 문구, 예시는 커밋값 기준 유지(US3) ③ min>max → `genMinMaxConflict` 표시+양 입력 `aria-invalid`(US4; pair 입력은 `fireEvent.change`+`blur` 이디엄 — `useThinkTimePair` 포커스 이동 함정) ④ ↻ 클릭 → 예시 변경 + `aria-label` 계약 ⑤ 단위 draft 무효(0·-1·1.5) → `genStepInvalid`+`aria-invalid` ⑥ 최소/최대 비정수 draft → per-field `genIntInvalid`.
- **RTL VariablesPanel**: ① 헤더 행에 gen 배지 부재 + 요약 줄에 배지·`{length}자` 존재(구조 계약) ② 검색 타이핑 후 예시 텍스트 불변(US2) ③ 펼침→↻→접힘 후 접힘 예시가 갱신된 텍스트와 동일(틱 lift 계약) ④ 검색 "문자열"/"정수"가 해당 gen 행 매치(`declSearchText`). 기존 테스트 churn(확정 목록): `genVars.test.ts:80`(`declSearchText === genSummary` 단언 — declSearchText 재정의로 재작성)·`genVars.test.ts:105-128`(`genSummary` 단위테스트 5건 — `genParamsSummary`로 재표적, `genSummary` 제거 시 함께 삭제)·`ScenarioNewPage.genvars.test.tsx:113-128`(배지가 헤더 행에 있다는 구조 단언 — 요약 줄 기준으로 갱신). 그 외는 plan에서 grep로 전수 확정.
- **클래스 계약**: 그리드 토큰은 `className.split(/\s+/)`+`toContain` 정확-토큰(raw `toContain` substring false-green 함정), 길이 input `min`/`max` 속성.
- **라이브(Playwright, 머지 전)**: US 척추 표로 — US1(스피너 클릭 → 예시 텍스트 즉시 변경 실측), US2(검색 타이핑 → 예시 불변), US3(스피너 연타 → `input.value` 1 바닥 + 0 타이핑 시 안내), US4(min>max 안내), US5(**gen 행 헤더 rect: 이름과 ×의 `top` 동일** — 한 줄 실증). jsdom은 layout 0이라 rect가 권위(#5 false-PASS 클래스). **진입 화면 2곳 모두**: `/scenarios/new`·`/scenarios/{id}`(live-verify-all-mount-paths).

## 7. 알려진 한계 (수용)

- 날짜 예시는 재렌더 시점 시계를 따른다(초 단위 형식은 재렌더마다 진행) — 랜덤 flicker와 달리 올바른 값이므로 수용.
- rename 시 예시 재추첨(틱 키가 이름 기반) — 드문 조작, 무해.
- `덮어씀`+극단 좁은 폭 조합의 헤더 wrap 폴백은 유지(의도된 안전 폴백).
- 스피너 native 구속은 브라우저 구현 의존(타이핑 우회 가능) — 인라인 안내가 보완 층.
