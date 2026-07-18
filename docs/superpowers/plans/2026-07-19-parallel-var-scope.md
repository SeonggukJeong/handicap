# parallel 분기 변수 스코프 (8a) — 구현 계획

- **spec**: `docs/superpowers/specs/2026-07-19-parallel-var-scope-design.md` (clean APPROVE, 3라운드)
- **브랜치**: `worktree-parallel-var-scope` · **베이스**: `2192eb7`
- **형태**: 엔진 2 task + UI 2 task = **4 task**, 각 독립 green 커밋

> **디스패치 규약**: 모든 subagent prompt 첫 줄에 `cd /Users/sgj/develop/handicap/.claude/worktrees/parallel-var-scope`. 매 brief에 spec의 `사용자 스토리 (US)` 블록 첨부(ADR-0048). 리포트는 `.superpowers/sdd/`에 — 워크트리 루트에 `.md` 쓰기·`git add` 금지.

> **task 순서 근거**: Task 1·2는 엔진 독립(서로 무관). Task 3은 `undefinedVarRefs`를 **추가만** 하고 기존 `undefinedVars`를 남긴다 — 지우면 소비처가 `tsc -b`에서 깨져 Task 3이 독립 green이 아니게 된다. Task 4가 소비처를 갈아끼우고 옛 export를 제거한다.
>
> **`undefinedVars` 소비처 전수(직접 grep 확인 — 프로덕션만 세지 말 것)**: `VariablesPanel.tsx:12`(import)·`:73`(호출) **그리고 `ui/src/scenario/__tests__/scanVars.test.ts:10`(import)·`:604`·`:621`(호출)**. `ui/tsconfig.json`의 `include: ["src"]`라 **테스트 파일도 `tsc -b` 대상** ⇒ Task 4가 export를 지우면서 테스트 파일을 안 건드리면 `TS2305` + `pnpm test` red로 **Task 4가 non-green**이 된다. Task 4 파일 목록에 그 테스트 파일이 포함돼 있다(아래).

> **UI task tdd-guard**: `ui/src` 편집 전 작업트리에 pending test 파일이 있어야 한다 → Task 3·4는 **테스트 파일 편집을 가장 먼저**(import 미해결로 RED여도 무방). ko 키/헬퍼 먼저 쓰는 순서로 가면 첫 src 편집이 차단된다(ui/CLAUDE.md). **`ui/src/i18n/ko.ts`도 가드 대상**(`tdd-guard.sh:28`가 `ui/src/**/*.ts` 전부 매치) — ko 편집도 pending test 뒤에.

> **ES2022 천장**: `ui/tsconfig.json`의 `target`/`lib`이 **ES2022** — `findLast`(ES2023)·`Object.groupBy`(ES2024) 등은 `pnpm test`(esbuild transpile)를 **통과하고 `pnpm build`(`tsc -b`)에서만** 깨진다. 새 walker에서 쓰지 말 것(editor-dataset-testrun에서 이미 밟은 함정).

---

## Task 1 — 엔진: `output_var_names()` 재귀 병합 (US2)

**파일**: `crates/engine/src/scenario.rs` (+ `crates/engine/tests/`)

**변경**: `Branch::output_var_names()`(타입명은 **`Branch`** — `crates/`에 `ParallelBranch`는 존재하지 않는다; `scenario.rs:156` 정의, 메서드 `:165`)가 분기 서브트리를 재귀 — `Http`=extract var, `Loop`=`do` 재귀, `If`=`then`·`elif[].then`·`else` 재귀, **`Parallel`(중첩)=재귀 안 함**(spec §3.2 — 명시적 비목표, `B.inner.v` 다층 네임스페이스 회피).

**시그니처 `Vec<&str>` 불변** — 호출부(`runner.rs:652`·`trace.rs:471`)·단위테스트(`scenario.rs:1248`) 전부 **0-diff**. ⇒ **컴파일러가 완성도를 전혀 보장하지 않는다**; 정확성은 아래 테스트로만 지켜진다.

**acceptance**:
- 단위(`scenario.rs`): 분기 안 `loop{http(extract v)}` → `output_var_names()`에 `v` 포함 · 분기 안 `if{then:[http(a)], elif:[http(b)], else:[http(c)]}` → `a,b,c` 전부 · 분기 안 **중첩 parallel**의 extract는 **미포함**(§3.2 한계 고정) · 기존 `:1248` 평평한 케이스 불변.
- 통합(`crates/engine/tests/parallel_node.rs` 또는 신규): **부하 경로** — 분기 안 loop에서 추출한 값이 다운스트림 `{{B.v}}`로 해석돼 요청에 실림.
- 통합(`crates/engine/tests/parallel_trace.rs`): **trace 경로** — 같은 시나리오의 `final_vars`에 `B.v` 존재(부하와 lockstep).
- `cargo test -p handicap-engine` green.

**주의**: runner/trace가 walker를 공유(`scenario.rs` 단일 소스)하므로 자동 lockstep이지만, **양쪽 테스트를 다 둔다**(engine CLAUDE.md의 lockstep 규칙 — 한쪽만 검증하면 미래 분기 시 drift).

---

## Task 2 — 엔진: `AllVusFailed`가 첫 실패 원인 운반 (US3)

**파일**: `crates/engine/src/error.rs`, `crates/engine/src/runner.rs`, `crates/worker/src/lib.rs`(테스트), `crates/engine/tests/all_vus_failed.rs`

**변경**:

1. `error.rs:14` — `AllVusFailed { failed, total }` → `+ cause: Option<String>`. **`thiserror` trailing-arg 이디엄(손수 `Display` impl 금지 — 다른 variant 포맷 유실)**:
   ```rust
   #[error("all VUs failed ({failed}/{total}){}", .cause.as_ref().map(|c| format!(": {c}")).unwrap_or_default())]
   AllVusFailed { failed: u32, total: u32, cause: Option<String> },
   ```
   **실측 확인(2026-07-19, `thiserror = "1"` 스크래치 크레이트 컴파일·실행)** — 이 이디엄은 컴파일되고 정확히 다음을 낸다:
   - `cause: Some("template: unknown variable token")` → `all VUs failed (1/1): template: unknown variable token` (= acceptance 문자열)
   - `cause: None` → `all VUs failed (2/2)` — **현행 메시지와 byte-identical** ⇒ 원인 미포착 run은 회귀 0.
2. 슬롯: `Arc<OnceLock<String>>`(VU 태스크가 `tokio::spawn`이라 owned 핸들 필요 — 기존 `failed: Arc<AtomicU32>`와 동형).
3. **캡처 위치 = `Aborted` 게이트 *안*** — `runner.rs:209-210`(closed) / `:847-848`(vu-curve)의 `if !matches!(e, EngineError::Aborted) { … }` 블록 안에서 `let _ = slot.set(e.to_string());`.
   > **이 배치는 *방어적*이며 현재는 행동으로 관측 불가**: cancel 시 `:314`/`:928`이 `AllVusFailed` 구성 전에 조기 반환하므로, 캡처를 게이트 밖(`:212`/`:850`)에 둬도 **오늘은** 모든 도달 가능한 입력에서 출력이 같다. 그래도 게이트 안에 두는 이유는 **누군가 그 조기 반환을 재정렬·제거하면 즉시 사용자 abort가 "실패 원인"으로 새기 때문**이다. ⇒ 테스트로는 못 지키니 **캡처 지점에 `runner.rs:314` 조기 반환을 언급하는 코드 주석을 남길 것**(테스트보다 이게 더 값어치 있다).
4. 구성: `runner.rs:321`(closed) / `:940`(curve)에서 `cause: slot.get().cloned()`.
5. 대응: `worker/lib.rs:708`(테스트 구성부) 필드 추가 · `tests/all_vus_failed.rs:54` 구조분해를 `{ failed, total, .. }`로.

**변경 불요(완성도 감사)**: `runner.rs:278`·`:888`은 `JoinError`(태스크 패닉)라 `EngineError` 아님 · `tests/vu_curve.rs:235`는 이미 `{ .. }` · `tests/if_node.rs:220`은 doc 주석. **struct variant 필드 추가는 명시적 구조분해만 깨뜨리므로 `grep -rn AllVusFailed crates/`가 완전성 오라클** — orchestrator가 직접 재실행할 것.

**acceptance**:
- `vus: 1` + 미해결 `{{token}}` URL 시나리오 → `run_scenario`가 `Err(AllVusFailed{..})`, `to_string()` == `all VUs failed (1/1): template: unknown variable token` (**정확 문자열** — `error.rs:7`이 `template: unknown variable {0}`, 따옴표 없음).
- `EngineError::AllVusFailed { failed: 2, total: 2, cause: None }.to_string() == "all VUs failed (2/2)"` — **현행 메시지와 byte-identical**(회귀 0, `#[error]` 속성 오작성 가드).
  > **`cause: None`은 cancel 경로로 관측 불가 — 이걸 런타임 테스트로 만들지 말 것(false-PASS)**: `runner.rs:314`(closed)/`:928`(curve)가 cancel 시 `AllVusFailed` 구성 **전에** `Err(Aborted)`로 조기 반환하고, VU가 뱉는 `Aborted`는 전부 monotonic한 run-level cancel 토큰에서 온다(retire는 child token + park이라 `Err` 아님 — `:1002`/`:1054`/`:1129`). "cancel → cause None" 테스트를 쓰면 실제로는 `Err(Aborted)`를 단언하게 되고, 그 단언은 캡처가 게이트 **밖**(`:212`)에 있어도 똑같이 통과한다. ⇒ 이 단언은 **타입 레벨(위 `to_string()`)로만** 가능하다.
- **단일 원인·단일 VU로 단언**(다중 VU는 어느 원인이 먼저인지 비결정 → flaky).
- `cargo test --workspace` green + `cargo clippy -- -D warnings`.

**읽기 안전성**: 읽기(`:321`/`:940`)는 JoinSet 드레인 완료(`:275-280`/`:885-890`) **이후**라 happens-before 성립 — torn/missed read 없음.

---

## Task 3 — UI: 위치 인식 `undefinedVarRefs` (US1 판정 로직)

**파일**: `ui/src/scenario/scanVars.ts` (+ `ui/src/scenario/__tests__/scanVars.test.ts`)

**변경**: 새 export
```ts
type UndefinedRef = {
  stepIds: string[];
  candidates: string[];
  kind: "downstream" | "sibling";
};
undefinedVarRefs(scenario): Map<string, UndefinedRef>
```
- `stepIds` = **위반 참조의** 문서순 stepId만(정당한 위치 참조 제외).
- `candidates` = 그 bare 이름을 추출하는 **분기명** 문서순·dedup 배열.
- **`kind` 판별자(리뷰 F2 — 없으면 Task 4가 구현 불가)**: `candidates`만으론 "다운스트림 bare"와 "형제 분기 안 bare"가 **구별되지 않는다**(둘 다 같은 candidates). Task 4의 형제 전용 문구를 위해 판별자가 필요하고, 없으면 패널이 시나리오를 재-walk해야 하는데 그 작업은 어느 task에도 없다. ⇒ 위반 참조가 **어떤 parallel 분기 서브트리 안**에 있으면 `"sibling"`, 아니면 `"downstream"`. 한 이름이 양쪽에 걸치면 `"downstream"` 우선(더 흔하고 수정 가능한 쪽).
- **namespaced 키는 `candidates` 항상 `[]`·`kind:"downstream"`(리뷰 F4)**: `typo.s` 같은 점 포함 미정의 이름을 `.`로 쪼개 접미사를 분기 extract와 매칭하면 안 된다 — 그러면 `candidates>=1`이 되어 Task 4가 "선언 추가"를 숨기고 `VariablesPanel.test.tsx:925`(`ghost.v`의 선언 추가 클릭)가 회귀한다. **`candidates`는 bare 이름에만 산출**.
- 판정(spec §2.2): 분기 B 서브트리 **안** = 선언 ∪ flat extract ∪ **B 자신의** extract / 그 외 = 선언 ∪ flat extract / namespaced는 `collectNamespacedProducers`로 **모든 위치** 해석.
- **의도된 false-negative(고치지 말 것)**: 같은 parallel 노드 *안*에서 `{{B.v}}`를 참조하면 런타임엔 미해결이지만(병합이 `join_all` 이후) 8a는 이를 **정의됨으로 보고한다**(spec §2.2.2 선언된 한계). "버그처럼 보인다"고 조이면 shadow 테스트가 깨진다 — 8b 후보.

**구현 함정 A(필수)**: 행 1의 "B 자신의 extract"를 구하는 walker는 **분기 서브트리를 재귀**해야 한다(분기 안 loop/if 포함). 최상위 http만 보면 loop-in-branch 안 bare 참조가 전부 **오탐** — 이게 Task 1이 엔진에서 고치는 것과 *같은 실수*다.

**구현 함정 B — cond 오퍼랜드(리뷰 F3)**: 참조-수집 쪽은 **`buildVarRefIndex`(`scanVars.ts:98-137`)를 본뜰 것** — 그건 `collectCondRefs`(`:78-89`)로 `if`/`elif` **조건 오퍼랜드**까지 수집한다. 구조적으로 더 닮아 보이는 `collectBranchInternalRefs`(`:228-252`)는 `flattenHttpSteps`만 돌아 **cond 커버리지가 없다** — 그걸 본뜨면 조건에서만 참조되는 미정의 이름을 조용히 놓쳐 **현행 `undefinedVars` 대비 회귀**가 된다. 기존 테스트가 이걸 안 막는다(현 `undefinedVars` 테스트 2개는 Task 4가 삭제·이관).

**walker narrowing**: `flatExtractNames`(`scanVars.ts:198-214`)가 이미 평범한 `s.type === "http"|"loop"|"if"` 판별로 내로잉한다 — **타입가드 술어 불필요**. 그걸 본떠라.

**`flatExtractNames`는 선언 키 미포함**(`scanVars.test.ts:713` 고정) ⇒ **선언 키 union은 새 walker 안에서**.

**기존 `undefinedVars`는 남긴다**(Task 4가 제거). **다른 export 6종**(`collectProducedVars`·`flatExtractNames`·`parallelExtractNames`·`collectNamespacedProducers`·`parallelVarIdentities`·`collectBranchInternalRefs`)은 **시그니처·동작 불변** — `collectProducedVars`는 소비처 3곳(`store.ts:175`·`DataBindingPanel.tsx:308`·`VariablesPanel.tsx:70`)이 현 의미를 요구한다(spec §2.2.1).

**신규 fixture 필수**: `parallelScenDownstreamBare` = 기존 `parallelScen`(`scanVars.test.ts:478`) + `after` 스텝이 `{{s}}`를 **bare로** 참조. **기존 `parallelScen`으론 RED가 안 난다**(현 4개 단언이 새 규칙에서도 전부 green — 리뷰 확인). 이 fixture 없이는 RED 단계가 공허.

**acceptance**:
- 다운스트림 bare → 미정의 (**핵심 가드**) · `stepIds`가 다운스트림 스텝만 담고 분기 내부 스텝 **제외**.
- 분기 내부 bare → 미정의 아님(기존 `:606` 의도 보존).
- **분기 안 loop 내부** bare → 미정의 아님(위 함정 가드).
- 형제 분기 bare(A 안에서 B의 extract) → 미정의 + `candidates`에 B + **`kind === "sibling"`**.
- 다운스트림 bare → **`kind === "downstream"`**.
- **cond 전용 참조**: `if`/`elif` 조건 오퍼랜드에서만 참조되는 미정의 이름도 잡히고 `stepIds`에 그 if-스텝 id가 담김(함정 B 가드).
- **namespaced 미정의 키(`typo.s`)** → `candidates === []`(함정 F4 가드).
- namespaced `{{B.v}}` → 정의됨 · flat 스텝이 같은 이름 생산 시 다운스트림 bare → 정의됨(shadow).
- `candidates` 정확성: 0개/1개/2개 케이스.
- 기존 `scanVars.test.ts` **전부 green**(Task 3은 추가만 — 옛 `undefinedVars` describe 삭제·이관은 **Task 4 소관**).
- `pnpm lint && pnpm test && pnpm build` green.

---

## Task 4 — UI: VariablesPanel 힌트 + "선언 추가" 조건부 숨김 (US1 표면)

**파일**: `ui/src/components/scenario/VariablesPanel.tsx`, `ui/src/i18n/ko.ts`, `ui/src/scenario/scanVars.ts`(옛 export 제거) (+ `ui/src/components/scenario/__tests__/VariablesPanel.test.tsx`, **`ui/src/scenario/__tests__/scanVars.test.ts`**)

**⚠ 옛 export 제거는 테스트 파일과 한 커밋에서(리뷰 F1 — 이거 빠지면 Task 4 non-green)**: `undefinedVars`를 지우면 `scanVars.test.ts:10` import가 `TS2305`(테스트도 `tsc -b` 대상), `:602-622` describe가 red. 같은 task에서:
- `:603-609` 케이스 **삭제**(Task 3의 위치 인식 테스트가 대체).
- `:610-621` `expect(undefinedVars(s).has("vu_id")).toBe(true)`는 **`undefinedVarRefs`로 이관**(삭제 금지) — "예약 시스템 변수 무감산"은 살아있는 불변식이라 조용히 버리면 커버리지 손실.
- `parallelScen` fixture는 `:558/:567/:575/:581`이 계속 쓰므로 describe를 지워도 `noUnusedLocals`에 안 걸린다.

**변경**:
1. `undefinedVars` → `undefinedVarRefs`로 소비처 전환(`VariablesPanel.tsx:73`) 후 **옛 export 제거**.
2. 미정의 행 `refIds`를 `refIndex.get(name)`이 아니라 **`stepIds`**로(`VariablesPanel.tsx:107`의 `out.push({ kind:"undefined", … refIds: refIndex.get(name) ?? [] })` — 정당한 분기 내부 참조를 usage 팝오버가 가리키지 않게).
2b. `VarRow` union의 undefined 변형(`VariablesPanel.tsx:36`)에 **`candidates: string[]` + `kind`** 추가.
3. `candidates`별 힌트 — **`ko.ts` 신규 키 3종을 이 이름으로 고정**(구현자 임의 작명 금지, ADR-0035):
   - `ko.editor.variableBranchCandidateHint(branch: string, name: string)` — 1개
   - `ko.editor.variableBranchCandidatesHint(branches: string[], name: string)` — 2개+
   - `ko.editor.variableSiblingBranchHint` — 형제(plain string)
   | `candidates` | 표시 | "선언 추가" |
   |---|---|---|
   | 1개 | "parallel 분기 `auth`에서 추출됨 — `{{auth.token}}`으로 참조하세요" | **숨김** |
   | 2개+ | 후보 나열 + `{{분기명.token}}` 형태 안내 | **숨김** |
   | 0개 | 현행 | **유지** |
   형제 분기 참조는 전용 문구("형제 분기의 값은 참조할 수 없습니다(동시 실행)").
4. **`candidates.length >= 1`이면 "선언 추가" 숨김**(spec §2.4.1) — 그 버튼은 `variables[name]=""`를 넣어 ⚠를 지우고 run이 빈 값을 **성공적으로** 보내게 만든다([[load-divergence-explain-confirm]] 조용한 부하 왜곡). 8a엔 원클릭 수정 버튼 **없음**(→ 8b).

**신규 fixture 필수(리뷰 F6/E3)**: `MIXED_DOWNSTREAM_BARE` = 기존 `MIXED`(`VariablesPanel.test.tsx:242-273`) + 최상위 뒤 스텝이 **bare `{{s}}`** 참조(`s`는 분기 `alpha`가 추출). **기존 `MIXED`로는 RED가 안 난다** — `MIXED`는 `{{alpha.s}}`를 *namespaced*로 참조하고 분기 leaf url이 `/y`(참조 0)이라, 새 규칙에서 미정의는 `missing`(candidates 0)뿐이고 **행 집합이 그대로**다. 즉 Task 4의 두 헤드라인 acceptance가 어떤 기존 fixture로도 RED가 될 수 없다.

**acceptance**:
- `MIXED_DOWNSTREAM_BARE`에서 `s` 행: 힌트 렌더 + **"선언 추가" 미렌더**(핵심 회귀 가드) / `missing` 행(candidates 0): 힌트 없음 + **"선언 추가" 렌더**.
- 미정의 행 usage 팝오버가 분기 내부 스텝을 **안 가리킴**(`stepIds` 배선 가드).
- **`VariablesPanel.test.tsx:278`(기존 `MIXED` 행 집합)은 갱신 대상이 아니라 *불변 회귀 가드*** — 그대로 green이어야 한다(E3: `MIXED`의 행 구성은 이 슬라이스로 안 바뀐다).
- `VariablesPanel.test.tsx:925`(`ghost.v` 선언 추가) 계속 green(namespaced candidates=[] 가드).
- 하드코딩 한국어 0(`grep '"[^"]*[가-힣]' ui/src/components/scenario/VariablesPanel.tsx` — 여는 따옴표 직후만 보는 패턴은 괄호 시작 문구를 놓친다).
- `pnpm lint && pnpm test && pnpm build` green(전체 — targeted green ≠ full green).

**RTL 셀렉터 주의**: `MIXED_DOWNSTREAM_BARE`에선 패널이 `parallel-extract` 행(`alpha.`+`s`)과 `undefined` 행(`s`)을 **둘 다** 렌더 → `getByText("s")`는 다중매치 throw. 기존 이디엄(`VariablesPanel.test.tsx:647/:662`)대로 `getByTitle(ko.editor.variableUndefinedAria("s")).closest("li")` + `within(...)`으로 스코프.

---

## 최종 게이트 (orchestrator 직접 실행 — self-report 불신)

1. `grep -rn "AllVusFailed" crates/` 전수 재확인(Task 2 완성도 오라클).
2. `grep -rn "undefinedVars" ui/src/` → 0건(옛 export 제거 확인).
3. 스코프: `git diff $(git merge-base master HEAD)..HEAD --stat` — proto·controller·migration·`schemas.ts`·`yamlDoc.ts`·UI Zod 모델 **0-diff** 확인.
4. `cargo build --workspace && cargo clippy -- -D warnings && cargo nextest run` + `cd ui && pnpm lint && pnpm test && pnpm build`(게이트 판정은 파이프 없이 `; echo exit=$?`).
5. **최종 리뷰** `handicap-reviewer`(BASE = implementer 디스패치 직전 커밋, `HEAD~1` 금지) + **보안 게이트**: diff가 템플릿/캐스트·env/데이터셋 바인딩·trace/body 뷰어를 건드리는지 `finish-slice §0` grep으로 판정(예측 아닌 grep이 지배) — Task 1·2가 `runner.rs`/`trace.rs`를 건드리므로 **매치 가능성 높음** → `security-reviewer` 필요 예상.
6. **라이브 검증 필수**(`/live-verify` — 엔진 실행 경로 변경). US 척추 4행:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 에디터에서 분기 extract + 다운스트림 bare | 미정의 ⚠ + 힌트 · "선언 추가" 부재 |
| US1 | 힌트대로 수정 → 저장 → run | `completed`, errors 0 (PRE: `failed`) |
| US2 | 분기 안 loop + `{{auth.token}}` → `POST /api/test-runs` | `final_vars`에 `auth.token` + 요청 URL에 실제 값 (PRE: `final_vars={}`) |
| US3 | 결함 1 시나리오 run(**`vus:1`·`worker_count=1`**) → `GET /api/runs/{id}` | `message` == `all VUs failed (1/1): template: unknown variable token` |

**라이브 주의**: 워크트리 **자체** 바이너리로(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` → 상대경로 `./target/debug/controller`). UI 검증이 필요하므로 `--ui-dir ui/dist`(+ `pnpm build`로 dist 갱신). US3 행은 `vus:1`·단일 워커 고정(`mark_failed_if_active`가 먼저 보고한 워커 승 — 멀티워커면 비결정).

---

> **리뷰 이력**: spec `spec-plan-reviewer` 3라운드 clean APPROVE(F1–F4·R1–R6·C1–C5·G1–G8 전건 반영, 기각 0). plan 동 리뷰어 2라운드 — 1차 E1–E4·F1–F6 반영, 2차에서 Task 2 acceptance 1건이 **관측 불가(false-PASS)**로 지적돼 byte-identical 단언 + 방어적-배치 주석 규약으로 교체. **양 문서 통틀어 기각 0건** — 모든 finding이 코드 대조로 확인됨.

REVIEW-GATE: APPROVED
