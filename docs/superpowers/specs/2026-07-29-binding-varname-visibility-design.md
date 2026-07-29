# 데이터셋 바인딩 변수명 가시성 — 설계

- **날짜**: 2026-07-29
- **유형**: `user-path`
- **발의**: 사용자 도그푸딩 (§A12 계열 — 실사용 마찰 보고)
- **범위**: UI-only. 서버·proto·엔진·store·migration **0-diff**.
- **개정**: rev3.
  - rev2 — spec-plan-reviewer 1차 `APPROVE-WITH-FIXES` 반영(사실 오류 5·모순 4·설계구멍 9). 최대 변경은 §3.6 R1 편입[사용자 결정]과 폭 상수 `w-44`→`w-48`[F2 산술 오류].
  - rev3 — 2차 `APPROVE-WITH-FIXES` 반영(문장 수정 6건, 재설계 없음): T9 픽스처 조건[N1]·US5 라이브 절차 보정[N2]·R-INVARIANT 6a/6b 분리[N3]·`ml-[200px]` 커버리지[N4]·자수 한계 배지/manual 분리[N5]·오타 가드 라이브 생략[N6] + §3.6 방어 근거 3종.

## 사용자 스토리 (US)

원문 앵커 (규약 `docs/dev/user-story-spine.md` — 사용자 원문이 있으면 재작성 대신 앵커로):

> "변수명이 길어지면 데이터셋 설정하는 화면에서 잘려서 안 보이는 게 불편했어"
> "읽을 수 없었어. 특히 병렬 브랜치에 들어간 스텝인데, 브랜치 이름이 길면 브랜치 이름밖에 안 보이게 되는 거지"

- **US1** — QA가 병렬 분기에서 값을 추출하는 시나리오로 부하를 실행하려 할 때, 데이터 바인딩 화면에서 어느 행이 어느 변수인지 구분하려 한다 — 성공하면 같은 분기의 두 행이 `session_token` / `order_id`로 **서로 다르게** 보인다.
- **US2** — QA가 긴 이름의 일반 변수(`order_number_reference`, 22자)를 쓰는 시나리오에서 그 변수의 매핑 상태를 확인하려 한다 — 성공하면 **말줄임 없이 이름 전체**를 읽는다.
- **US3** — QA가 에디터에서 데이터셋으로 미리 실행해 보기 전 열↔변수 매핑을 점검한다 — 성공하면 입력칸을 클릭해 스크롤하지 않고 **한눈에** 변수명 전체를 읽는다.
- **US4** — QA가 병렬 분기가 없는 평범한 시나리오를 바인딩한다 — 성공하면 **그룹 헤더·세로선·"공통" 머리글 같은 요소가 새로 생기지 않는다**(행 구조 동일, 변수명 열 폭만 넓어짐).
- **US5** — QA가 병렬 분기 변수를 쓰는 시나리오에 데이터셋을 붙여 실행하려 한다 — 성공하면 분기 변수가 "매핑되지 않음"으로 **잘못 표시되지 않고 [실행] 버튼이 살아 있다**.

> US4는 rev1의 "화면이 지금과 똑같다"에서 좁혔다 — §3.5가 분기 유무와 무관하게 모든 행 폭을 바꾸므로 원문은 §3.5와 모순이었고 "변경 전 스크린샷 대조"라는 통과 신호가 판정 불능이었다(리뷰 C1). 의도(새 UI 요소 불추가)는 그대로다.

---

## 1. 문제 (실측)

`scanFlowVars`(`scanVars.ts:62`)는 `{{checkout_branch.session_token}}` 같은 **네임스페이스 토큰을 통째로** 변수명으로 넘긴다(`splitFlowToken`은 cast만 떼고 네임스페이스는 유지 — `flowToken.ts:14`). 그 이름이 `DataBindingPanel.tsx:554`에서 `w-28`(112px) `truncate` 배지로 렌더된다.

12px mono 기준 콘텐츠 폭 ≈ 96px ≈ 13자 → `checkout_bran…`. **식별 정보가 접두사 뒤에 있는데 `truncate`가 뒤를 자른다.** 같은 분기 변수가 여럿이면 모든 행이 **시각적으로 동일**해져 구분이 불가능하다(US1).

부차적으로 분기와 무관한 긴 이름도 잘리고(US2), 에디터 test-run 매핑의 변수명 입력칸은 `w-32`(128px)라 한눈에 안 들어온다(US3).

**동거하는 선재 결함(R1)**: 같은 네임스페이스 행이 데이터셋 선택 시 **항상 "매핑되지 않음"으로 오판**되어 [실행]이 막힌다 — §3.6에서 함께 고친다.

**이미 있는 반례**: `VariablesPanel.tsx:350`은 같은 개념을 올바르게 렌더한다 — 접두사를 `text-slate-400` 흐린 mono `<span>`으로 **분리**하고 변수명 본체를 따로 둔다. 바인딩 패널만 통짜 문자열을 자르고 있다.

## 2. 범위

**포함**

| # | 표면 | 조치 |
|---|---|---|
| A | `DataBindingPanel` (RunDialog·ScheduleForm 공용) | 분기별 그룹 헤더 + 변수명 열 폭 확대 + 오류 힌트 정렬 정정 |
| B | `TestRunDatasetSection` (에디터 test-run) | 변수명 입력칸 폭 확대 |
| R1 | `DataBindingPanel` uncovered 판정 | 네임스페이스 생산자를 `availableElsewhere`에 union — 실행 차단 false-alarm 제거 (US5) |

- **오류 힌트 `ml-32`의 선재 8px 오차 정정은 폭 변경에 종속된 동반 수정**이다(어느 US에도 직접 안 걸리지만 §3.5를 하는 순간 물리적으로 같이 손대야 한다 — 리뷰 scope 문항 해소).

**비범위 (의도적)**

- B 화면의 **열(column) select 폭**(`w-32`) — 열 이름도 길 수 있으나 이번 보고 대상이 아니다. 수요 확인 후 별건.
- 자동 폭 맞춤(`ch` 단위 auto-fit) — 그룹핑이 주 원인을 제거하므로 불필요(YAGNI). 잔여 절단은 `title` 폴백.
- `VariablesPanel`의 기존 렌더 — 이미 옳다. **건드리지 않는다**(byte-identical).
- 바인딩 패널에 분기 변수를 아예 안 띄우는 방향 — 참조되는 변수를 숨기면 "왜 미매핑인지" 진단이 사라진다. 기각.

## 3. 설계

### 3.1 렌더 형태 (A 화면)

```
변수 매핑
  [username                ] [열: user_name (예: qa01) ▾] [×]
  [order_number_reference   ] [열: oid (예: A-1002)     ▾] [×]

  분기 checkout_branch                          ← 헤더 (접두사를 한 번만)
  │ [session_token          ] [열: token       ▾] [×]
  │ [order_id               ] [— 없음 —        ▾] [×]
```

- 헤더: `분기`(`text-xs text-slate-500`) + 분기명(`font-mono text-slate-600`) — 두 `<span>` 분리 렌더(`VariablesPanel:350`의 색 대비 관용구 계승). **분기명에 `truncate` + `title={branchName}`**(발의 원문이 "브랜치 이름이 길면"이므로 헤더 자체의 오버플로 정책이 필수 — 리뷰 R2).
- 그룹 본문 `<ul>`: `border-l-2 border-slate-200 pl-2`.
- 그룹 안 행의 변수명 배지는 **접두사 없는 `varName`만** 표시. `title`은 전체 `display`(`branch.var`) — 복사·검색 가능성 유지.

> **rev1 목업과의 차이**: rev1 §3.1은 분기 두 행 아래에 "매핑되지 않음 — …" 빨간 힌트를 정상 렌더로 그렸다. §3.6(R1) 편입으로 **그 힌트는 더 이상 뜨지 않는다.** 사용자에게 보낸 목업 HTML도 같은 오류를 갖고 있으므로 재발행한다.

### 3.2 그룹 판별 (정확성 핵심)

**"점이 있으면 분기"는 금지.** 오타 `{{ghost.token}}`을 존재하지 않는 분기로 접어버리고, `parallel-var-scope` 슬라이스가 이미 "점으로 쪼개 접미사 매칭 금지"를 못 박았다.

판별 소스 = **실제 분기가 생산하는 이름 집합**. `scanVars.ts`에 index 헬퍼를 추가한다:

```ts
/** display(`branch.var`) → 구조적 분해. 문자열 분해 없이 branch/var를 보존한다. */
export function namespacedProducerIndex(
  scenario: Scenario,
): Map<string, { branchName: string; varName: string }>;
```

- 순회 형태는 기존 `collectNamespacedProducers`(`scanVars.ts:160`)와 동일(top-level `parallel` → `branches` → `flattenHttpSteps` → `extract`).
- **`collectNamespacedProducers`는 `new Set(namespacedProducerIndex(s).keys())`로 재정의**해 순회 정의를 하나로 유지한다. 키 집합이 동일하므로 거동 불변.
- **기존 소비처는 4곳이다**(rev1은 3곳으로 적었다 — 리뷰 F3, 원인은 내 grep이 `grep -v "scanVars.ts:"`로 동일 파일 사용처를 스스로 가린 것):

  | 소비처 | 성격 |
  |---|---|
  | `varRows.ts:53` | 변수 패널 행 분류 |
  | `store.ts:217` | rename 충돌 검사 |
  | `store.ts:246` | 〃 |
  | **`scanVars.ts:300`** (`undefinedVarRefs` 내부) | **위치 인식 미정의 판정 — `parallel-var-scope`의 핵심.** correctness-critical |

  → 구현 task는 `scanVars.test.ts`(특히 `undefinedVarRefs` 참조 다수)를 **반드시 실행**해 회귀를 확인한다.

- **`parallelVarIdentities`(`:464`)를 쓰지 않는 이유**: 그 함수는 `flatProducerNames`+`collectBranchInternalRefs`+`buildVarRefIndex` **전체 스캔 3개**를 동반하는데(`scanVars.ts:465-467`) 여기 필요한 건 branch/var 분해뿐이다. 이 근거는 호출 위치(per-card vs 부모)와 **독립적으로** 성립한다 — 리뷰 C3은 "per-card `useMemo`로 돌 거면 비용 논거가 자기모순"이라 했으나, 같은 카드가 이미 `scanFlowVars`(`:305`)·`collectProducedVars`(`:308`)를 per-card `useMemo`로 돌고 있어 **이웃과 일관된 호출 위치를 유지**하는 편이 낫다(새 헬퍼만 부모로 올리면 불일치). **C3 기각** — 문구만 정정.

### 3.3 분할 순수 함수

신규 `ui/src/scenario/bindingGroups.ts`:

```ts
export type RowRef = { varName: string; manual: boolean };
export type BindingGroups<T extends RowRef> = {
  ungrouped: { row: T; idx: number }[];
  groups: { branchName: string; items: { row: T; idx: number; varName: string }[] }[];
};
export function partitionBindingRows<T extends RowRef>(
  rows: readonly T[],
  index: Map<string, { branchName: string; varName: string }>,
): BindingGroups<T>;
```

규칙:

1. `row.manual === true` → **항상 ungrouped**(D3).
2. `index.has(row.varName)` → 해당 `branchName` 그룹에, 표시명은 `index.get(...)!.varName`.
3. 그 외 → ungrouped, 표시명은 `row.varName`.
4. ungrouped는 원래 상대 순서 유지. 그룹은 **첫 등장 순**, 그룹 안도 원래 순서.
5. **`idx`는 원본 `rows` 배열 인덱스** — 그룹핑은 표시용 재배치일 뿐이다.
6. **R-INVARIANT (와이어)** — 두 계약으로 쪼갠다(rev2의 단일 규칙은 목적을 못 지켰다, 리뷰 N3):
   - **6a (함수 계약, 타입으로 보장)**: `partitionBindingRows`는 입력 `rows`를 변형·재정렬하지 않는다. 파라미터가 `readonly T[]`라 `rows.sort()`가 타입에서 막히고 순수 함수는 입력을 안 건드리므로 **어떤 정상 구현에서도 참**이다 → T1의 해당 단언은 회귀 가드가 아니라 **문서화 성격**(T7과 같은 등급). "정렬 추가 시 RED"를 실제로 잡는 건 *출력* 순서 단언(규칙 4)이다.
   - **6b (컴포넌트 계약, 실제 위험)**: payload가 깨지는 경로는 순수 함수가 아니라 **emit effect**(`DataBindingPanel.tsx:377-383`)다 — 누군가 그 루프를 `rows` 대신 partition 출력 순회로 리팩터하면 `mappings` 순서가 바뀌고 `data_bindings` → `profile_json` 바이트가 달라지는데, 순수 함수 테스트는 이를 **원리적으로 못 본다**. → T9에서 `onChange`가 emit한 `mappings` 순서를 단언해 잠근다(`rundialog-simple-detailed`의 `DEFAULT_SIMPLE_PROFILE` 선례).

### 3.4 인덱스 결합 (회귀 위험 지점)

`rows.map((row, idx) => …)`(`DataBindingPanel.tsx:531`) 콜백 안에서 **idx를 소비하는 지점이 8곳**이다(rev1은 2곳만 셌다 — 리뷰 R3):

| 줄 | 소비 |
|---|---|
| `:541` | `key={idx}` |
| `:550` | `updateRow` (manual varName) |
| `:594` / `:596` / `:598` | `updateRow` (source select 3분기) |
| `:626` | `updateRow` (literal 값) |
| `:633` | `removeRow` |
| `:634` | `removeMappingAria(row.varName \|\| idx)` — **varName이 빈 manual 행에서 idx가 접근명으로 노출**된다 |

그룹핑 후 `map`의 **지역 인덱스**를 넘기면 엉뚱한 행이 수정·삭제되고, `:634`는 접근명이 조용히 바뀌어 테스트 셀렉터까지 깨진다. §3.3의 `idx`(원본 인덱스)를 **이 8곳 전부에** 그대로 전달한다. `key`는 idx보다 안정 식별자가 낫지만 현행 유지(범위 밖).

### 3.5 폭·정렬

| 대상 | 현재 | 변경 |
|---|---|---|
| 변수명 배지 (`:554`) | `w-28` (112px) | **`w-48` (192px)** |
| manual 행 입력 (`:547`) | `w-28` | **`w-48`** |
| 오류 힌트 (`:643,648,653`) | `ml-32` (128px) | **`ml-[200px]`** |
| B 변수명 입력 (`TestRunDatasetSection.tsx:406`) | `w-32` (128px) | **`w-64` (256px)** — rev2, 아래 참조 |

> **rev2 정정 (2026-07-29, 라이브 실측)**: 이 칸은 최초 `w-56`(224px)로 고정했으나, 머지 전 라이브 검증에서 **US3가 실제로 실패**했다. B 화면은 A 화면과 달리 그룹핑이 없어 점 붙은 전체 이름이 그대로 들어가는데, 슬라이스를 촉발한 바로 그 이름 `checkout_branch.session_token`이 입력칸의 실제 폰트(14px `ui-sans-serif`, **mono 아님**)로 **209px**인 반면 `w-56`의 콘텐츠 폭은 224 − 18 = **206px** → `scrollWidth 225 > clientWidth 222`로 3px 초과. Windows Segoe UI는 더 넓어 여유가 더 줄어든다. `w-64`(콘텐츠 238px)로 올려 **+29px** 여유 확보. 사용자 재가로 "폭 상수 변경 금지" 제약보다 **라이브 실측이 지배**한다고 판정. (43자 `inventory_reservation_branch.reservation_id` = 288px는 `w-64`로도 안 들어간다 — B 화면 그룹핑은 비목표이므로 알려진 한계로 남긴다.) **위 배지 산술이 12px mono 기준인 것과 달리 이 칸은 14px sans라 자당 폭이 더 크다** — 두 표를 같은 환산으로 읽지 말 것.

**폭 산술 (rev1 오류 정정 — 리뷰 F2)**: Tailwind preflight가 `box-sizing: border-box`이고 배지는 `px-2`(16px)+`border`(2px)를 가지므로 **콘텐츠 폭 = 전체 − 18px**이다. rev1은 §9-5에서 이 18px을 다시 빼지 않아 "24자"를 얻었다.

| 값 | 전체 | 콘텐츠 | 12px mono 환산(7.2–7.38px/자) |
|---|---|---|---|
| `w-44` | 176px | 158px | **21.4–21.9자** |
| `w-48` | 192px | 174px | 23.6–24.2자 |

US2 예시 `order_number_reference`는 **22자 = 158.4px**로 `w-44`(158px)를 **0.4px 초과**한다 → §8의 `scrollWidth <= clientWidth`(1px 해상도) 판정이 플랫폼 의존 플레이크가 된다. 따라서 **`w-48`을 채택**한다. 힌트 값 200px = 배지 192px + `gap-2` 8px.

`truncate` + `title`은 유지(최후 폴백). **현재 `ml-32`(128px)는 112+8=120px과 8px 어긋나 있다** — 폭을 바꾸는 김에 정정한다.

**정렬 단서의 한계(리뷰 R7)**: `ml-[200px]`는 **배지 행에 정확**하다. manual 입력(`:547`)은 `shrink-0`이 없어 flex 압력에서 줄어들 수 있는데 `stale`(`:647`)·`conflict`(`:652`) 힌트에는 `!row.manual` 가드가 없어 manual 행에서도 렌더된다 → 그 행에선 어긋날 수 있다. **선재 문제이고 이번에 고치지 않는다**(§9-6).

### 3.6 R1 — 네임스페이스 행 실행 차단 false-alarm (US5)

**증상**: 병렬 분기 시나리오에서 데이터셋을 고르면 `{{분기.변수}}` 행이 항상 "매핑되지 않음"으로 표시되고 [실행]이 비활성된다.

**원인 체인 (실측)**

1. `availableElsewhere = collectProducedVars(scenario)` (`DataBindingPanel.tsx:308`)
2. `collectProducedVars`(`scanVars.ts:151`)는 docstring 그대로 **bare 이름만** 담는다 — `flattenHttpSteps`가 분기까지 하강해도 `e.var`는 bare다.
3. `scanFlowVars`는 dotted 키(`checkout_branch.session_token`)를 넘긴다 → `availableElsewhere.has(dotted)`는 **항상 false**.
4. → uncovered 사유 emit (`:393` 목록, `:430` per-row) → `bindingBlock.ok === false` → `RunDialog.tsx:448/456/464/472`의 **4개 모드 arm 전부**에서 제출 게이트가 닫힌다.
5. 게이트는 `if (!selectedId) { emitValidity([]); return; }`(`:368-372`) 뒤에 있으므로 **데이터셋을 선택했을 때만** 발화한다 = 정확히 이 기능의 실사용 케이스.

**수정** — `:308` 한 곳:

```ts
const availableElsewhere = useMemo<Set<string>>(
  () => new Set([...collectProducedVars(scenario), ...collectNamespacedProducers(scenario)]),
  [scenario],
);
```

**왜 오탐인가**: 엔진은 `join_all` 후 분기 출력을 `{branch}.{var}`로 병합해 다운스트림에 공급한다(ADR-0033). 즉 그 값은 **실제로 이미 공급된다** — "데이터셋에서 매핑해야 한다"는 판정이 거짓이다.

**정밀성**: 생산자 집합에 없는 dotted 이름(오타 `ghost.token`)은 **여전히 uncovered로 잡힌다**. 가드가 약해지지 않는다.

**범위 신호**: `:308`은 `:393`(목록 사유)과 `:430`(행 빨간 표시) 양쪽이 공유하므로 한 곳 수정으로 둘 다 해소된다(`:416`은 deps 배열).

**방어 근거 3종 (리뷰 2차 실측 — "extract가 실패하면?"으로 흔들리지 않게 미리 못 박는다)**

1. **서버에 대응 게이트가 없다.** run 생성 검증(`crates/controller/src/api/runs.rs:428-511`)은 바인딩 개수 상한·교차 바인딩 var 유일성(`crates/controller/src/binding.rs:42` `collect_var_names`)·데이터셋 존재·행수만 본다. "모든 스캔 변수가 covered" 규칙은 **없다** → 클라 게이트를 푼다고 나중에 400으로 되돌아오지 않는다. **UI-only 수정으로 완결**된다.
2. **union의 낙관성은 기존과 동치다.** `runner.rs:672` `join_all` → `:690` `iter_vars.insert(format!("{}.{}", branch.name, k), …)`인데 `:689`가 `if let Some(v) = branch_vars.get(k)`라 **extract가 런타임에 실패하면 그 키는 안 생긴다** → union은 낙관적이다. 그러나 이는 `collectProducedVars`가 flat extract를 런타임 성공 여부와 무관하게 covered로 치는 것과 **정확히 같은 수준의 낙관**이라 새 구멍이 아니다.
3. **확립된 정책에 정렬하는 것이다.** `scanVars.ts:292-294`가 이미 "namespaced 참조는 위치 무관하게 전역 해석 — **의도된 false-negative, 고치지 말 것**"을 명문화했다. union은 바인딩 패널을 그 정책에 맞추는 것이지 임의 완화가 아니다.

## 4. 결정 기록

| # | 결정 | 근거 |
|---|---|---|
| D1 | "분기 없음/공통" 그룹을 **만들지 않는다** | 비분기 변수가 다수. 분기 변수 0개 → 그룹 블록 부재(US4가 관찰 조건으로 고정) |
| D2 | 그룹은 ungrouped **뒤**에 | 예측 가능한 단순 규칙. 접두사 반복 제거 이득이 순서 변화보다 크다(§9-1) |
| D3 | manual 행은 **절대 그룹핑하지 않는다** | 자유 입력칸이다. 타이핑 중 `checkout.`을 치는 순간 행이 그룹으로 **점프**하면 포커스·커서가 깨진다 |
| D4 | 판별은 `namespacedProducerIndex`, `split(".")` 금지 | 오타를 가짜 분기로 접지 않기 위해. 분기명에 점이 있어도 안전 |
| D5 | 자동 폭(`ch` auto-fit) 미채택 | 그룹핑이 주 원인을 제거. 고정 폭 확대로 충분 |
| D6 | `VariablesPanel` 0-diff | 이미 옳은 렌더. 공유 컴포넌트 추출은 범위 밖(§9-4) |
| D7 | R1을 이 슬라이스에 편입 | 리뷰어는 분리 권고였으나 **사용자 결정으로 편입**. 고치지 않으면 US1("부하를 실행하려 할 때")이 라이브에서 참이 될 수 없다 — 읽을 수는 있는데 실행은 막힌 화면이 산출물이 된다 |
| D8 | 접근명은 **조립형** | `aria = visible + 꼬리`로 만들어 드리프트를 구조적으로 봉쇄(§5, 리뷰 R9) |

## 5. 카피 (`ko.binding`)

```ts
branchGroupLead: "분기",  // 헤더 앞머리 (흐린 색). 가시 텍스트 = `분기 {branchName}`
// 접근명은 가시 텍스트를 재사용해 조립한다 (D8):
//   const visible = `${ko.binding.branchGroupLead} ${branchName}`;
//   aria-label = `${visible} ${ko.binding.branchGroupAriaTail}`
branchGroupAriaTail: "변수 매핑",
```

- **조립형인 이유(D8)**: 독립 키 2개(`분기 {b}` / `분기 {b} 변수 매핑`)로 만들면 한쪽만 고쳐 드리프트가 난다. 가시 텍스트를 **한 번만** 만들고 접근명이 그걸 재사용하면 `aria ⊇ visible`(WCAG 2.5.3)이 **구조적으로 참**이 된다(scenario-preflight 최종리뷰 fold-in 처방).
- `sourceForAria`/`removeMappingAria`는 **전체 `display`를 계속 쓴다** — 접근명에서 `session_token`만 나오면 다른 분기의 동명 변수와 구별 불가.

**충돌 검사 — 실행 결과 (2026-07-29 실측)**

`grep -n '"[^"]*분기' ui/src/i18n/ko.ts` → 값이 **정확히 `"분기"`인 기존 키가 3개**: `editor.variableBranch:509`(`VariablesPanel.tsx:405`)·`editor.branchesLabel:651`·`report.colBranch:1020`.

- **값 중복 자체는 수용** — 네임스페이스 분리가 이 카탈로그의 규약이고 기존에도 3중복이다. 기존 키를 재사용하지 **않는다**.
- **rev1의 거짓 문장 삭제(리뷰 F1)**: rev1은 "새 접근명은 기존 값의 부분문자열도 아니고 **그 역도 아니다**"라고 썼는데 **역방향은 참이다** — `"분기"`는 `분기 checkout_branch 변수 매핑`의 부분문자열이다.
- **귀결 ①(RTL)**: `/분기/` 같은 느슨한 정규식 금지. §7 T6은 구조를 세는 형태로 판정한다.
- **귀결 ②(라이브 — rev1에 없던 위험)**: RunDialog 표면에 `trust.runDialogBFailCond`(`ko.ts:1602`, "…의도한 분기를 타지 않습니다")가 신뢰도 배너로 렌더될 수 있다(`RunDialog.tsx:1062`). **Playwright `getByText`/`getByLabel`은 기본 substring 매칭**이라 이 배너를 잘못 집는다 → §8 라이브 셀렉터는 `exact: true` 또는 그룹 `<ul>`의 role+정확 접근명으로 잡는다.

## 6. 파일 영향 요약

| 파일 | 성격 |
|---|---|
| `ui/src/scenario/bindingGroups.ts` | **신규** — `partitionBindingRows` 순수 함수 (§3.3) |
| `ui/src/scenario/scanVars.ts` | `namespacedProducerIndex` 신규 export + `collectNamespacedProducers` 재정의 (§3.2). **동일 파일 내 `undefinedVarRefs:300`이 소비자** |
| `ui/src/components/DataBindingPanel.tsx` | 그룹 렌더·폭·힌트 정렬(§3.1·3.5) + `availableElsewhere` union(§3.6) |
| `ui/src/components/scenario/TestRunDatasetSection.tsx` | 변수명 입력 `w-32` → `w-56` |
| `ui/src/i18n/ko.ts` | `binding` 네임스페이스 키 2개 |
| `ui/src/scenario/__tests__/scanVars.test.ts` | 회귀 확인 대상(수정은 불필요 예상) |
| 서버·proto·엔진·store·migration | **0-diff** |

## 7. 테스트 계획

**이빨 실증 의무** — 회귀 가드를 표방하는 항목은 **고의 회귀 → RED → 원복 → GREEN**을 실행해 증명한다(메모리 `plan-mandated-vacuous-tests`).

| # | 대상 | 내용 | 이빨 실증 |
|---|---|---|---|
| T1 | `partitionBindingRows` | 분기 2 + 비분기 2 혼합 → 분할·**출력 순서**·원본 idx. (입력 무변형 단언 = 규칙 6a는 문서화 성격) | 출력 순서 단언이 정렬 회귀를 잡음 |
| T2 | 〃 | 오타 `ghost.token`(index 미등재)은 **ungrouped** | D4 무력화 시 RED |
| T3 | 〃 | `manual: true` 행은 `varName`이 index에 있어도 ungrouped | D3 제거 시 RED |
| T4 | `DataBindingPanel` | 그룹 안 행의 `×`가 **그 행만** 지운다 + 그룹 안 source select 변경이 **형제 행을 안 건드린다**(update 경로도 — R3) | 지역 idx로 바꾸면 RED |
| T5 | 〃 (US1) | 분기 두 배지가 `toHaveTextContent(/^session_token$/)`·`/^order_id$/` + **접두사 문자열 부재** | 접두사 제거 로직 되돌리면 RED |
| T6 | 〃 (US4) | 분기 0개 → `getAllByRole("list")` 길이 **1** + 접근명 있는 리스트 **0개** | D1 위반(공통 그룹 생성)·무조건 헤더 둘 다 RED |
| T7 | 〃 | 그룹 `<ul>` 접근명이 DOM에서 뽑은 가시 헤더 텍스트로 `startsWith` | (D8로 구조적 참 — 문서화 성격) |
| T8 | 〃 | 폭·정렬 클래스 토큰 락인 — `className.split(/\s+/)`으로 배지 `w-48` **+ 오류 힌트 `<p>`의 `ml-[200px]`** 확인 | 값 되돌리면 RED |
| T9 | 〃 (US5) | 네임스페이스 변수 + 데이터셋 선택 → `onValidityChange`가 **빈 배열** / 오타 `ghost.token`은 **여전히 사유 emit** / **`onChange`가 emit한 `mappings` 순서 = `rows` 순서**(규칙 6b) | union 제거하면 RED · emit 루프를 partition 출력 순회로 바꾸면 RED |

**공허 함정 주의 (실측 반영)**

- **T5**: rev1은 "두 배지 textContent가 서로 다름"을 이빨로 적었으나 **거짓이었다**(리뷰 F4) — 현 결함은 CSS `truncate`에 의한 **시각** 절단이고 jsdom엔 레이아웃이 없어 `textContent`는 지금도 다르다. 그 비교는 어떤 구현에서도 GREEN. → 정확매치 + 접두사 부재로 교체.
- **T6**: rev1은 "분기 0개 시나리오에서 `분기 checkout_branch 변수 매핑` 접근명이 없다"였으나 **분기가 없으면 그 이름의 리스트는 원리적으로 생길 수 없어** 어떤 구현에서도 통과한다(리뷰). → "살아있는 구조를 세는" 형태로 교체("은퇴 라벨의 부재가 아니라 살아있는 라벨의 유일성" — `editor-ux-polish` 선례).
- **T8**: 토큰 분리 비교 필수 — raw `toContain("w-48")`은 `max-w-48` 류에 false-green(`editor-viewport-polish-v2` 함정). 단 이 단언은 **클래스 값이 바뀌었다는 것만** 증명하고 실제 가시성은 §8 라이브가 판정한다.
- **T4 픽스처 조건**: 지역 idx ≠ 원본 idx가 성립해야 이빨이 있다 → 픽스처에 **그룹 앞 ungrouped 행이 1개 이상** 있어야 한다(전부 분기 변수면 그룹 첫 항목의 지역 idx 0 == 원본 idx 0이라 버그를 주입해도 GREEN — 리뷰 R4).
- **T9 픽스처 조건 ② — 6b 단언의 이빨 (리뷰 3차)**: `mappings` 순서 단언(규칙 6b)이 회귀를 잡으려면 **`partition 순서 ≠ rows 순서`**여야 한다. 즉 픽스처는 ⓐ 분기 행 **1개 이상이 열에 매핑**되고 ⓑ **스캔 순서상 그 뒤에 오는 비분기 행도 매핑**돼야 한다(예: parallel 노드 *뒤* 스텝이 참조하는 `late_var`). 둘 중 하나라도 빠지면 partition 순회 결과와 `rows` 순회 결과가 **같은 배열**이 되어 고의 회귀를 넣어도 GREEN이다. → CSV 픽스처에 분기 변수를 받을 열(`token`)이 필요하다(§8과 §3.1 목업도 이 열을 전제한다).
- **T9 픽스처 조건 ① (리뷰 N1)**: `reasons`는 uncovered ∪ (datasetGone | staleCols)다(`DataBindingPanel.tsx:401-408`). 픽스처의 **비분기 변수가 covered여야** "빈 배열"이 성립한다 — `variables:` 선언 또는 extract로 공급하거나 열 이름을 변수명과 **동일하게** 지어 auto-match(`:346-365`, `columnSet.has(r.varName)` = 이름 **동일** 요구)가 걸리게 한다. 안 그러면 union과 **무관한** 사유(`{{username}} 변수의 열을 선택하거나…`)가 남아 T9가 RED가 되고, 구현자가 단언을 `not.toContain("checkout_branch")` 류로 후퇴시키기 쉽다(= 조용한 약화).

**신규 픽스처 비용(리뷰 R8)**: `DataBindingPanel.test.tsx`의 기존 픽스처 3종(`:26`/`:51`/`:73`)은 전부 http 단일 스텝이다. T4–T9는 `parallel` + `branches[].steps[].extract` + 다운스트림 `{{B.v}}` 참조를 가진 **새 Scenario 픽스처**가 필요하다(유효 ULID — I/L/O/U 제외).

**기존 테스트 영향 — 실측 결과 (2026-07-29)**

- **`<ul>`/list 구조 결합**: `getByRole("list")`·`listitem`·`closest("ul"|"li")` **0건** → 단일 `<ul>`을 쪼개도 안 깨진다.
- **행 순서 결합**: 인덱스 접근은 전부 **카드 레벨**(`:657-658`·`:687-688`·`:699/704`)이고 매핑 행 쿼리는 이름 기반이다 → 그룹핑 재배치(D2)로 안 깨진다.

가설이므로 **구현 task는 기존 스위트를 실제로 돌려 확인한다**(`DataBindingPanel`·`TestRunSection.dataset`·`scanVars` 최소 3파일 + 머지 전 인자 없는 전체 `pnpm test` 1회).

## 8. 라이브 검증 계획

**마운트 경로 전수 (실측)** — A = `RunDialog.tsx:782` · `ScheduleForm.tsx:420` **2곳**, B = `TestRunSection.tsx:122` ← `ScenarioEditPage.tsx:277` · `ScenarioNewPage.tsx:146` **2 페이지**. 총 **4 표면**(rev1은 "세 표면"으로 잘못 셌다 — 리뷰 C4·R5). 메모리 `live-verify-all-mount-paths`: 한 화면만 보면 그 화면이 우연히 정상인 버그를 놓친다.

| US | 진입 | 통과 신호 |
|---|---|---|
| US1 | `/scenarios/{id}/runs` → [실행하기] → 데이터 바인딩 | 분기 두 행이 `session_token`/`order_id`로 다르게 보임 + 헤더 `분기 checkout_branch` **1회** |
| US1' | 스케줄 편집 → 같은 패널 | 위와 동일 (두 번째 A 마운트) |
| US2 | 같은 패널, 비분기 22자 이름 | `order_number_reference` 전체 표시 — **`scrollWidth <= clientWidth` 실측**(DOM 텍스트 존재만으로 PASS 금지) |
| US3 | `/scenarios/{id}` → 미리 실행 → 데이터셋 매핑 | `input.scrollWidth <= input.clientWidth` |
| US3' | **`/scenarios/new`** → 같은 섹션 | 위와 동일 (두 번째 B 마운트) |
| US4 | 분기 없는 시나리오로 데이터 바인딩 | 그룹 헤더·세로선 **부재** + 행 수 동일 (스크린샷 대조 아님 — §US4 각주) |
| US5 | US1 화면에서 데이터셋 선택 → **비분기 2행에 열을 먼저 매핑** | 분기 행에 "매핑되지 않음" **미표시** + **[실행] 버튼 활성** |

- **US5의 "비분기 행 열 매핑 선행"은 생략 불가(리뷰 N2)**: auto-match는 **변수명 == 열 이름**일 때만 걸린다(`:346-365`). 아래 픽스처는 열이 `user_name`/`oid`라 `username`/`order_number_reference`와 다르므로 auto-match가 안 되고, 그 두 행이 uncovered로 남아 **[실행]이 §3.6 수정과 무관하게 계속 비활성**이다 → 매핑 선행 없이는 US5가 false-FAIL 난다. (§3.1 목업도 `username → 열: user_name`을 매핑된 상태로 그리고 있어 일관된다.)
- **오타 `{{ghost.token}}` 가드 생존 확인은 라이브에서 생략한다(리뷰 N6)** — RunDialog에서 시나리오를 편집할 수 없어 에디터 왕복 2스텝이 필요한데, **T9의 두 번째 단언이 이미 동일한 것을 커버**한다.
- **라이브 픽스처(필수 — rev1엔 없었다)**: parallel 노드 1개 + 분기 `checkout_branch`가 `session_token`·`order_id` extract + 다운스트림 `{{checkout_branch.session_token}}` 참조 + 비분기 변수 `username`·`order_number_reference`를 가진 시나리오 YAML, 그리고 **`user_name`·`oid`·`token` 3열**을 가진 CSV(`token`은 §3.1 목업의 `session_token → 열: token` 매핑과 T9 6b 픽스처 조건 ②가 함께 요구한다).
- **셀렉터 주의**: §5 귀결 ②대로 `분기` substring 매칭 금지 — Playwright는 `exact: true` 또는 role+정확 접근명.
- `getBoundingClientRect`/`scrollWidth` 실측을 권위로 쓴다(메모리 `implementation-rigor-over-spec`).

## 9. 알려진 한계 (수용)

1. **분기 그룹이 흐름 순서 뒤로 밀린다**(D2). 시나리오 앞쪽 parallel의 변수가 목록 아래로 간다. 접두사 반복 제거 이득이 더 크다.
2. **서로 다른 parallel 노드가 같은 분기명을 쓰면 한 그룹으로 합쳐진다.** `display`가 같아 구조적으로 구분 불가. 엔진도 같은 네임스페이스를 쓰므로 오히려 정확하다.
3. **그룹 안 배지는 접두사를 안 보여준다** — 화면을 복사해 YAML에 붙이려는 사용자는 헤더를 함께 읽어야 한다. `title`이 전체 `display`를 유지해 완화.
4. **`VariablesPanel`과 공유 컴포넌트로 수렴하지 않았다**(D6). 표현 의도는 같지만 구조(행 안 인라인 vs 그룹 헤더)가 달라 지금 추출하면 과도한 추상이다. 세 번째 소비처가 생기면 검토.
5. **긴 이름은 여전히 잘린다** — 한계가 **행 종류마다 다르다**(리뷰 N5): 스캔 행 배지는 `text-xs`(12px)라 174px ÷ 7.2–7.38 ≈ **24자**, manual 행 입력(`:547`)은 `text-sm`(14px mono ≈8.4px/자)이라 ≈ **20자**다. US2 예시(22자)는 배지 행이라 안전하지만, 프리셋 복원으로 같은 이름이 manual 행이 되면(`seedRows` `:66`) 잘린다. `title` 폴백. D5의 수용된 귀결. *(rev1의 "24자@w-44"는 패딩·보더 18px을 두 번 빼지 않은 산술 오류였다 — §3.5)*
6. **manual 행의 힌트 정렬은 어긋날 수 있다**(§3.5 R7). manual 입력에 `shrink-0`이 없고 `stale`/`conflict` 힌트에 `!row.manual` 가드가 없는 **선재 문제**로, 이번 범위 밖이다.
7. **`key={idx}`를 안정 식별자로 바꾸지 않았다**(§3.4). 현행 유지 — 별건.
