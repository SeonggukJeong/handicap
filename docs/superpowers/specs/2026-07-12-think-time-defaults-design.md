# think-time-defaults — 시나리오-레벨 기본 think time + 스텝별 override (§A12 도그푸딩 2호)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12) → plan 대기
- **출처**: roadmap §A12 도그푸딩 백로그 "Think Time 일괄 지정". 사용자 원인 진술: *"스텝별로 하나하나 think time을 입력하는 게 귀찮아서, 일단 전체에 기본값을 입력한 후 특정 스텝만 별도 값으로."* §A12 잔여 3건 중 값이 가장 크고(부하 모델 현실성에 직결) 와이어 비용이 0이라 지금 한다.
- **연관**: ADR-0033(parallel 그룹/페이지 레이턴시), ADR-0046(사이징 = 반복 점유시간), ADR-0037(closed-loop VU 곡선), ADR-0003/0015(GUI↔YAML 양방향 sync), ADR-0035(ko 카탈로그), 슬라이스 S-B(per-step think time 도입), `2026-07-12-editor-var-conflict-quickadd-design.md`(§A12 1호).
- **ADR**: **신규 불필요** — S-B/ADR-0016이 정의한 think time 개념의 additive 확장이고 새 실행 모델·저장소·프로토콜 결정이 없다. parallel 배제 규칙은 ADR-0033의 "그룹 시간 ≈ 페이지 로드 시간" 불변식을 *보존*하기 위한 귀결이라 그 ADR 범위 내.

---

## 1. 문제와 목표

지금 think time은 **스텝마다 개별 입력**만 가능하다(`HttpStep.think_time`, 인스펙터 페이싱 섹션). 20–30 스텝 시나리오에서 "사람처럼 요청 사이에 0.5–1초 쉬게 하라"를 표현하려면 같은 값을 20–30번 입력해야 하고, 나중에 그 값을 바꾸려면 다시 20–30번 고쳐야 한다. 그래서 실사용자는 think time을 아예 안 쓰게 되고, 부하 모델이 비현실적(무휴식 폭주)으로 기운다.

- **목표**: 시나리오에 **기본 think time 한 곳**을 두고, 스텝은 (a) 상속 (b) 자기 값으로 override (c) "이 스텝만 대기 없음" 중 하나를 고른다. GUI(에디터 왼쪽 패널)와 YAML 양쪽에서 편집(ADR-0003). **부하 3경로(closed-loop·VU 곡선·open-loop) + test-run** 모두 같은 규칙이고, **사전 사이징 추천도 같은 규칙**을 본다(부하 divergence 금지).
- **비목표(연기)**: §7 참조. run-level "전체 무시" 토글·기본값의 run-level override·일괄 쓰기 버튼·parallel 그룹 단위 대기.

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `Scenario`에 `default_think_time: Option<ThinkTime>`를 추가한다(`#[serde(default, skip_serializing_if = "Option::is_none")]`, `cookie_jar`와 `steps` 사이 위치) — 필드가 없는 기존 YAML은 파싱·직렬화 모두 byte-identical. | `cargo test -p handicap-engine` — round-trip(있음) + `!to_yaml().contains("default_think_time")`(없음) | ✅ wire: UI Zod/normalize ↔ engine serde (짝 = R2·R14) |
| R2 | MUST UI Zod `ScenarioModel`이 `default_think_time`을 optional로 수용하고 `min_ms ≤ max_ms ≤ 600000`을 검증한다(기존 `ThinkTimeModel` 재사용). | `pnpm test` model — 유효/`min>max`/`600001`/absent | ✅ wire: UI Zod ↔ engine serde (짝 = R1) |
| R3 | MUST 엔진 인터프리터가 http 스텝 think time을 `step.think_time.or(default_think)`로 해석한다 — 키 없음=상속, `{min_ms:0,max_ms:0}`=이 스텝만 대기 없음, 값=override. | `cargo test -p handicap-engine --test think_time` — 상속·override·0/0·기본값없음 | |
| R4 | MUST parallel 분기 서브트리(분기 안의 중첩 loop/if 포함)에는 기본값을 **적용하지 않는다**; 분기 스텝에 **명시된** `think_time`은 지금처럼 적용된다(현행 보존). | `--test think_time parallel_branch_ignores_scenario_default` — 기본값만 있을 때 분기 소요시간 불변 + 명시값 있는 분기 스텝은 증가 | |
| R5 | MUST test-run trace 경로(`trace.rs`)도 R3/R4와 **같은 해석 규칙**을 쓰되, 실제 sleep은 `apply_think_time == true`일 때만(현행 게이트 유지). | `--test trace_scenario` — apply on/off × 상속 스텝 | |
| R6 | MUST proto·워커·컨트롤러 API·DB migration **0-diff** — 시나리오는 `RunAssignment.scenario_yaml`(proto field 2)로 통째 스냅샷 전송되고 컨트롤러는 raw text로 저장/전달하므로 기본값이 자동으로 워커에 닿는다. `validate_run_config`는 손대지 않는다(§5 open-loop 정책). | `git diff master --stat`에 `crates/proto/`·**`crates/controller/`**·`migrations` 무변경(컨트롤러 API 0-diff 주장을 게이트가 실제로 검사하도록 경로에 포함) | |
| R7 | MUST 에디터 왼쪽 패널에 접이식 "시나리오 기본값" 섹션을 추가해 기본 think time을 설정·변경·제거할 수 있고, **왕복이 성립**한다(편집 → YAML 키 등장 → 재파싱된 `model.default_think_time`이 같은 값; 두 칸 비우면 키 제거 → `undefined`). | `ScenarioDefaults.test.tsx` — write→reparse→model 일치, 비우기→키 제거 | |
| R8 | MUST 인스펙터 페이싱 섹션이 3상태를 명시한다: 상속 중이고 기본값이 있으면 "시나리오 기본값 N–M ms 상속 중" 힌트, "이 스텝은 대기 없음" 체크박스가 `{min_ms:0,max_ms:0}`을 쓰고 해제 시 키를 제거(상속 복귀). **체크된 동안 min/max 입력은 disabled**(0/0 표시) — 반쯤 채운 draft가 `{500,0}`로 커밋돼 조용히 되돌아가는 경로를 없앤다. | `Inspector.test.tsx` — 힌트 표시/미표시, 체크→0/0 write + 입력 disabled, 해제→undefined | |
| R9 | MUST parallel 분기 **내부** http 스텝의 인스펙터는 "병렬 분기 내부라 시나리오 기본값 미적용 + 이유(동시 리소스 로딩이라 사람의 대기가 낄 자리가 아니고 그룹/페이지 레이턴시 지표가 오염됨)"를 안내하고, 이때 상속 힌트는 숨긴다. | `Inspector.test.tsx` — 분기 내부 스텝: 안내 present·상속힌트 absent / 최상위 스텝: 반대 | |
| R10 | MUST 기본값이 없는 시나리오의 UI·엔진 거동은 현행과 완전히 동일(회귀 0) — 상속 힌트 숨김, 빈칸은 지금처럼 "대기 없음". | 기존 엔진·UI 테스트 전부 green + `pnpm lint && pnpm test && pnpm build` | |
| R11 | SHOULD 아웃라인 wide 칩(`wideChipThink`)은 **스텝에 명시된 값만** 표시한다(상속값을 칩에 퍼뜨리지 않음 — 원본이 흐려짐). **현행 코드가 이미 그러하므로 lock-in 테스트만 추가**(0-diff 요구사항). | `FlowOutline.test.tsx` — 기본값만 있는 시나리오의 상속 스텝 칩에 think 칩 부재 | |
| R12 | MUST 신규·개명 문구는 전부 `ui/src/i18n/ko.ts` 카탈로그 경유(ADR-0035), 컴포넌트 하드코딩 0. | `ko.test.ts` 키 존재 + 신규 컴포넌트 리터럴 한글 grep 0 | |
| R13 | MUST 라이브 부하 경로에서 상속이 실제로 걸린다: closed-loop에서 기본값만 켠 시나리오의 `summary.rps`가 **`VUs × 스텝수 ÷ (대기하는 스텝수 × think)`**(리포트 `rps`는 *요청*/초 = `total_count/duration`, `report.rps:614` — 반복/초가 아니다) 예측대로 떨어지고, 0/0 opt-out 스텝은 쉬지 않으며(대기 지점이 줄어 rps가 예측대로 상승), parallel 그룹 레이턴시는 기본값만큼 늘지 않는다. | `/live-verify` — 리포트 `summary.rps` 실측(§6 수치) + parallel 그룹 레이턴시 비교 | ✅ 라이브 |
| R14 | MUST `yamlDoc.ts::normalizeForModel`의 **루트 키 allowlist**에 `default_think_time`을 통과시킨다 — 없으면 Zod가 보기 전에 키가 잘려 나가 **write-only 버그**(YAML엔 써지는데 모델은 영영 `undefined`)가 된다(`request.disabled`/`normalizeRequest` 전례, `ui/CLAUDE.md`). | R7의 왕복 테스트가 이 게이트를 닫는다 + `yamlDoc.test.ts` 파싱 케이스 | ✅ wire: 읽기 경로(짝 = R1·R2) |
| R15 | MUST 사전 사이징 워커가 기본값을 반영한다(부하 divergence 금지 — 사용자 상시 규칙): `sizing.ts::iterationHoldMs`와 `openLoopChecks.ts::iterationTimeUpperBoundSeconds`가 `default_think_time`을 받아 상속 스텝에 더하되 **parallel 분기 재귀엔 넘기지 않아**(엔진 R4 규칙 미러) 걷기 결과가 엔진 실행과 일치하고, **두 배선 지점**(`SlotSizingHelper.tsx:48`·`openLoopChecks.ts:89` `openLoopWarnings`)이 실제로 그 값을 넘기며, `VuSizingHelper`의 test-run 호출이 `apply_think_time: true`를 보낸다(`SlotSizingHelper`와 동일 — 지금은 빠져 있어 think time이 측정에서 통째 누락). | ① 순수함수: `sizing.test.ts`/`openLoopChecks.test.ts` — 상속 스텝 hold에 기본값 포함·분기 내부 스텝엔 미포함 ② **배선(필수 — 순수함수 테스트는 인자를 직접 주므로 배선을 잊어도 green)**: `SlotSizingHelper.test.tsx` 걷기 앵커 ⓑ 케이스가 기본값만큼 커짐 + `openLoopChecks.test.ts` `openLoopWarnings` `inert_slots` 임계값이 기본값 때문에 이동 ③ `VuSizingHelper` 페이로드에 `apply_think_time: true` 단언 | |
| R16 | MUST **closed-loop VU 곡선 경로(`run_vu_curve`, `vu_stages`)도** 기본값을 적용한다 — `execute_steps` 비재귀 호출부는 `run_vu`·`run_vu_curve`·`run_arrival` **3곳**이고, 곡선 경로는 `run_vu` 본문의 의도적 복제라 가장 흘리기 쉽다(`crates/engine/CLAUDE.md` 경고). | `--test vu_curve`(또는 think_time에 곡선 케이스) — `vu_stages` run에서 상속 적용 단언 | |
| R17 | MUST 왼쪽 패널이 이제 "변수 + 시나리오 기본값"을 담으므로 토글 문구·`aria-label`·랜드마크 이름을 그에 맞게 개명한다(현재 전부 "변수"라, 접으면 페이싱 설정이 *변수* 토글에 숨는 오표기). **개명은 ko 카탈로그의 *값(문자열)만*이고 키(`varsToggle`/`varsToggleAria`/`varsPanelAria` 등 `ko.ts:424-431`)는 그대로 둔다** — 모든 소비처가 심볼 참조라 테스트 churn이 0이 된다. **`ko.editor.variablesTitle`(`VariablesPanel.tsx:216`의 내부 섹션 h3)은 개명 대상이 아니다** — 바깥 aside 랜드마크만 넓어지고 그 안의 "변수" 섹션은 그대로. | `ko.test.ts` + `EditorShell.test.tsx` + **`ui/src/i18n/__tests__/editorRedesignKeys.test.ts`**(`vars*` 키 참조처 4파일 중 하나) — 개명된 라벨, 토글로 두 섹션 함께 접힘 | |

- **seam 짝(R1 ↔ R2 + R14)**: 같은 YAML 키를 엔진 serde와 UI 읽기 경로(normalize → Zod)가 나눠 소유한다. **UI 루트 `.strict()`는 이 키에 도달하지 않는다** — `normalizeForModel`이 루트 5키 allowlist(`version`/`name`/`cookie_jar`/`variables`/`steps`)로 미리 잘라내기 때문에, R14 없이 R1·R2만 머지하면 *거부*가 아니라 **조용한 무시**가 된다. 세 R은 같은 브랜치에서 함께 머지한다.

---

## 3. 핵심 통찰 (설계 근거)

1. **와이어 비용이 0이다.** 시나리오는 `RunAssignment.scenario_yaml`(proto field 2)로 통째 전송되고, 컨트롤러는 YAML을 **raw text로 저장/스냅샷**한다(`store/scenarios.rs`, `api/runs.rs`) — 재직렬화로 새 키를 떨어뜨리는 경로가 없다. 따라서 시나리오-레벨 필드는 proto/DB/컨트롤러 API를 안 건드린다(R6). 반대로 *run-level* 킬스위치(`Profile`)를 넣었다면 proto 필드 + 워커 매핑 + `validate_run_config`가 붙었을 것 — 원래 불편(일괄 입력)과 무관하므로 §7로 연기했다.

2. **3상태를 새 타입 없이 표현한다.** `Option<ThinkTime>`의 `None`을 "상속"으로 재해석하고, "대기 없음"은 `{min_ms:0,max_ms:0}`이 맡는다. 엔진 `pace()`는 zero duration에서 즉시 복귀하므로(`capped.is_zero() → Slept`, `pacing.rs:56`) 0/0은 지금도 정확히 "대기 없음"이다. 명시 센티널(`think_time: none`)은 serde untagged enum + Zod union + yamlDoc 왕복을 새로 요구해 모델 복잡도만 올린다 → 기각(사용자 확인).

3. **parallel 배제는 규칙이 아니라 구조로 강제한다.** `execute_steps`에 `default_think: Option<ThinkTime>` 파라미터를 하나 추가하고 **parallel arm이 분기 재귀 호출에 `None`을 넘긴다**. 그러면 "분기 서브트리 전체(중첩 loop/if 포함) 미적용"이 코드 한 지점에서 나오고, 나중에 분기 안에 loop가 생겨도 규칙이 새지 않는다(R4). 근거: parallel은 브라우저가 페이지 리소스를 **동시에** 받는 구간이라 사람의 생각 시간이 낄 자리가 아니며, ADR-0033의 그룹 시간(`elapsed_us` = max(branches) ≈ 페이지 로드 시간)이 수면만큼 부풀어 **지표가 오염**된다. 사용자가 분기 스텝에 *직접* 적은 값은 현행대로 적용(명시 > 암묵).

4. **같은 배제 규칙을 UI 워커도 미러해야 사이징이 맞다.** `sizing.ts::iterationHoldMs`는 ADR-0046의 걷기 앵커 ⓑ(= `recommendSlots`의 반복 점유시간)이고 parallel arm에서 `max(branches)`를 취한다. 여기서도 분기 재귀에 기본값을 넘기지 않으면 **걷기 ⓑ == 실측 ⓐ 패리티**(ADR-0046이 라이브로 입증한 불변식)가 유지된다. 이 미러를 빼면 상속 스텝의 점유시간이 0으로 계산돼 `max_in_flight`를 과소 추천 → 슬롯 부족 → 요청 드롭 → **사용자가 설정한 부하와 다른 부하가 조용히 나간다**(사용자 상시 규칙 위반). 그래서 R15는 nice-to-have가 아니라 R3가 머지되는 순간 깨지는 불변식의 복구다.

5. **해석 지점은 인터프리터뿐.** `execute_step`(executor)은 손대지 않는다 — S-B가 정한 경계(think time은 인터프리터, 요청은 executor)를 유지해 실행기 byte-identical. 대신 `execute_steps` **비재귀 호출부 3곳**(`runner.rs:384` `run_vu` / `:1045` `run_vu_curve` / `:1393` `run_arrival`)을 전부 갱신해야 한다 — 곡선 경로는 `run_vu` 본문의 의도적 복제라 놓치기 쉽고, 놓치면 `vu_stages` run에서만 기본값이 조용히 무시된다(R16).

6. **시나리오-레벨 편집 이디엄이 이미 있다.** 스토어의 `setCookieJar`(scenario-level Edit → `applyEdit` → yamlDoc, UI만 없었음)를 `setDefaultThinkTime`이 그대로 복제하므로 store/yamlDoc에 새 개념이 없다. 단 **읽기 경로는 별도 관문**이다 — `normalizeForModel`의 루트 allowlist를 통과시키지 않으면 write-only가 된다(R14).

---

## 4. 변경 상세

### 4.1 `crates/engine/src/scenario.rs` — 충족 R: R1
`Scenario`에 필드 추가(`cookie_jar` 다음, `steps` 앞 — 키 순서 고정):
```rust
/// 시나리오 기본 think time. 스텝의 `think_time`이 없으면 이 값을 상속하고,
/// `{min_ms:0,max_ms:0}`이면 그 스텝만 대기 없음, 값이 있으면 override.
/// parallel 분기 서브트리에는 적용되지 않는다(runner/trace의 parallel arm이 None 전달).
#[serde(default, skip_serializing_if = "Option::is_none")]
pub default_think_time: Option<ThinkTime>,
```
`deny_unknown_fields` 유지. 워크스페이스 전체에서 `Scenario {…}` **리터럴 생산지는 `crates/engine/tests/proptests.rs:178` 한 곳**(나머지는 전부 YAML 파싱 → `#[serde(default)]`가 흡수)이므로 그 한 줄에 `default_think_time: None` 추가.

### 4.2 `crates/engine/src/runner.rs` — 충족 R: R3, R4, R16
- `execute_steps(...)`에 `default_think: Option<ThinkTime>` 파라미터 추가(`ThinkTime: Copy`, `#[allow(clippy::too_many_arguments)]` 이미 있음).
- Http arm(`:502`): `if let Some(tt) = &http.think_time` → `if let Some(tt) = http.think_time.or(default_think)`.
- Parallel arm(`:598` 분기 재귀): **`None`** 전달. Loop(`:518`)·If(`:563`) arm: `default_think` 그대로 전달.
- 비재귀 호출부 **3곳** 갱신 — `:384`(`run_vu`, closed-loop), `:1045`(`run_vu_curve`, VU 곡선), `:1393`(`run_arrival`, open-loop) — 전부 `scenario.default_think_time` 전달.
- run-level `plan.think_time`(반복 간 페이싱)은 무관 — 그대로.

### 4.3 `crates/engine/src/trace.rs` — 충족 R: R5
`trace_steps`에 같은 파라미터 추가, 같은 해석·같은 parallel `None`. 실제 sleep은 기존 `opts.apply_think_time` 게이트 안에서만. 진입점(`trace_scenario`, `&Scenario` 보유)에서 `scenario.default_think_time` 전달.

### 4.4 `ui/src/scenario/model.ts` — 충족 R: R2, R9
- `ScenarioModel`에 `default_think_time: ThinkTimeModel.optional()`.
- 신규 순수 헬퍼 `isInsideParallelBranch(model, stepId): boolean` — 스텝 트리를 걸으며 parallel 분기 서브트리 안이면 true(중첩 loop/if 포함). 인스펙터 R9가 소비.

### 4.5 `ui/src/scenario/yamlDoc.ts` + `store.ts` — 충족 R: R7, R14
- **읽기**: `normalizeForModel`의 루트 out 객체에 `default_think_time: src.default_think_time` 추가(R14 — 이게 빠지면 write-only).
- **쓰기**: `Edit` 유니온에 `{ type: "setDefaultThinkTime"; value: ThinkTime | undefined }` + `applyEdit` arm(값이면 `default_think_time` 맵 set, `undefined`면 키 삭제) — `setCookieJar` arm과 같은 모양.
- 스토어에 `setDefaultThinkTime(value)` 액션(기존 `dispatch` 경로 → doc 편집 → `parseScenarioDoc(serializeDoc(doc))`로 모델 재도출).

### 4.6 `ui/src/components/scenario/ScenarioDefaults.tsx`(신규) + `EditorShell.tsx` + `ko.ts` — 충족 R: R7, R12, R17
- 왼쪽 aside(`VariablesPanel` 아래)에 접이식 disclosure 섹션(사용자 선호 이디엄 — 접힌 채 값이 있으면 "설정됨" 힌트). 내용: think min/max 2칸(인스펙터와 같은 draft + commit-on-blur, 두 칸 모두 비면 키 제거, "한 칸만 채움"은 no-op), 규칙 한 줄(`min=max면 고정`), parallel 미적용 ⓘ HelpTip(이유 포함).
- **패널 개명(R17)**: 이 aside는 이제 변수 + 시나리오 기본값을 담으므로 토글 문구·`varsToggleAria`·`varsPanelAria`(현재 전부 "변수")의 **값만** 두 내용을 포괄하는 이름으로 개명(키는 유지 — 소비처가 심볼 참조라 테스트 churn 0; 정확한 문구는 plan에서 byte-exact 고정). 토글을 접으면 두 섹션이 함께 숨는 현행 동작은 유지하되, 라벨이 그 사실을 말해준다. `varsWide`("변수 넓게 보기") 모드는 `varsOpen` 토글을 `disabled`로 만들므로(`EditorShell.tsx:82`) 충돌 없음 — 문구 정합만 맞춘다. **`ko.editor.variablesTitle`(내부 h3)은 손대지 않는다.**
- 레이아웃: aside는 `overflow-visible` + 내부 리스트만 스크롤(뷰포트 높이 정책 v2). 새 섹션은 `VariablesPanel`(루트가 `flex-1` + 내부 `ul`이 `overflow-auto`) **아래** 형제 블록으로 두되 **`shrink-0`** — 안 그러면 `flex-1`과 세로 공간을 다툰다. 접힘 기본(값 있으면 "설정됨" 힌트) → 세로 소비 최소.

### 4.7 `ui/src/components/scenario/Inspector.tsx` — 충족 R: R8, R9, R10
페이싱 섹션에:
- 상속 힌트(기본값 존재 + 스텝 상속 중 + 분기 내부 아님일 때만).
- "이 스텝은 대기 없음" 체크박스 — 체크 시 `{min_ms:0,max_ms:0}` write **+ min/max 입력 disabled**, 해제 시 `undefined`(상속 복귀). 체크 상태는 `step.think_time`에서 파생(단일 소스).
- 분기 내부 스텝이면 미적용 안내(R9), 상속 힌트는 숨김.
- 기본값이 없으면 전부 현행 그대로(R10).

### 4.8 `ui/src/components/sizing.ts` · `openLoopChecks.ts` · `VuSizingHelper.tsx` — 충족 R: R15
- `iterationHoldMs(steps, perStepP50, fallbackMs, defaultThink?)`: http arm에서 `s.think_time ?? defaultThink`의 평균을 더하고, **parallel arm의 분기 재귀엔 `undefined`** 전달(엔진 R4 미러). 파라미터는 **후행 optional**이라 기존 호출/테스트는 그대로 green.
- `iterationTimeUpperBoundSeconds(steps, httpTimeoutSec, defaultThink?)`: 동일 규칙(`max_ms` 사용, 분기 재귀엔 미전달).
- **배선 지점 2곳(빠지면 순수함수 테스트만 green이고 추천은 계속 틀림 — R14와 같은 버그 계열)**: `SlotSizingHelper.tsx:48` `iterationHoldMs(scenario.steps, p50, rep.summary.mean_ms)` → `, scenario.default_think_time` 추가; `openLoopChecks.ts:89`(`openLoopWarnings` 내부) `iterationTimeUpperBoundSeconds(scenario.steps, httpTimeoutSeconds)` → 3번째 인자 추가. 두 곳 모두 `scenario`가 Zod 모델 타입(`Scenario`)이라 R2 머지 후 `default_think_time`을 그대로 들고 있다.
- `VuSizingHelper`의 `testRun.mutate`에 `apply_think_time: true` 추가 — `SlotSizingHelper`와 앵커 정의를 맞춘다(현재는 누락돼 측정 `iterMs`에서 think time이 통째 빠지고, 기본값 도입 후엔 두 헬퍼가 서로 다른 반복시간을 보고하게 된다). **주의: 이는 기존 per-step think time 사용자에게도 측정값이 달라지는 의도된 거동 변경**(정확해지는 방향) — build-log에 명시.

---

## 5. 무변경 / 불변식 (명시)

- **proto·워커·컨트롤러 API·DB migration 0-diff**(R6). `Profile.think_time`(반복 간, open-loop 금지 규칙 포함)·`validate_run_config`·리포트/인사이트·export 전부 무변경.
- **open-loop 정책(명시적 결정)**: 시나리오 기본값은 **open-loop에서도 적용된다** — per-step `think_time`이 이미 open-loop에 적용되고 있고(`run_arrival` → `execute_steps` → Http arm) 기본값은 그 상속일 뿐이다. 컨트롤러는 이를 **거부하지도 경고하지도 않는다**(`validate_run_config` 0-diff). run-level `Profile.think_time`을 open-loop에서 막는 기존 규칙(`api/runs.rs:301`)은 그대로 유지 — 그건 *반복 간* 페이싱이라 도착률 모델과 정면 충돌하기 때문이고, 스텝 대기는 반복 점유시간을 늘릴 뿐이라 `max_in_flight` 슬롯 사이징이 흡수한다(그래서 R15가 필수).
- **`executor.rs` byte-identical** — think time은 인터프리터 소관(S-B 경계 유지).
- **기본값 없는 시나리오**: YAML 직렬화·엔진 실행·UI 표시 전부 현행과 동일(R1, R10).
- **분기 스텝의 명시 `think_time`**: 현행대로 적용 — parallel 배제는 *기본값*에만 적용된다(R4).
- **parallel 노드는 기본값으로부터 대기를 전혀 얻지 않는다**(알려진 귀결): 분기 내부는 배제(R4)이고 그룹 뒤 대기는 §7 연기. 페이지 로드가 parallel로 표현된 시나리오는 기본값의 페이싱을 그 노드에서 못 받으므로, 필요하면 parallel 뒤에 오는 http 스텝의 대기로 표현한다.
- **test-run 트레이스 상한(알려진 제약)**: `WALL_CLOCK_CEILING_SECS = 120`(`api/test_runs.rs`)이라 기본값 × 스텝수가 크면 트레이스가 `truncated`가 되고, 두 사이징 헬퍼는 truncated 트레이스로는 계산을 거부한다(현행 UI가 이미 그 상태를 안내). 새 가드는 넣지 않는다(§7).
- 스텝 think time의 RNG·시드(`Profile.think_seed`) 경로 무변경 — 상속값도 같은 `think_rng`에서 뽑는다.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `cargo test -p handicap-engine` — scenario round-trip(있음/없음) | |
| R2 | `pnpm test` — model Zod(유효/`min>max`/600001/absent) | |
| R3 | `--test think_time` — 상속·override·0/0·기본값없음 (tokio time pause + 소요시간 단언, 기존 think_time 테스트 이디엄) | |
| R4 | `--test think_time` — parallel 분기 기본값 미적용 / 분기 명시값 적용 | |
| R5 | `--test trace_scenario` — apply on/off × 상속 스텝 | |
| R6 | `git diff master --stat` 경로 확인(최종 리뷰 게이트) | |
| R7 | `ScenarioDefaults.test.tsx` — write→reparse→`model.default_think_time` 일치 / 비우기→키 제거 | ✅ |
| R8 | `Inspector.test.tsx` — 상속 힌트, 체크박스 0/0 write + 입력 disabled, 해제→undefined | |
| R9 | `Inspector.test.tsx` — 분기 내부 안내 present·상속힌트 absent / 최상위 반대 | |
| R10 | 기존 엔진·UI 테스트 전부 green + `pnpm lint && pnpm test && pnpm build` | |
| R11 | `FlowOutline.test.tsx` — 상속 스텝 칩 부재(lock-in) | |
| R12 | `ko.test.ts` + 신규 컴포넌트 리터럴 한글 grep 0 | |
| R13 | `/live-verify`(아래) | ✅ |
| R14 | R7 왕복 테스트 + `yamlDoc.test.ts` — `default_think_time`이 든 YAML 파싱 시 모델에 보존 | |
| R15 | `sizing.test.ts` — 상속 스텝 hold에 기본값 포함·분기 내부 스텝엔 미포함(엔진 규칙 미러); `openLoopChecks.test.ts` 동일; `VuSizingHelper.test.tsx` — 페이로드 `apply_think_time: true` | |
| R16 | `--test vu_curve`(또는 think_time 곡선 케이스) — `vu_stages` run에서 상속 적용 | |
| R17 | `ko.test.ts` + `EditorShell.test.tsx` — 개명 문구, 토글이 두 섹션을 함께 접음 | |

**라이브(R13)** — CLAUDE.md S-B 레시피(python `ThreadingHTTPServer` 200-responder + **워크트리 자체 바이너리** + 격리 DB). **단위 주의**: 리포트 `summary.rps`는 *요청*/초(`total_count/duration`, `report.rs:614`)지 반복/초가 아니다 → 예측식은 **`rps ≈ VUs × 스텝수 ÷ (대기하는 스텝수 × think)`**(모든 스텝이 대기하면 스텝수가 상쇄돼 CLAUDE.md의 `VUs / think`와 같아진다).
1. 기본값 500ms(min=max) + http 3스텝 + 2 VU(전부 상속) → 반복 ≈ 1.5s → `summary.rps` ≈ **2 × 3 ÷ (3 × 0.5) = 4.0** (기본값 없을 때 대비 수백 배 하락 = 신호 명확).
2. 그중 한 스텝만 0/0 → 대기 지점 2곳 → 반복 ≈ 1.0s → `summary.rps` ≈ **2 × 3 ÷ (2 × 0.5) = 6.0**.
3. parallel 분기 스텝들엔 기본값이 안 걸림 → 그룹 레이턴시가 기본값만큼 늘지 않음(리포트 그룹/페이지 시간).
4. 에디터 GUI에서 기본값 입력 → YAML 반영 → 새로고침 후에도 읽힘(R14 write-only 회귀 방지) → run 생성까지 라운드트립.

**stale 바이너리 함정(둘 다)**: `Scenario`가 `deny_unknown_fields`라 ① 옛 **워커**는 `default_think_time`이 든 YAML을 파싱 못 해 run이 즉시 failed, ② 옛 **컨트롤러**는 `POST/PUT /api/scenarios`에서 `Scenario::from_yaml` 검증에 걸려 **422로 저장 자체를 거부**한다. 라이브 검증 전 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller`(워크트리 상대경로 실행).

---

## 7. 의도적 연기 (roadmap §A12 잔여 + §B21 신설에 누적)

- **run-level "전체 무시" 토글**: 시나리오를 안 건드리고 최대 처리량 baseline run을 뽑는 기능. `Profile` 필드 + proto + 워커 매핑 + `validate_run_config`가 붙는 별도 수직 슬라이스라 이번 요구(일괄 입력 편의)와 분리.
- **기본값의 run-level override**(run마다 다른 기본 think time): 같은 와이어 비용 + "시나리오가 부하 모델의 단일 소스"라는 현 구조와 충돌 소지 → 보류.
- **일괄-쓰기 버튼**(모든 스텝에 값 써넣기): 상속이 있으면 불필요(값 변경이 한 곳) — 사용자 확인 후 기각.
- **parallel 그룹 단위 대기**(분기들 *뒤*의 think time): 다른 개념이고 요구가 없다. §5의 "parallel은 기본값 대기를 못 받는다"가 불편해지면 그때.
- **test-run 120초 상한 가드**: 기본값이 크면 트레이스가 truncated → 사이징 헬퍼가 계산 거부(현행 안내 그대로). 전용 경고/부분 트레이스 사이징은 별도.
- **`cookie_jar` GUI 편집**: 이번에 "시나리오 기본값" 섹션이라는 자리가 생기지만, YAML 전용이 문제로 보고된 적 없어 스코프 밖.
- **§A12 잔여 2건**: HAR host-환경 힌트, 데이터셋 미리보기 — 별도 슬라이스.

---

## 8. 구현 순서 (plan 입력)

1. **엔진 계약 + 해석**(R1, R3, R4, R5, R16): `scenario.rs` 필드 → `runner.rs` 파라미터·해석·parallel `None`·**호출부 3곳** → `trace.rs` 쌍둥이 → `tests/think_time.rs`·`trace_scenario.rs`·곡선 케이스. Rust 단독 green 커밋.
2. **UI 계약(읽기·쓰기 왕복)**(R2, R7 절반, R14): `model.ts` Zod + `isInsideParallelBranch` + `yamlDoc.ts` **normalize 통과 + Edit arm** + `store.ts` 액션 + 단위 테스트. R1↔R2↔R14 seam이라 엔진과 **같은 브랜치에서 함께** 머지.
3. **사이징 패리티**(R15): `sizing.ts`·`openLoopChecks.ts` 파라미터 + parallel 미러 + `VuSizingHelper` `apply_think_time` + 테스트. (2번 뒤 — 모델에 `default_think_time`이 있어야 호출부가 넘길 수 있다.)
4. **UI 표면**(R7, R8, R9, R11, R12, R17): `ScenarioDefaults.tsx` 신규 + `EditorShell` 마운트·패널 개명 + `Inspector` 3상태/분기 안내 + `ko.ts` + 컴포넌트 테스트.
5. **라이브 검증**(R13): `/live-verify` — 워커·컨트롤러 재빌드 후 RPS·0/0·parallel·GUI 왕복.

- **tdd-guard**: `ui/src`를 건드리는 task는 **테스트 파일 편집을 먼저** 넣어야 첫 src 편집이 차단되지 않는다(각 task 스텝 순서에 명시).
- **cargo 게이트**: cargo-영향 커밋마다 워크스페이스 전체 빌드 → 1번은 테스트까지 한 커밋에 green fold.
