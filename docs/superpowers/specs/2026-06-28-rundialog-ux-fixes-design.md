# RunDialog UX 버그·예상-밖 동작 수정 — 설계

- **날짜**: 2026-06-28
- **슬라이스 slug**: `rundialog-ux-fixes` (worktree `worktree-rundialog-ux-fixes`)
- **상태**: 설계 (spec) — spec-plan-reviewer 검토 루프 / plan 미작성 (다음 세션)
- **범위**: UI-only. `crates/**`·proto·migration·`schemas.ts` **0-diff**, payload·wire **byte-identical**, `ScheduleForm` **byte-identical**. ADR-0043(디자인 시스템) 토대 재사용 — 신규 ADR 없음.
- **선행 맥락**: 직전 슬라이스들(`rundialog-design-system`, `rundialog-simple-detailed-mode`, `rundialog-mockup-fidelity`)이 RunDialog를 v3 목업에 맞춰 재구성하며 "추천값 프레이밍"을 도입했다. 본 슬라이스는 사용자 dogfooding 피드백으로 그 일부(고정 추천)를 **의도적으로 되돌리고** 5개의 구체적 UX 버그/어색함을 고친다.

## 1. 문제 (사용자 피드백, 원문)

RunDialog 사용 중 발견한 5개 항목:

1. **프리셋 불러오기 드롭다운** — (a) "프리셋 불러오기" 라벨이 드롭다운보다 작은데도 줄바꿈됨(방지 필요). (b) 프리셋을 선택해도 드롭다운이 `— 선택 —`에서 변하지 않아 무엇이 선택됐는지 알 수 없음.
2. **부하 모델 선택 HelpTip이 테두리 밖에 있어 어색함** — "차라리 글자 옆에 있는 게 나을 것 같음."
3. **가볍게/보통/세게 기준이 애매모호함** — 대상 시스템 상태에 따라 적정 부하가 달라지는데 고정 값으로 "추천"하는 게 말이 안 됨.
4. **응답 시간 단계 분해 HelpTip 내용이 바깥 설명과 동일함** — HelpTip엔 더 자세한 설명을 담는 게 나음(예: 서버 자원에 여유가 없으면 VU·RPS를 최대로 못 뽑음; 연결/대기/다운로드는 어디까지 분해한 건지).
5. **Footer sticky 시 하단 여백 부족** — 화면을 위로 올려 footer가 하단을 따라다닐 때 실행하기 버튼과 창 최하단 사이에 여유가 없음.

## 2. 확정된 결정 (사용자 선택)

| 항목 | 결정 |
|---|---|
| 3 (고정 추천) | **Option A — 예시로 재구성** (정성 라벨·"추천" 프레이밍 제거, 중립 "빠른 입력" 숫자 칩 + "대상에 맞게 조정" 캡션). **Option C(기준 대비 상대 배수)는 roadmap 백로그로 남김.** |
| 2 (HelpTip 위치) | **Option A — 제목 옆·테두리 안** (타일을 `div + 숨김 native radio + stretched label` 구조로 재구성, HelpTip을 제목 텍스트 옆 형제로). |
| 1b (프리셋 표시) | **Option A — 수정 시 표시 복귀 (render-derived)** (불러온 직후 프리셋 이름 표시, 이후 폼 수정 시 `— 선택 —`으로 복귀 → 표시가 항상 폼과 일치). ※ 상태(`loadedPresetId`)를 *리셋하지 않고* 표시만 도출 — §3.1 참조(rename/delete 보존). |

## 3. 상세 설계

기준 파일(현재 줄 번호는 작성 시점 기준, 구현 시 이동 가능):
`ui/src/components/RunDialog.tsx`, `ui/src/components/LoadModelFields.tsx`, `ui/src/i18n/ko.ts`.

### 3.1 ① 프리셋 드롭다운 (RunDialog.tsx, item 1)

**1a — 줄바꿈 방지.** "프리셋 불러오기" 라벨(`<label htmlFor="load-preset">`, 현 RunDialog.tsx:556–558)에 `shrink-0 whitespace-nowrap` 추가. 원인: 라벨이 `flex items-center gap-2` 행 안에 있고 형제 `<Select>`가 `block w-full`(Select 프리미티브 BASE)이라 라벨을 압축 → 줄바꿈.

**1b — 선택 반영 + 수정 시 표시 복귀 (render-derived, `loadedPresetId` 미클리어).**

⚠️ **`loadedPresetId`를 클리어하지 말 것** (spec-reviewer CRITICAL): `loadedPresetId`는 드롭다운 표시 외에 **이름 변경/프리셋 삭제 버튼을 게이트**(현 :890 `{loadedPresetId && (…이름 변경…프리셋 삭제…)}`)하고 `renamePreset`/`removePreset`의 대상(현 :506·:520)이다. "수정 시 `loadedPresetId=null`"로 클리어하면 **불러온 뒤 한 글자라도 고치면 이름 변경/삭제 버튼이 사라져** 의도된 기능("불러와 고친 뒤 이름 변경 = 현재 상태를 새 이름으로 저장", 현 :501-504 NOTE)을 깬다. 기존 rename 테스트(`RunDialog.test.tsx:646-660`)는 *고치지 않고* 이름 변경해 이 회귀를 못 잡는다.

- **표시는 render-derived divergence 비교로** (state 클리어 없음): `loadedPresetId`는 load 시 set·rename/remove에서만 갱신(현행 유지). 별도 `presetSnapshotKey` state를 두고, 드롭다운 값을
  `value={loadedPresetId && currentProfileKey === presetSnapshotKey ? loadedPresetId : ""}`
  로 매 렌더 도출(`currentProfileKey = JSON.stringify(buildProfile())`). 폼이 스냅샷과 일치하면 프리셋 이름이 보이고, 어긋나면 `""`(— 선택 —). effect로 state를 클리어하지 않으므로 무한 렌더·rename/delete 회귀 둘 다 없다.
- **스냅샷은 *불러온 직후 committed 상태*의 `buildProfile()`과 by-construction 일치해야 한다** (reviewer IMPORTANT — `measure_phases` 트랩): `buildProfile()`이 보는 입력은 부하-모델 10개뿐 아니라 `loopCap·httpTimeout·bindings·think*·criteriaState(11개)·stepCriteria·measurePhases` 전부다(현 :456-466). 그리고 `loadPreset`은 **`measurePhases`를 의도적으로 시드하지 않는다**(현 :249-251 NOTE) → raw `prof.measure_phases`로 스냅샷을 만들면 load 직후 `buildProfile()`(=live measurePhases)와 어긋나 *불러오자마자* 표시가 `— 선택 —`으로 떨어진다. **권장 메커니즘**: `loadPreset`이 마지막에 단조 증가 `presetLoadTick`을 set하고, 그 tick을 dep로 한 effect가 **load의 모든 setState가 commit된 *뒤*** 그 시점 `buildProfile()`(=committed live 상태, measurePhases 포함)으로 스냅샷을 캡처한다(`setPresetLoadTick`이 `loadPreset`의 *마지막* 호출이라 모든 적용 필드가 commit된 렌더에서만 effect 발화 → React 18 배칭 여부와 무관하게 1회만, mount 시 1회는 `loadedPresetId===null`이라 무해). 이렇게 하면 deriveLoadMode 재구현·measurePhases 트랩 없이 "불러온 직후 == 일치"가 구조적으로 보장된다.

  ⚠️ **`react-hooks/exhaustive-deps` 함정** (spec-reviewer IMPORTANT — `pnpm lint --max-warnings=0` 게이트가 잡음): effect 본문이 `currentProfileKey`를 참조하는데 dep 배열은 `[presetLoadTick]`뿐 → eslint가 누락 dep을 경고해 **UI 게이트 빌드 실패**. 그렇다고 `currentProfileKey`를 dep에 넣으면 *매 폼 수정마다* 스냅샷이 재캡처돼 `currentProfileKey === presetSnapshotKey`가 항상 참 → **드롭다운이 영영 복귀 안 함**(1b 기능 silent 무력화). **해결**: 매 렌더 `keyRef.current = currentProfileKey`(latest-value ref 패턴)로 갱신하고 effect는 `setPresetSnapshotKey(keyRef.current)`로 ref를 읽는다 — ref는 exhaustive-deps 예외라 dep 배열은 `[presetLoadTick]` 유지가 정당(또는 근거 단 `eslint-disable-next-line`). **`currentProfileKey`를 dep 배열에 넣지 말 것.** 정확한 ref/disable 형태는 plan 재량(단일 캡처 + revert 동작이 acceptance).

- **save/rename 성공 시에도 스냅샷 재캡처** (reviewer MINOR — "표시가 항상 폼과 일치" 일관성): 불러와 고친 뒤(드롭다운 `— 선택 —`) `프리셋으로 저장`(덮어쓰기)이나 `이름 변경`을 하면 폼이 *저장된* 프리셋과 같아지므로 드롭다운도 그 이름을 보여야 한다. `savePreset`/`renamePreset`의 `onSuccess`(현 :490·:496은 `setLoadedPresetId`, :514는 `setPresetName(next)` — `renamePreset`은 `loadedPresetId`를 이미 가진 채라 재설정 안 함; 그 자리에 `presetLoadTick` bump를 *추가*)에서도 `presetLoadTick`을 bump해 같은 effect가 스냅샷을 재캡처한다(`removePreset`은 `loadedPresetId=null`이라 불필요). 회귀 아님(현 코드도 항상 `""` 표시)이나 일관성 향상.
- **state-only·payload 무영향**: `presetSnapshotKey`/`presetLoadTick`/드롭다운 value 도출은 전부 표시 전용 — `buildProfile()` 출력·POST payload엔 영향 없음.
- **env carve-out** (reviewer MINOR): 프리셋 식별은 `currentInput()`상 env도 포함하지만(현 :468-474) `buildProfile()`은 env를 제외한다. 따라서 **드롭다운 divergence는 Profile(부하 설정)만 비교** — 환경(env) 행만 고친 경우 드롭다운은 프리셋 이름을 유지한다(프리셋의 부하 설정은 그대로이므로 수용 가능한 carve-out). env까지는 비교하지 않는다(범위 최소화).
- 불변식: 프리셋 불러오기 자체의 동작(어떤 필드를 채우는지)·rename/remove 동작은 그대로. 드롭다운 표시 도출 + 스냅샷 캡처만 추가.

### 3.2 ② 부하 모델 타일 HelpTip (LoadModelFields.tsx, item 2)

**범위**: `loadModelTiles === true` 분기(현 :290–345, RunDialog 전용)만. **`!loadModelTiles` 라디오 분기(ScheduleForm)와 프로파일 Segmented(:388–402)는 0-diff.**

현재 각 타일은 `<button role="radio" aria-checked>`이고 HelpTip은 타일 button 바깥 형제(`<div className="flex items-start gap-1"><button>…</button><HelpTip/></div>`, 현 :318·:343) → 테두리 밖 우측에 떠 있음. button 안에 HelpTip(또 다른 button)을 넣을 수 없음(중첩 interactive + accessible-name 오염, U3 트랩).

**재구성** (각 타일):
- 컨테이너 `<div className="relative …">`(선택 시 `border-accent-500 bg-accent-50`, 아니면 `border-slate-200 hover:border-slate-300`).
- 네이티브 `<input type="radio" name="load-model" id={…} className="sr-only" checked={loadModel===…} onChange={() => setLoadModel(…)} />` — 라디오 시맨틱·키보드 그룹 이동을 네이티브로 확보.
- 장식 라디오 인디케이터 `<span aria-hidden …>`(선택 상태로 스타일, 현행과 동일).
- 텍스트 열: 제목 행 `<span className="flex items-center gap-1"><label htmlFor={…} className="… cursor-pointer after:content-[''] after:absolute after:inset-0">{제목}</label><HelpTip className="relative z-10">…</HelpTip></span>` + 설명 `<span className="text-xs text-slate-500">{desc}</span>`.
- **"stretched label" 기법**: `label::after { content:''; position:absolute; inset:0 }`로 라벨의 클릭 영역을 카드 전체로 확장(타일 어디를 눌러도 선택). HelpTip은 `relative z-10`으로 라벨 오버레이 위에 떠 자기 클릭을 가로챔 → 카드 전체 클릭 + HelpTip 독립 동작. ⚠️ **`after:content-['']`이 필수** (spec-reviewer IMPORTANT — Tailwind v3 함정): preflight가 `::after`에 `--tw-content:''`만 깔고 `content: var(--tw-content)`는 `content-*` 유틸리티에서만 emit된다 → `after:content-['']` 없이 `after:absolute after:inset-0`만 주면 `::after`의 `content`가 `normal`이라 의사요소 박스 자체가 안 생겨 **오버레이가 없음**(제목 텍스트만 클릭 가능, 카드 나머지·설명·인디케이터 클릭 무반응 → "타일 어디든 클릭"이 깨짐). 코드베이스에 `after:`/`before:` 의사요소 유틸리티 선례가 없으므로(grep 0) 라이브에서 "카드 빈 영역 클릭 시 선택"을 반드시 실측.

**a11y 불변식**:
- 두 옵션은 여전히 role=radio(네이티브 input)이고 같은 `name="load-model"` 그룹.
- 각 라디오의 accessible name = **제목만**(`tileClosedTitle`/`tileOpenTitle`) — HelpTip이 accname을 오염시키지 않음. (현재는 button 콘텐츠가 제목+설명이라 accname이 "제목 설명"이었음 → **제목만으로 변경됨**: 관련 테스트의 name 매처 갱신 필요.)
- 선택 상태는 `aria-checked` 대신 네이티브 `checked`로 노출(`getByRole("radio",{checked:true})` 호환).
- 공유 `closedLoop`/`openLoop` 텍스트 키는 라디오 분기 보존(R2)와 무관 — 타일 분기는 `tileClosedTitle`/`tileOpenTitle` 사용(현행 유지).

### 3.3 ③ 가볍게/보통/세게 → 빠른 입력 예시 (item 3, Option A)

**(a) 크기 프리셋 칩** (LoadModelFields.tsx, closed+fixed 분기 현 :482–511; ko.loadModel 현 :190–194):
- 정성 라벨(가볍게/보통/세게) 제거. 칩은 **중립 숫자 라벨**만 표시(`10명 · 30초` / `50명 · 1분` / `200명 · 3분`). **값(vus/durationSeconds)은 동일** → 클릭 시 동일 `setVus`/`setDuration` → payload 불변.
- 그룹 라벨 `부하 크기 프리셋` → `빠른 입력`. 그룹 아래 캡션 추가: "대상 시스템에 맞게 조정하세요".
- ko 변경:
  ```ts
  sizePresetsLabel: "빠른 입력",
  sizePresetsCaption: "대상 시스템에 맞게 조정하세요",   // 신규
  sizePresets: [
    { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
    { label: "50명 · 1분", vus: 50, durationSeconds: 60 },
    { label: "200명 · 3분", vus: 200, durationSeconds: 180 },
  ],   // 기존 `hint` 필드 제거, label=중립 숫자. 렌더는 {p.label}만 표시(hint span 제거)
  ```

**(b) "추천" 배지·안내문 제거**:
- `recommended` "추천" Badge 4곳(VU·지속·RPS×2; LoadModelFields Field `recommended={showRecommended ? ko.common.recommended : undefined}` 현 :517·:532·:686·:704) 미렌더. **`showRecommended` prop 제거**(LoadModelFields Props·구조분해·RunDialog 호출처) — RunDialog 전용 prop이라 ScheduleForm 무영향. `Field`/`Badge` 프리미티브와 `ko.common.recommended` 키 자체는 **그대로 둠**(다른 사용처 가능, 0-diff 표면 최소화).
- `ko.runDialog.recommendedNotice`(현 :101) 문구 변경: `"추천값으로 채워져 있어 바로 실행할 수 있습니다."` → `"기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요."` (키 이름은 유지하거나 `defaultNotice`로 개명 — plan 재량; 키 개명 시 RunDialog 참조처 동기 변경).

**백로그(이 슬라이스 밖)**: Option C — 고정 숫자 대신 이전 run/기준 측정치 대비 상대 배수(0.5×/1×/2×) 사이징. roadmap에 후보로 기록(finish-slice).

### 3.4 ④ 응답 시간 단계 분해 HelpTip 심화 (RunDialog.tsx, item 4)

현재 측정 섹션(현 :731–737)에서 HelpTip body와 바깥 텍스트가 둘 다 `ko.runDialog.measureDesc` → 중복. 바깥 `measureDesc`(한 줄 요약)는 유지하고 HelpTip에 **신규 `ko.runDialog.measureHelp`**(심화)를 사용:

```ts
measureHelp:
  "응답 시간을 네 단계로 나눕니다 — DNS(주소 조회) → 연결(TCP+TLS 핸드셰이크) → 대기(요청 전송부터 첫 바이트까지 ≈ 서버 처리 시간) → 다운로드(본문 수신). " +
  "keep-alive로 연결을 재사용하면 DNS·연결 비용은 첫 요청에만 들고 그다음 요청은 0입니다. " +
  "각 단계의 퍼센타일은 비가산이라 네 단계의 합이 전체 응답 시간과 다를 수 있습니다. " +
  "서버 자원에 여유가 없으면 VU나 RPS를 올려도 '대기' 단계만 길어지고 처리량은 더 오르지 않습니다 — 이때 단계 분해로 병목이 서버(대기)인지 네트워크(DNS·연결)인지 가려냅니다.",
```

`<HelpTip>{ko.runDialog.measureDesc}</HelpTip>` → `<HelpTip>{ko.runDialog.measureHelp}</HelpTip>`. 바깥 `<span>{ko.runDialog.measureDesc}</span>`은 그대로.

### 3.5 ⑤ Footer 하단 여백 (RunDialog.tsx, item 5)

RunDialog는 페이지에 **inline** 렌더(`ScenarioRunsPage` `<div className="mb-6"><RunDialog/></div>`, Modal 아님). footer는 `sticky bottom-0`(현 :1070)이라 스크롤 시 뷰포트 바닥에 밀착 → 실행하기 버튼과 창 최하단 사이 여백 0.

**수정**: 스티키 footer div에 하단 패딩 추가(`pb-3` 정도) → 버튼 아래 흰 영역이 생겨 숨 쉴 공간 확보. 정확한 값(`pb-2`/`pb-3`/`pb-4`)은 라이브 스크린샷으로 미세 조정. footer의 부하-모양 시그니처/요약(LoadShapePreview·runSummary)·`role="img"`·버튼은 0-diff.

## 4. 불변식 (acceptance 가드)

- **payload·wire byte-identical**: `buildProfile()` 출력 불변. `crates/**`·proto·migration·`ui/src/scenario/schemas.ts` 0-diff. 크기 칩의 vus/duration 값 불변 → 동일 입력 시 동일 payload.
- **ScheduleForm byte-identical**: LoadModelFields 변경은 `loadModelTiles` 분기·`showRecommended`(RunDialog 전용 prop) 한정. ScheduleForm은 `loadModelTiles`/`showRecommended` 미전달 → 라디오 분기·Field(추천 미렌더는 원래 미전달과 동일) 모두 0-diff.
- **a11y**: 부하 모델 옵션은 role=radio·그룹 유지·키보드 이동 가능, accessible name = 제목, HelpTip accname 비오염(U3).
- **ko.ts**: 추가(measureHelp·sizePresetsCaption) + 기존 문구 수정(recommendedNotice·sizePresets·sizePresetsLabel). `ko.common.recommended`·`Field`/`Badge` 프리미티브 0-diff(미사용으로 남김).
- **1b state-only + rename/delete 보존**: 드롭다운 표시는 render-derived(`presetSnapshotKey` 비교)로 `loadedPresetId`를 **클리어하지 않는다** → 이름 변경/삭제 버튼·`renamePreset`/`removePreset` 동작 byte-identical 보존. 스냅샷/표시 도출은 payload 무영향.

## 5. 테스트 전략

기존 RunDialog/LoadModelFields 테스트 파일(`ui/src/components/__tests__/`)에 추가/수정. **TDD 순서 함정**(ui/CLAUDE.md): src 편집 전 *테스트 파일을 먼저* 수정해 pending diff를 만들어야 `tdd-guard`가 첫 src 편집을 막지 않는다.

**신규/변경 RTL 테스트:**
1. **1b (render-derived)**: 프리셋 불러오기 → 드롭다운 value가 프리셋 id 반영(이름 표시) → 부하 폼 필드(예: VU) 변경 → 드롭다운이 `""`(— 선택 —)로 복귀. **⚠️ 비동기 단언**(reviewer MINOR): 스냅샷이 post-paint effect에서 잡혀 선택 직후 1프레임은 `""`이므로 "value가 프리셋 id 반영"은 `await waitFor`/`findBy`로(기존 rename 테스트 `RunDialog.test.tsx:646-660`이 같은 패턴). **추가 회귀 가드(finding 1)**: 같은 흐름에서 불러온 뒤 VU를 고쳐도 **이름 변경/프리셋 삭제 버튼이 그대로 있음**(`getByRole("button",{name:"이름 변경"})`/`"프리셋 삭제"` 잔존 — `loadedPresetId` 미클리어 증명).
2. **1a**: 프리셋 라벨에 `shrink-0 whitespace-nowrap` 클래스 존재(클래스 단언, 시각 회귀 보조).
3. **2**: `getByRole("radio",{name: tileClosedTitle})`/`openTitle` 매칭(accname=제목만), HelpTip 버튼 존재, 라디오 클릭 시 선택 토글. (카드 빈 영역 클릭 선택은 jsdom이 의사요소 레이아웃을 안 그려 RTL로 불충분 → **라이브에서 실측**.)
4. **3**: "추천" Badge 부재(`queryByText("추천")` null), 빠른-입력 칩 클릭 시 vus/duration 적용(값 단언), `sizePresetsCaption` 텍스트 존재, 칩에 가볍게/보통/세게 라벨 부재.
5. **4**: 측정 HelpTip body가 `measureDesc`와 다름(심화 문구의 식별 구절 — 예: "처리량은 더 오르지 않습니다" — 포함).
6. **5**: 스티키 footer에 `pb-*` 클래스 존재(클래스 단언).

**기존 테스트 *수정* (제거하면 회귀 가드 소실 — 반드시 갱신, reviewer finding 4):**
- `RunDialog.test.tsx:213-215`("부하 섹션 상단에 추천 안내를 보인다")는 옛 문구 `"추천값으로 채워져 있어…"`를 정확 단언 → §3.3(b)의 새 `recommendedNotice`(또는 개명 키) 문구로 갱신.
- `LoadModelFields.test.tsx:365-380`(B4 `it.each` "showRecommended=true → '추천' Badge")는 제거되는 `showRecommended` prop을 넘겨 `tsc -b`(removed prop)+런타임 둘 다 깨진다 → 블록을 **제거**하고 "추천" Badge 부재(prop 없이) 단언으로 대체(위 신규 3과 통합 가능).

**non-issue 확인됨**(reviewer finding 6, 손댈 필요 없음): `ko.test.ts:39-43`은 `p.vus`/`p.durationSeconds`만 읽어 `hint` 제거 무영향; 타일 name 매처는 *title* 정규식이라 native-radio `<label>`로도 통과; footer `[class*="sticky"]` 셀렉터는 `pb-3` 추가에 불변.

게이트: `cd ui && pnpm lint && pnpm test && pnpm build`(전체 — targeted-green ≠ full-green).

**라이브 검증**(run-생성/payload 경로는 안 건드리지만 시각·동작 회귀가 본질이라 권장): 워크트리 자체 바이너리 + responder + Playwright — (a) 프리셋 불러오기 후 드롭다운에 이름 표시 → 폼 수정 시 "— 선택 —" 복귀 + **이름 변경/삭제 버튼 잔존**(finding 1), (b) 부하 모델 HelpTip이 제목 옆·테두리 안 + **타일 카드 빈 영역 클릭 시 선택**(`after:content-['']` 오버레이 실측, finding 2), (c) 빠른-입력 칩·"추천" 부재, (d) 측정 HelpTip 심화 내용, (e) 스크롤 시 footer 하단 여백, (f) closed 1 run 생성 → payload byte-identical 확인.

## 6. 범위 밖 / 백로그

- **Option C (상대 배수 사이징)** — 기준 측정치 대비 0.5×/1×/2×. 별도 슬라이스(roadmap 후보).
- 측정/판정/저장/환경/데이터셋 등 다른 섹션 로직 — 미접촉.
- 보안 표면(요청 실행·템플릿/캐스트·env/데이터셋 바인딩·업로드 파싱·trace/body 뷰어) — **미접촉** → security-reviewer N/A 예상.

## 7. 파일 (예상)

- `ui/src/components/RunDialog.tsx` — 1a·1b·④·⑤.
- `ui/src/components/LoadModelFields.tsx` — ②(타일 재구성)·③(칩 relabel·추천 제거·`showRecommended` prop 제거).
- `ui/src/i18n/ko.ts` — `measureHelp`(신규)·`sizePresetsCaption`(신규)·`sizePresets`/`sizePresetsLabel`/`recommendedNotice`(수정).
- `ui/src/components/__tests__/RunDialog.test.tsx`·`LoadModelFields.test.tsx` — 위 신규/변경 테스트(§5; 기존 테스트 2건 수정 포함). ko 카탈로그 테스트는 `ui/src/i18n/__tests__/`(있으면).
- (finish 시) `docs/build-log.md`·`docs/roadmap.md`(Option C 백로그)·루트 `CLAUDE.md` 상태줄.

검증: `crates/**`·proto·migration·`schemas.ts`·`ScheduleForm.tsx`·`Field.tsx`·`Badge.tsx` **0-diff**.
