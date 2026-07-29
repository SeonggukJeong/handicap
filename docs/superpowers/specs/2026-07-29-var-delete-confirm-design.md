# 사용중인 변수 삭제 확인 — 설계

- 날짜: 2026-07-29 · 슬라이스: `var-delete-confirm` (사용자 발의)
- 유형: user-path · UI-only 소형 (서버/proto/store/migration/모델·와이어 **0-diff**)
- ADR: 불요 (모델·와이어 불변, 기존 `Modal`/`Button` 프리미티브 재사용)

## 사용자 스토리 (US)

- **US1 (실수 방지)**: QA가 여러 스텝이 참조하는 선언 변수를 정리하다 `×`를 눌렀을 때, 실수로 시나리오를 깨뜨리지 않으려 한다 — 성공하면 변수가 즉시 사라지는 대신 확인 모달이 뜨고, 취소하면 변수와 그 값이 그대로 남아 있는 것을 본다.
- **US2 (판단 근거)**: QA가 그 확인 모달 앞에서 "이걸 지워도 되나"를 판단하려 한다 — 성공하면 모달 안에서 그 변수를 참조하는 스텝 목록(메서드 배지 + 이름, IF는 조건 요약)을 보고 다른 화면으로 이동하지 않고 결정한다.
- **US3 (마찰 없음)**: QA가 쓰지 않는 변수 여러 개를 한 번에 정리한다 — 성공하면 "미사용"으로 표시된 변수는 **확인 모달 없이 `×` 한 번으로 사라진다**.
- **US4 (거짓말 없음)**: QA가 YAML이 깨진 상태(빨간 검증 배너)에서 변수를 지우려 한다 — 성공하면 `×`가 ✎·"선언 추가"와 같이 비활성이라, 확인 모달을 통과하고도 아무 일이 안 일어나는 상황을 겪지 않는다.

판정 기준(전 US 공통): **"사용중" = 그 행의 `refIds.length > 0`** — 패널이 이미 "N개 스텝에서 사용"(`ko.editor.variableUsage`)으로 세는 바로 그 값이다. 새 판정 축을 만들지 않는다.

> US3의 성공 조건은 브레인스토밍 승인본의 "정리 속도가 지금과 같다"를 **관찰 가능한 형태로 조인 것**이다(속도는 제3자가 동의할 증거가 없다). 의도·범위는 동일하다.

## 배경 · 현재 동작

- `VariablesPanel.tsx:249`의 `onClick={() => removeVariable(row.name)}` — **확인도 되돌리기도 없이 즉시 삭제**. `removeVariable` 호출처는 이 한 곳뿐(`grep` 확인).
- 삭제되면 그 이름의 `{{...}}` 참조들은 ⚠ "정의안됨"(`variableUndefined`) 행으로 떨어진다. **실행 시 결과는 참조 위치에 따라 다르다**:
  - **요청 표면**(url·헤더·바디): `template.rs`의 엄격 `render`가 `EngineError::UnknownVar`를 내고, 그 에러는 `executor.rs:137`(url·헤더 `:140`·바디 `:172,:177`)의 `?`로 전파돼 **그 스텝을 실행한 VU가 죽는다** — 기본 closed-loop 경로는 `run_vu`(`runner.rs:372`, doc `:467` "Returns `Err` only for genuine engine errors (template/header build failures)")가 `Err`를 올리고 호출부(`:201`)가 그것을 받아 `failed.fetch_add`(`:243`)로 센다. VU 곡선 경로의 쌍둥이는 `run_vu_curve`(`:1064`)의 `:1176`(`return Err(e); // genuine engine error → permanent VU death`). 실패 VU가 전체 VU 수에 도달하면 run 자체가 `EngineError::AllVusFailed`(`:352`)로 **실패**한다. 즉 "요청 하나 실패"가 아니라 **전멸**이 기본 시나리오다(루트 CLAUDE.md의 "요청 표면=전멸" 어휘, 직전 슬라이스 라이브 기록 "즉시 failed `unknown variable ghost`"와 동일).
  - **조건 오퍼랜드**(`if`/`elif`): `condition.rs:20,26`의 `eval_compare`가 `render_lenient`(`template.rs:33`)를 쓴다 — 미해결 토큰은 **빈 문자열**이 되고 `render_lenient`는 "condition evaluation must never kill a run"이라 doc에 못 박혀 있다. 즉 **run은 완주하고 분기만 조용히 잘못 간다**. 이건 직전 슬라이스 `4723e06`(trust-check-precision)가 preflight spec에 정정 각주 5곳을 단 바로 그 사실이므로, 이 spec도 같은 구분을 지킨다.
- 삭제 대상 행(`kind: "declared"`)은 `refIds`를 이미 들고 있다(`varRows.ts:64` — `refIndex.get(name) ?? []`). `buildVarRefIndex`(`scanVars.ts:98`)는 스텝당 `Set`으로 모아 `record(s.id, refs)` 하므로 **한 스텝은 이름당 한 번만** 들어간다 = `refIds`에 중복 id 없음(React `key` 충돌 없음, `VarUsagePopover`가 이미 이 성질에 의존).
- `refIds`가 커버하는 참조: url·헤더·raw/form/json 바디 + `if`/`elif` **조건 오퍼랜드**(`collectCondRefs`) + loop/parallel 하강. 즉 조건에서만 쓰이는 변수도 "사용중"으로 잡히며, 위 두 실패 양상 중 **조용한 오분기** 쪽에 해당한다.
- 확인 UI 자산은 이미 있다: `ui/src/components/Modal.tsx`(portal·포커스 트랩·ESC·backdrop·포커스 복원, props `{open, onClose, title, children}`), `ui/src/components/Button.tsx`(`primary | secondary | danger`). **둘 다 ADR-0043 프리미티브 디렉토리 `ui/src/components/ui/`가 아니라 `ui/src/components/` 직하에 있다.** 문구는 `ko.common.cancel`(`ko.ts:17`)="취소" / `ko.common.delete`(`:19`)="삭제".
- 사용처 목록 렌더 로직도 이미 있다: `VarUsagePopover.tsx:89-118`(`findStepById` → http면 `METHOD_BADGE`, if면 `IF` + `summarizeCondition`, 그 외 찾은 스텝은 `s.name`, 못 찾으면 raw id).

## 브레인스토밍 확정 사항

- **형태 = 모달 + 사용처 목록** (사용자 선택 2026-07-29). `window.confirm` 한 줄·행 인라인 확인은 기각 — 전자는 목록/서식 불가, 후자는 좁은 변수 열(≈184px)에서 줄바꿈 압박.
- **문구 정밀도 = 가능성 문구 하나로 통일** (사용자 선택). 근거: 선언 변수는 반복 시작 시 시드되고(`runner.rs`의 `seed_iter_vars`) extract는 실행 중 덮어쓰므로, "덮어쓰는 extract가 있으니 안전"은 **거짓**이다 — extract 스텝보다 **앞선** 참조는 위 두 양상 중 하나로 깨진다. 그 순서 판정은 loop 반복 회차·parallel 동시성·조건 분기 실행 여부 때문에 정적으로 모호하므로 정밀 계산(위험 참조 개수)은 기각. 정밀 진단은 이미 실행 전 preflight(신뢰도 칩/`TrustBoard`, ADR-0049)가 담당한다.
- **단일 문장이되 두 양상을 모두 포괄한다**: 문구를 요청/조건으로 **분기하지 않는다**(사용자 결정 유지). 대신 한 문장이 두 결과를 다 덮게 쓴다(R6) — 요청 표면만 말하면 cond-only 변수에게 거짓 경고를 하고 진짜 위험(조용한 오분기)을 숨기게 된다.
- **미사용 변수는 현행 유지**(확인 없이 즉시 삭제) — US3.
- **목록 항목은 클릭 불가**: 모달에서 스텝으로 점프하면 삭제 흐름이 끊긴다. 점프가 필요하면 기존 "N개 스텝에서 사용" 팝오버가 그 역할을 이미 한다.

## 요구사항

### R1. 트리거 분기 (`VariablesPanel`)

- declared 행 `×`의 `onClick`을 다음으로 교체:
  - `row.refIds.length === 0` → `removeVariable(row.name)` **즉시**(현행과 동일 경로·동일 부작용).
  - `row.refIds.length > 0` → ① `setUsageNav(null)` ② 로컬 state `pendingDelete = { name: row.name, refIds: row.refIds }` 세팅. 모델 무변이.
- **`setUsageNav(null)`이 트리거 시점에 필요한 이유**: 사용처 팝오버가 열린 채 모달이 뜨면 두 목록이 겹치고(둘 다 `z-50`: `VarUsagePopover.tsx:86-87` / `Modal.tsx:66`), ESC가 **둘 다** 닫으며(두 리스너 모두 `document` capture — `Modal.tsx:55`, `VarUsagePopover.tsx:72` — 이고 `Modal.tsx:35`는 `stopPropagation()`이라 같은 노드의 다른 리스너를 못 막는다), 모달 내부 첫 pointerdown이 팝오버의 outside-close를 발화한다.
  - **도달 경로는 키보드 활성화뿐이다**: 마우스로 `×`를 누르면 `VarUsagePopover.tsx:61-64`의 `pointerdown` capture 리스너가 이미 팝오버를 닫는다. Enter/Space로 `×`를 활성화하면 `pointerdown`이 발생하지 않아 팝오버가 살아남는다. **이 사실이 테스트 설계를 지배한다**(테스트 §9 참조).
- `pendingDelete`는 `VariablesPanel` 로컬 `useState<{ name: string; refIds: string[] } | null>(null)`. store·영속화 없음.
- `refIds`는 **열 때 스냅샷**으로 보관한다(행 객체를 들지 않는다). 라벨은 live `steps`에서 매 렌더 도출되므로 **동결은 refIds에만 적용된다** — 이는 순수 방어이며, 실제로는 모달 backdrop(`Modal.tsx:66`, `fixed inset-0`)이 모든 상호작용을 가로채고 에디터에 모델을 재시드하는 폴링이 없어 모달이 열린 동안 모델이 바뀌는 경로는 사실상 없다.

### R2. 사용처 항목 서술 헬퍼 추출 (드리프트 차단)

신규 모듈 `ui/src/components/scenario/stepRefLabel.ts`:

```ts
export interface StepRefDesc {
  /** 배지 — http=메서드, if="IF", 그 외/미발견=null */
  badge: { text: string; colorClass: string } | null;
  /** 표시 라벨 — http=스텝 이름, if=조건 요약, 그 외=스텝 이름, 미발견=raw id */
  label: string;
}
export const STEP_REF_BADGE_CLASS = "shrink-0 rounded px-1 font-mono text-[10px]";
export function describeStepRef(steps: Step[], id: string): StepRefDesc;
```

규칙은 `VarUsagePopover.tsx:89-118`의 현재 코드가 정본이다(바꾸지 말 것) — **4케이스**:

| 케이스 | badge | label |
|---|---|---|
| `s.type === "http"` | `{ text: s.request.method, colorClass: METHOD_BADGE[s.request.method] ?? "bg-slate-100 text-slate-600" }` | `s.name` |
| `s.type === "if"` | `{ text: "IF", colorClass: "bg-slate-100 text-slate-500" }` | `summarizeCondition(s.cond)` |
| 찾았으나 그 외(loop·parallel) | `null` | **`s.name`** (loop/parallel 모두 `name` 보유 — `model.ts:172-182`, `:219-227`) |
| `findStepById` 미발견 | `null` | `id` |

- 3번째 케이스는 현재 **도달 불가**다(`buildVarRefIndex`가 http `scanVars.ts:118`·if `:127`의 id만 기록). 그럼에도 명시하는 이유는 이 헬퍼가 두 표면의 정본으로 격상되기 때문 — `label: id`로 잘못 못 박으면 나중에 refIds 소스가 넓어질 때 ULID가 노출된다.
- **`VarUsagePopover`도 이 헬퍼로 전환**한다(복제 금지 — 두 표면이 갈라지면 같은 변수의 사용처가 화면마다 달라 보인다).
- **시각 회귀 주의**: 현재 `if` 배지 className은 `shrink-0 rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-500`(`VarUsagePopover.tsx:109`)로 `bg-slate-100`이 중간에 있다. 재조립하면 `STEP_REF_BADGE_CLASS + " " + colorClass`가 되어 **토큰 집합(7개) 동일·순서만 다르다**(충돌 유틸리티 없음 → computed style 동일). http 배지(`:103`)는 순서까지 동일. 따라서 className 단언은 raw 문자열 `toContain` 금지, `className.split(/\s+/)` 토큰 멤버십으로 할 것(`ui/CLAUDE.md`의 `max-h-`⊃`h-` false-green 함정과 같은 이유).
- **전환 전 커버리지 확보 필수**(아래 테스트 §8): 현재 `VarUsagePopover.test.tsx`는 portal/jump/`aria-current`/close 경로만 덮고 **배지도 라벨도 단언하지 않으며 픽스처에 if 스텝이 없다**. 따라서 "기존 테스트 무수정 통과 = 회귀 없음"은 이 변환에 대해 **원리적으로 무이빨**이다.
- 순수 함수 — React·상태 없음. `Step`/`findStepById`/`summarizeCondition`은 `../../scenario/model`, `METHOD_BADGE`는 `./methodBadge`.

### R3. `DeleteVariableDialog` 컴포넌트

신규 `ui/src/components/scenario/DeleteVariableDialog.tsx`:

```ts
{ open: boolean; name: string; refIds: string[]; steps: Step[];
  onCancel: () => void; onConfirm: () => void }
```

- `ui/src/components/Modal.tsx`를 `title={ko.editor.varDeleteTitle}`로 래핑(`onClose = onCancel` → ESC·backdrop·✕ 전부 취소).
- 본문 = ① 경고 문단 `ko.editor.varDeleteBody(name, refIds.length)` ② 사용처 목록 ③ 버튼 행.
- 목록: `<ul>`(`aria-label={ko.editor.varDeleteUsageListAria}`)에 `refIds.map` — 각 `<li>`는 **비대화형**(button 아님), `describeStepRef`로 배지 + `truncate` 라벨. `max-h-64 overflow-auto`(팝오버의 `max-h-64`와 동일 캡). `key={id}`(배경의 중복 없음 성질).
- 버튼 행: `[취소]`(`variant="secondary"`, `ko.common.cancel`) / `[삭제]`(`variant="danger"`, `ko.common.delete`) — `UnsavedChangesDialog.tsx:33`의 `flex justify-end gap-2` 이디엄.
- **초기 포커스는 `Modal`의 기본(패널, `Modal.tsx:31`)을 그대로 둔다** — 여는 즉시 Enter를 눌러도 삭제되지 않는 것이 파괴적 액션에 옳다. `[삭제]` autofocus를 넣지 않는다(후속 "개선"이 이걸 뒤집지 않게 명시적 결정으로 기록).
- 모달 안에 `HelpTip`을 넣지 않는다(`ui/CLAUDE.md`: Modal capture-phase ESC가 HelpTip의 bubble ESC를 먹는 레이어링 함정).
- **`steps` 출처**: `VariablesPanel`이 이미 셀렉터로 들고 있는 `model`(nullable)에서 `model.steps`. 렌더 게이트는 팝오버와 동일한 형태(`VariablesPanel.tsx:455`의 `{usageNav && model && …}`)로 `{pendingDelete && model && <DeleteVariableDialog … steps={model.steps} />}`. **셀렉터 안 `?? []` 인라인 fallback 금지**(`ui/CLAUDE.md` getSnapshot 함정 — 필요하면 `EMPTY_STEPS` 모듈 상수 이디엄).

### R4. 확정·취소 동작 (`VariablesPanel`)

- `onConfirm`: `removeVariable(pendingDelete.name)` → `setUsageNav(null)` → `setPendingDelete(null)`.
  - 여기의 `setUsageNav(null)`은 기존 "선언 추가" 경로(`VariablesPanel.tsx:406`, R8)와 같은 위생 조치이나, R1이 트리거에서 이미 비우고 모달이 뜬 동안엔 사용처 버튼이 backdrop 뒤 + 포커스 트랩 밖이라 다시 열릴 경로가 없다 — **방어 전용(현재 도달 불가)**임을 명시한다(후속 리뷰가 중복을 결함으로 오독하지 않게). §9의 회귀 주입은 R1 쪽을 겨냥한다.
- `onCancel`: `setPendingDelete(null)`만. **모델 무변이**(US1의 관찰 조건).
- **포커스 — 두 경로를 다르게 못 박는다**:
  - **확정**: `×` 버튼이 언마운트되므로 그 시점 activeElement가 `<body>`로 떨어진다(detached 노드에 대한 `Modal.tsx:58`의 `previouslyFocused?.focus?.()`는 무해한 no-op일 뿐, 원인이 아니다 — 원인은 포커스된 요소의 언마운트). **요구 = 확정 후 포커스가 변수 검색 입력**(`ko.editor.varSearchPlaceholder`, `Input`은 `forwardRef` — `ui/src/components/ui/Input.tsx:18`). React 18은 한 passive flush에서 destroy를 create보다 먼저 돌리므로 부모의 평범한 `useEffect`(또는 핸들러 내 동기 focus)면 충분하다 — `setTimeout`/`requestAnimationFrame` 과설계 금지.
  - **취소**: `Modal`의 기본 복원(`Modal.tsx:58` → `×` 버튼)을 **그대로 둔다**. 즉 "`pendingDelete`가 null이 되면 검색 입력을 포커스"처럼 **양 경로 공통으로 구현하면 안 된다** — 취소에서도 발화해 정당한 복원을 이기고(부모 effect가 Modal cleanup보다 나중) 조용한 a11y 회귀가 된다.
  - 두 경로 모두 단언한다(테스트 §7).

### R5. `×` 버튼 yamlError 게이트 (US4)

- `×`에 `disabled={yamlError !== null}` 추가 — ✎(`VariablesPanel.tsx:175`)·"선언 추가"(`:404`)와 동일. 스타일도 그 둘과 같은 `disabled:opacity-40`.
- **이건 선재 결함 수정이다**(이 슬라이스가 만든 문제가 아니다): **지금도** yamlError 상태에서 `×`를 누르면 `dispatch`가 `store.ts:462`에서 early-return해 아무 일도 일어나지 않는다 — 이미 silent no-op이다. 확인 모달을 붙이면 그 침묵이 "확인까지 눌렀는데 아무 일 없음"으로 **더 기만적**이 되므로, 같은 슬라이스에서 닫는다.

### R6. 문구 (`ko.editor.*` 신규 3키, ADR-0035)

`ko.ts`의 Variables 패널 블록(현재 `:499` 주석 – `:531` `varExpandAria`) 안에 배치:

| 키 | 값 |
|---|---|
| `varDeleteTitle` | `"변수 삭제"` |
| `varDeleteBody` | `(name: string, n: number) => \`${name} 변수를 참조하는 스텝이 ${n}개 있습니다. 삭제하면 그 참조를 채우던 선언이 사라져 실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다.\`` (정정, 각주 참고) |
| `varDeleteUsageListAria` | `"삭제할 변수를 참조하는 스텝"` |

`[취소]`/`[삭제]` 버튼은 기존 `ko.common.cancel`/`ko.common.delete`를 재사용한다(신규 키 없음).

- `varDeleteBody`의 **"실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다"**는 배경에서 갈라놓은 두 양상을 **한 문장**으로 덮는다(사용자의 "분기하지 않는다" 결정 준수).
  - **"요청이"가 아니라 "실행이"인 이유**: 요청 표면의 실제 파급은 요청 1건 실패가 아니라 VU 전멸 → `AllVusFailed`(위 배경 참조)다. "요청이"는 위험을 **축소** 전달한다.
  - **"수 있습니다" 헤지가 필요한 이유**: 조건 분기만 타는 VU가 있으면 run이 완주하므로 단정("실패합니다")은 과 주장이 된다. 반대로 요청 표면만 말하는 문구는 cond-only 변수에게 일어나지 않을 실패를 경고하고 진짜 위험(조용한 오분기)을 숨긴다. 두 양상을 다 담고 헤지하는 이 한 문장이 양쪽 오류를 동시에 피하는 유일한 형태다.
- **참조 키 위치 주의**: 이 `×` 버튼의 기존 접근명 `removeVariableAria`는 위 블록이 **아니라 `ko.ts:773`**(editor 뒤쪽 절)에 있다 — 삭제 관련 문구가 두 곳으로 갈리므로 plan은 양쪽을 다 봐야 한다.
- **정정(2026-07-29, 최종 리뷰 fold-in)**: 원안의 "그 참조가 미정의(⚠)로 남아" 절은 `flatProducerNames`(선언 ∪ non-parallel extract)에 의해 그 이름을 flat extract도 동시에 생산하는 경우(§엣지 케이스의 `overwritten` 배지 상태) 삭제 후에도 이름이 extract로 정의된 채라 **⚠가 결코 뜨지 않아** 거짓이었다 — 위 표는 "그 참조를 채우던 선언이 사라져"로 교정한 값이다. 뒤따르는 "실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다" 결과절은 그대로 유지(§엣지 케이스가 이미 방어한 대로 extract보다 앞선 참조는 여전히 깨진다) — 두 양상을 한 문장에 담는 R6 원칙 자체는 안 바뀐다.

**부분문자열 충돌 대조**(신규↔기존 **양방향** 전수 — `thinkboard-defaults` 교훈):

- `varDeleteBody`는 의도적으로 `"...참조하는 스텝이 N개 있습니다"` 형태다. 자연스러운 대안 `"N개 스텝에서 사용 중입니다"`는 기존 `ko.editor.variableUsage(n)`(`ko.ts:506`=`"N개 스텝에서 사용"`)를 **부분문자열로 포함**해 `toHaveTextContent`/Playwright `getByText`(둘 다 substring)에서 패널 버튼과 모달 본문이 교차 매치된다 → 기각.
- `varDeleteUsageListAria`는 `"삭제할 변수를 참조하는 스텝"`이다. 초안이던 `"삭제할 변수의 사용 스텝 목록"`은 기존 `ko.editor.varUsageListAria`(`ko.ts:530`=`"사용 스텝 목록"`)를 **포함**하는데, 둘 다 목록 컨테이너의 `aria-label`이고 R1 이전엔 동시 존재가 가능했으므로 Playwright `getByLabel`(substring)에서 이중 매치된다 → 기각·교체.
- 불가피한 잔여 포함관계: `ko.editor.variablesTitle`(`"변수"`)·`ko.common.delete`(`"삭제"`)는 한국어로 이 기능을 지칭하는 어떤 문구에도 들어간다. 따라서 **개별 회피가 아니라 규칙으로 처리한다**: 이 슬라이스의 모달 단언은 예외 없이 `within(screen.getByRole("dialog"))` 스코프 + role+name **exact** 매처를 쓰고, `toHaveTextContent(짧은 공용어)` 형태는 쓰지 않는다(`ui/CLAUDE.md` "같은 라벨 버튼이 여럿" 함정).

**WCAG 2.5.3 Label in Name**: `[삭제]`/`[취소]`에 `aria-label`을 **붙이지 않는다** — 가시 텍스트가 곧 접근명이라 드리프트가 구조적으로 불가능하고, 맥락은 모달 제목(`role="dialog"`의 `aria-label`="변수 삭제")이 제공한다. 라이브 검증에서 맥락 부족이 확인되면 `scenario-preflight` 선례대로 **`aria = 가시 텍스트 + 꼬리`로 조립**해 도입한다(가시 텍스트를 덮어쓰는 형태 금지).

### R7. 회귀 보존 (0-diff 불변식)

- `removeVariable` store 액션·`varRows.ts`·`scanVars.ts`·`model.ts`·YAML 직렬화·서버/proto/migration **무변경**.
- 미사용 변수 삭제 경로는 **현행과 동일한 단일 호출**(US3) — 모달을 우회하는 별도 분기가 아니라 같은 `removeVariable(name)`.
- `VarUsagePopover`의 렌더 결과는 R2 전환 후에도 **시각적으로 동일**(배지 텍스트·색·라벨·클릭 동작). 변경은 `if` 배지 className의 토큰 **순서**뿐.

## 비목표

- 스텝·parallel 분기·데이터셋 등 **다른 삭제 어포던스**의 확인(요청 범위 밖).
- **undo/되돌리기** — 취소 버튼이 있는 확인이 이 슬라이스의 안전망이다.
- **위험 참조 개수 정밀 계산**(브레인스토밍에서 기각).
- 미사용 변수에 대한 확인.
- `flat-extract` / `parallel-extract` / `undefined` 행 — 이 행들엔 애초에 `×`가 없다(선언 행만 삭제 가능).
- **선언 행 값 textarea의 yamlError 게이트**(`VariablesPanel.tsx:289-294`): 이 입력은 지금도 미게이트라 깨진 버퍼에서 입력이 조용히 삼켜진다(선재 결함). US4의 "거짓말 없음" 주장은 `×`에 한정되며, 이 textarea는 **알려진 한계**로 남긴다.

## 테스트

전부 `ui/src/components/scenario/__tests__/` 아래(`ui/vitest.config.ts:60`의 `include`가 `src/**/__tests__/**` — 소스 옆에 두면 **조용히 안 돈다**). 신규 `DeleteVariableDialog.test.tsx`·`stepRefLabel.test.ts`, 확장 `VariablesPanel.test.tsx`·`VarUsagePopover.test.tsx`.

1. **US1-a**: `refIds.length > 0`인 선언 변수의 `×` 클릭 → `role="dialog"` 등장 **그리고** store `model.variables`에 그 키가 **여전히 존재**(즉시 삭제 안 됨).
2. **US1-b**: 모달 `[삭제]` 클릭 → 키가 제거되고 모달이 닫힌다.
3. **US1-c**: 모달 `[취소]` 클릭 → 키가 남고 모달이 닫힌다. ESC로도 동일(`Modal`의 capture ESC 경로).
4. **US2**: 모달 안 목록이 참조 스텝을 렌더 — http 스텝은 이름 + 메서드 배지, `if` 스텝은 조건 요약 + `IF` 배지. **픽스처 주의**: `IfStepModel.then`은 `.min(1)`(`model.ts:199` — 158행은 http-only `NestedIfStepModel`의 것이므로 혼동 말 것)이라 if 안에 http 자식이 강제된다 — 그 자식이 대상 변수를 참조하는지에 따라 본문의 `N`이 달라지므로 픽스처에서 확정할 것(권장: if 자식은 대상 변수를 참조하지 않게 두어 `N`을 예측 가능하게). 이 케이스가 덮는 렌더 경로는 **2개**(http 배지·IF 배지)이고 나머지 2케이스는 §8의 단위 테스트가 덮는다.
5. **US3**: `refIds.length === 0`("미사용" 표시) 변수의 `×` 클릭 → `queryByRole("dialog")` **부재** **그리고** 키가 실제로 제거됨(부정 단언 단독은 컴포넌트가 다른 이유로 안 떠도 통과하므로 긍정 단언 병기 필수).
6. **US4**: `yamlError`가 설정된 상태에서 `×`가 `toBeDisabled()`. (깨진 버퍼는 `setPendingYamlText`+`commitPendingYaml`로 만든다 — 그 경로가 `doc`/`model`을 보존해 입력이 DOM에 남는다. `VariablesPanel.test.tsx:489-497` 선례.)
7. **R4 포커스 2경로**: ① `[삭제]` 확정 후 `document.activeElement`가 변수 검색 입력이다(`<body>` 아님). ② `[취소]` 후 `document.activeElement`가 그 행의 `×` 버튼이다(Modal 기본 복원 보존).
   - **7②의 다이얼로그는 반드시 `user.click` 또는 `×.focus()` + `{Enter}`로 열 것.** `Modal.tsx:29`의 `previouslyFocused`는 open 시점 `activeElement`인데 `fireEvent.click`은 **포커스를 옮기지 않으므로** 그 값이 `<body>`가 되어 **구현과 무관하게 실패**한다(§9가 `fireEvent.click`을 등가로 허용하는 건 그 케이스 한정 — 이디엄을 7②로 옮기지 말 것). `user.click`은 mousedown 처리 중 target을 포커스한다.
8. **R2 헬퍼 + 소비처**:
   - `stepRefLabel.test.ts` 단위 4케이스(http / if / 찾았으나 loop·parallel / 미발견 id) + http 미지 메서드의 폴백 색.
   - **`VarUsagePopover.test.tsx`에 배지·라벨 렌더 테스트를 신설**한다 — 현재 이 파일은 배지/라벨/className을 전혀 단언하지 않고 픽스처에 if 스텝도 없어, 무수정 통과가 R2 변환의 회귀 가드가 **되지 못한다**. 신규 테스트는 **변환 전에 추가해 GREEN 확인** → 변환 후에도 GREEN이어야 한다(그래야 "변환이 아무것도 안 바꿨다"의 증거가 된다).
9. **A1 팝오버 공존 회귀**: 사용처 팝오버를 연 뒤 `×`를 **키보드로** 활성화(포커스 후 `{Enter}`) → `role="menu"`(팝오버) 부재 + `role="dialog"` 존재. **`user.click`을 쓰면 이 테스트는 공허하다** — user-event v14의 `click`은 `pointerdown`을 쏘고, 그 이벤트가 `VarUsagePopover.tsx:61-64`의 capture 리스너를 발화해 R1의 수정이 없어도 팝오버가 닫힌다. `fireEvent.click`(click만 디스패치)도 등가로 허용.

**이빨 실증 의무**(메모리 `plan-mandated-vacuous-tests`): 1·5·6·7①·7②·8(팝오버 신설분)·9는 각각 고의 회귀를 주입해 **RED 확인 후 원복→GREEN**을 실행한다 — 1: 분기를 무조건-즉시-삭제로 / 5: 분기를 무조건-모달로 / 6: `disabled` 제거 / 7①: 확정 포커스 이동 제거 / 7②: 포커스 이동을 양 경로 공통으로 변경 / 8: 배지 토큰 하나 제거 / 9: R1의 `setUsageNav(null)` 제거.

## 라이브 검증 (머지 전)

production diff가 UI-only이고 run 생성·리포트 파싱·엔진 경로를 안 건드리므로 백엔드 없이 `/scenarios/new`에서 검증 가능하나, **컴포넌트가 마운트되는 모든 진입 화면**에서 확인한다(메모리 `live-verify-all-mount-paths` — `/scenarios/new`와 `/scenarios/{id}`는 시드 타이밍이 달라 한쪽만 보면 false-PASS가 난다).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 참조 있는 변수 `×` → 취소 | 모달 표시 후 변수 행·값 그대로 |
| US1 | 같은 변수 `×` → 삭제 | 변수 행 사라지고 참조가 ⚠ "정의안됨" 행으로 전이 |
| US2 | 모달 목록 육안 | 참조 스텝 이름/조건 요약이 배지와 함께 표시 |
| US3 | "미사용" 변수 `×` | 모달 없이 즉시 사라짐 |
| US4 | YAML 모달에서 문법 깨뜨린 뒤 `×` | 버튼 비활성(클릭 불가) |
| R4 | 삭제 확정 / 취소 직후 `document.activeElement` | 확정=검색 입력 · 취소=`×` 버튼 |
| A1 | 사용처 팝오버 연 뒤 **키보드로** `×` 활성화 | 팝오버 사라지고 모달만 표시 |
| R2 | 팝오버 배지 `getComputedStyle` — **기대 색값 직접 단언**(`bg-slate-100`/`text-slate-500`의 계산값) | 변환 후 값이 그 기대값과 일치 |

## 엣지 케이스

- **모달 열린 채 다른 곳에서 그 변수가 사라짐**: backdrop이 `fixed inset-0`로 상호작용을 가로채고 모델 재시드 폴링도 없어 **실질 도달 불가**. 설령 발생해도 `pendingDelete`는 이름 스냅샷이고 `removeVariable`은 `deleteIn` 기반이라 없는 키 삭제는 no-op으로 무해.
- **검색 필터로 행이 가려진 상태**: `×`는 보이는 행에서만 눌리므로 도달 불가 조합 없음. 삭제 후 검색어는 유지(현행 동작 보존 — "선언 추가"와 달리 `setQuery("")` 하지 않는다).
- **펼침(`expanded`) 상태인 gen 변수 행 삭제**: `expanded`는 이름 `Set`이라 삭제된 이름이 남아도 렌더 대상 행이 없어 무해(현행 동작 그대로 — 이 슬라이스가 바꾸지 않는다).
- **참조가 매우 많은 변수**: 목록 `max-h-64 overflow-auto`로 스크롤. 상한 절단·"외 N개" 표기는 하지 않는다(절단은 조용한 정보 손실).
- **`overwritten`(amber "추출 덮어씀") 배지가 있는 변수**: 문구를 분기하지 않는다(확정 사항). 본문의 "실행이 실패하거나 조건 분기가 잘못 갈 수 있습니다"는 이 경우에도 참이다 — extract보다 앞선 참조는 실제로 깨진다.
