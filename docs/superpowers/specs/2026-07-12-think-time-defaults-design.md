# think-time-defaults — 시나리오-레벨 기본 think time + 스텝별 override (§A12 도그푸딩 2호)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12) → plan 대기
- **출처**: roadmap §A12 도그푸딩 백로그 "Think Time 일괄 지정". 사용자 원인 진술: *"스텝별로 하나하나 think time을 입력하는 게 귀찮아서, 일단 전체에 기본값을 입력한 후 특정 스텝만 별도 값으로."* §A12 잔여 3건 중 값이 가장 크고(부하 모델 정확도에 직결), 와이어 비용이 0이라 지금 한다.
- **연관**: ADR-0033(parallel 그룹/페이지 레이턴시), ADR-0003/0015(GUI↔YAML 양방향 sync), ADR-0035(ko 카탈로그), 슬라이스 S-B(per-step think time 도입), `2026-07-12-editor-var-conflict-quickadd-design.md`(§A12 1호).
- **ADR**: **신규 불필요** — ADR-0016(VU 실행 모델)·S-B가 정의한 think time 개념의 additive 확장이고, 새 실행 모델·저장소·프로토콜 결정이 없다. parallel 배제 규칙은 ADR-0033의 "그룹 레이턴시 = 페이지 로드 시간" 불변식을 *보존*하기 위한 귀결이라 그 ADR 범위 내.

---

## 1. 문제와 목표

지금 think time은 **스텝마다 개별 입력**만 가능하다(`HttpStep.think_time`, 인스펙터 페이싱 섹션). 20–30 스텝 시나리오에서 "사람처럼 요청 사이에 0.5–1초 쉬게 하라"를 표현하려면 같은 값을 20–30번 입력해야 하고, 그 값을 나중에 바꾸려면 다시 20–30번 고쳐야 한다. 그래서 실사용자는 think time을 아예 안 쓰고, 결과적으로 부하 모델이 비현실적(무휴식 폭주)으로 기운다.

- **목표**: 시나리오에 **기본 think time 한 곳**을 두고, 스텝은 (a) 상속 (b) 자기 값으로 override (c) "이 스텝만 대기 없음" 중 하나를 고른다. GUI(에디터 aside)와 YAML 양쪽에서 편집 가능(ADR-0003). 부하 경로·test-run 경로 모두 같은 규칙.
- **비목표(연기)**: §7 참조. run-level "전체 무시" 토글·기본값의 run-level override·일괄 쓰기 버튼.

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `Scenario`에 `default_think_time: Option<ThinkTime>` 필드를 추가한다 (`#[serde(default, skip_serializing_if = "Option::is_none")]`) — 필드가 없는 기존 시나리오 YAML은 파싱·직렬화 모두 byte-identical. | `cargo test -p handicap-engine scenario_default_think_time_round_trips_and_omits_when_absent` (round-trip + `!to_yaml().contains("default_think_time")`) | ✅ wire: UI Zod ↔ engine serde (짝 = R2) |
| R2 | MUST UI Zod `ScenarioModel`이 `default_think_time`을 optional로 수용하고 `min_ms ≤ max_ms ≤ 600000`을 검증한다(기존 `ThinkTimeModel` 재사용, `.strict()` 유지). | `pnpm test ui/src/scenario/__tests__/model.test.ts` — 유효/무효(min>max, 600001) 케이스 | ✅ wire: UI Zod ↔ engine serde (짝 = R1) |
| R3 | MUST 엔진 인터프리터가 http 스텝의 think time을 `step.think_time.or(default_think_time)`으로 해석한다 — 키 없음=상속, `{min_ms:0,max_ms:0}`=이 스텝만 대기 없음, 값=override. closed-loop·open-loop 두 경로 모두. | `cargo test -p handicap-engine --test think_time` (상속·override·0/0 opt-out·기본값 없음 3케이스; open-loop 경로 1케이스) | |
| R4 | MUST parallel 분기 서브트리(분기 안의 중첩 loop/if 포함)에는 기본값을 **적용하지 않는다**; 분기 스텝에 명시된 `think_time`은 지금처럼 적용된다(현행 거동 보존). | `cargo test -p handicap-engine --test think_time parallel_branch_ignores_scenario_default` (기본값 있는 시나리오에서 분기 스텝 소요시간이 기본값만큼 늘지 않음 + 명시값 있는 분기 스텝은 늘어남) | |
| R5 | MUST test-run trace 경로(`trace.rs`)도 R3/R4와 **같은 해석 규칙**을 쓰되, 실제 sleep은 `apply_think_time == true`일 때만 한다(현행 게이트 유지). | `cargo test -p handicap-engine --test trace_scenario` (apply on/off × 상속 스텝) | |
| R6 | MUST proto·워커·컨트롤러 와이어·DB migration은 **0-diff** — 시나리오는 `RunAssignment.scenario_yaml`로 통째 전송되므로 기본값이 자동으로 워커에 도달한다. | `git diff master --stat`에 `crates/proto/`·`migrations`·`Profile` 무변경 | |
| R7 | MUST 에디터 왼쪽 aside에 접이식 "시나리오 기본값" 섹션을 추가해 기본 think time을 설정·변경·제거할 수 있고, 편집이 YAML에 즉시 반영된다(GUI↔YAML 양방향, `setCookieJar` Edit 이디엄 재사용). | `pnpm test ScenarioDefaults.test.tsx` (min/max 입력 → `yamlText`에 `default_think_time` 등장; 두 칸 비우면 키 제거) + 라이브 | |
| R8 | MUST 인스펙터 페이싱 섹션이 3상태를 명시한다: 빈칸일 때 "시나리오 기본값 N–M ms 상속 중"(기본값이 있을 때만), "이 스텝은 대기 없음" 체크박스가 `{min_ms:0,max_ms:0}`을 쓰고 해제 시 키를 제거한다. | `pnpm test Inspector.test.tsx` (상속 힌트 표시/미표시, 체크박스 → 0/0 write, 해제 → undefined) | |
| R9 | MUST parallel 분기 **내부** http 스텝의 인스펙터는 "병렬 분기 내부라 시나리오 기본값이 적용되지 않는다 + 이유(동시 리소스 로딩이라 사람의 대기가 낄 자리가 아니고, 그룹/페이지 레이턴시 지표가 오염됨)"를 안내한다. | `pnpm test Inspector.test.tsx` (분기 내부 스텝 선택 시 안내 문구 present, 최상위 스텝엔 absent) | |
| R10 | MUST 기본값이 없는 시나리오의 UI·엔진 거동은 현행과 완전히 동일하다(회귀 0) — 인스펙터는 상속 힌트를 숨기고, 빈칸은 지금처럼 "대기 없음". | 기존 엔진/UI 테스트 전부 green + `pnpm build` | |
| R11 | SHOULD 아웃라인 wide 칩(`wideChipThink`)은 **스텝에 명시된 값만** 표시한다(상속값을 칩에 퍼뜨리지 않음 — 어디가 원본인지 흐려짐). | `FlowOutline.test.tsx` — 기본값만 있는 시나리오의 상속 스텝 칩에 think 칩 부재 | |
| R12 | MUST 신규 문구는 전부 `ui/src/i18n/ko.ts` 카탈로그 경유(ADR-0035), 하드코딩 0. | `ko.test.ts` 키 존재 + 컴포넌트에 리터럴 한글 0(grep) | |
| R13 | MUST 라이브 부하 경로에서 상속이 실제로 걸린다: closed-loop에서 기본값만 켠 시나리오의 RPS가 `VUs ÷ (스텝수 × think_ms)` 예측대로 떨어지고, 0/0 opt-out 스텝은 쉬지 않으며, parallel 그룹 레이턴시는 기본값만큼 늘지 않는다. | `/live-verify` — 리포트 `summary.rps` 실측 + parallel 그룹 p50 비교 | ✅ 라이브 |

- **seam 짝(R1↔R2)**: 엔진 serde와 UI Zod가 같은 YAML 키를 소유한다. UI Zod는 `.strict()`라 **엔진만 먼저 머지되면 기본값이 든 YAML을 에디터가 거부**한다 → 두 R은 같은 브랜치에서 함께 머지한다(plan §8 순서가 강제).

---

## 3. 핵심 통찰 (설계 근거)

1. **와이어 비용이 0이다.** 시나리오는 `RunAssignment.scenario_yaml`(proto field 2)로 **통째 스냅샷 전송**되고 워커가 `Scenario`로 파싱한다. 따라서 시나리오-레벨 필드는 proto/컨트롤러/DB를 전혀 건드리지 않는다(R6). 로드맵이 적어둔 "엔진 serde + 와이어 수직 슬라이스"보다 실제 스코프가 좁다. 반대로 *run-level* 킬스위치(`Profile`)를 넣었다면 proto 필드 + 워커 매핑 + `validate_run_config`가 붙었을 것 — 그래서 §7로 연기했다.

2. **3상태를 새 타입 없이 표현한다.** `Option<ThinkTime>`의 `None`을 "상속"으로 재해석하고, "대기 없음"은 `{min_ms:0, max_ms:0}`이 맡는다. 엔진의 `pace()`는 이미 zero duration에서 즉시 복귀하므로(`capped.is_zero() → Slept`) **0/0은 지금도 정확히 '대기 없음'**이다. 명시 센티널(`think_time: none`)은 serde untagged enum + Zod union + yamlDoc 왕복을 새로 요구해 모델 복잡도만 올린다 → 기각(사용자 확인).

3. **parallel 배제는 규칙이 아니라 구조로 강제한다.** `execute_steps`에 `default_think: Option<ThinkTime>` 파라미터를 하나 추가하고, **parallel arm이 분기 재귀 호출에 `None`을 넘긴다**. 그러면 "분기 서브트리 전체(중첩 loop/if 포함) 미적용"이 코드 한 지점에서 나오고, 나중에 누군가 분기 안에 loop를 넣어도 규칙이 새지 않는다(R4). 근거: parallel은 브라우저가 페이지 리소스를 **동시에** 받는 구간이라 사람의 생각 시간이 낄 자리가 아니며, ADR-0033의 그룹 시간(`elapsed_us` = max(branches) ≈ 페이지 로드 시간)이 수면 시간만큼 부풀어 **지표가 오염**된다. 분기 스텝에 사용자가 *직접* 적은 값은 현행대로 적용(명시 > 암묵).

4. **해석 지점은 인터프리터뿐.** `execute_step`(executor)은 손대지 않는다 — S-B가 정한 경계(think time은 인터프리터가, 요청은 executor가)를 그대로 유지해 실행기 byte-identical.

5. **시나리오-레벨 편집 이디엄이 이미 있다.** 스토어엔 `setCookieJar`(scenario-level Edit → `applyEdit` → yamlDoc)가 살아 있고 UI만 없었다. `setDefaultThinkTime`은 그 패턴을 그대로 복제하므로 store/yamlDoc에 새 개념이 없다. 이 슬라이스가 만드는 aside "시나리오 기본값" 섹션은 향후 `cookie_jar` 같은 시나리오-레벨 설정의 자리도 된다(이번 스코프 밖 — §7).

---

## 4. 변경 상세

### 4.1 `crates/engine/src/scenario.rs` — 충족 R: R1
`Scenario` 구조체에 필드 추가(문서 주석: 상속/0-0/override 3상태 + parallel 미적용 규칙 명시):
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub default_think_time: Option<ThinkTime>,
```
`deny_unknown_fields`는 유지. 리터럴 생산지 3곳(`scenario.rs` 내부 테스트, `tests/proptests.rs`)에 `default_think_time: None` 추가.

### 4.2 `crates/engine/src/runner.rs` — 충족 R: R3, R4
- `execute_steps(...)` 시그니처에 `default_think: Option<ThinkTime>` 추가(`#[allow(clippy::too_many_arguments)]` 이미 있음).
- Http arm: 현행 `if let Some(tt) = &http.think_time` → `if let Some(tt) = http.think_time.or(default_think)` (ThinkTime은 `Copy`).
- Parallel arm: 분기 `execute_steps` 재귀 호출에 **`None`** 전달.
- Loop/If arm: `default_think` 그대로 전달.
- 호출부 2곳(closed-loop `run_vu`, open-loop VU 경로)에서 `scenario.default_think_time` 전달. run-level `plan.think_time`(반복 간)은 무관 — 그대로.

### 4.3 `crates/engine/src/trace.rs` — 충족 R: R5
`trace_steps`에도 같은 파라미터 추가, 같은 해석·같은 parallel 배제. sleep 자체는 기존 `opts.apply_think_time` 게이트 안에서만. 진입점에서 `scenario.default_think_time` 전달.

### 4.4 `ui/src/scenario/model.ts` — 충족 R: R2, R9
- `ScenarioModel`에 `default_think_time: ThinkTimeModel.optional()`.
- 신규 순수 헬퍼 `isInsideParallelBranch(model, stepId): boolean` — 스텝 트리를 걸으며 parallel 분기 서브트리 안이면 true(중첩 loop/if 포함). 인스펙터 R9 안내와 (필요 시) 테스트가 소비.

### 4.5 `ui/src/scenario/yamlDoc.ts` + `store.ts` — 충족 R: R7
`Edit` 유니온에 `{ type: "setDefaultThinkTime"; value: ThinkTime | undefined }` 추가 + `applyEdit` arm(값이면 `doc.set("default_think_time", {min_ms,max_ms})`, undefined면 키 삭제). 스토어에 `setDefaultThinkTime(value)` 액션 — `setCookieJar`와 동일한 `dispatch` 경로.

### 4.6 `ui/src/components/scenario/ScenarioDefaults.tsx` (신규) + `EditorShell.tsx` — 충족 R: R7, R12
왼쪽 aside(VariablesPanel 아래)에 접이식 disclosure 섹션(사용자 선호 이디엄 — 값이 있으면 접힌 채 "설정됨" 힌트). 내용: think min/max 입력 2칸(인스펙터와 같은 draft+commit-on-blur 패턴, 두 칸 모두 비면 키 제거), 규칙 한 줄(`min=max면 고정`), parallel 미적용 ⓘ HelpTip(이유 포함).

### 4.7 `ui/src/components/scenario/Inspector.tsx` — 충족 R: R8, R9, R10
페이싱 섹션에:
- 기본값이 있고 스텝이 상속 중일 때 상속 힌트("시나리오 기본값 N–M ms 상속 중"). 기본값이 없으면 현행 문구 유지(R10).
- "이 스텝은 대기 없음" 체크박스 — 체크 시 `{min_ms:0,max_ms:0}` write, 해제 시 `undefined`(상속으로 복귀). min/max 입력에 0/0이 들어오면 체크박스가 켜진 상태로 보이도록 파생(단일 소스는 `step.think_time`).
- 분기 내부 스텝이면(`isInsideParallelBranch`) 미적용 안내(R9) — 이때 상속 힌트는 숨긴다(모순 방지).

### 4.8 `ui/src/i18n/ko.ts` — 충족 R: R12
신규 키(예): `editor.scenarioDefaultsTitle`, `editor.defaultThinkHint`, `editor.defaultThinkParallelNote`(이유 포함), `editor.inheritedThink(min,max)`, `editor.stepNoWait`, `editor.parallelNoDefault`. 문구는 plan에서 byte-exact 고정.

---

## 5. 무변경 / 불변식 (명시)

- **proto·워커·컨트롤러·DB migration 0-diff**(R6). `Profile.think_time`(반복 간, open-loop 금지 규칙 포함)·`validate_run_config`·리포트/인사이트·export 전부 무변경.
- **`executor.rs` byte-identical** — think time은 인터프리터 소관(S-B 경계 유지).
- **기본값 없는 시나리오**: YAML 직렬화·엔진 실행·UI 표시 전부 현행과 동일(R1, R10).
- **분기 스텝의 명시 `think_time`**: 현행대로 적용(R4) — parallel 배제는 *기본값*에만 적용된다.
- **아웃라인 칩·test-run 토글 문구**: 기존 그대로(R11).
- 스텝 think time의 RNG·시드(`Profile.think_seed`) 경로 무변경 — 상속값도 같은 `think_rng`에서 뽑는다.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `cargo test -p handicap-engine` scenario round-trip(있음/없음) | |
| R2 | `pnpm test` model Zod(유효/min>max/600001/absent) | |
| R3 | `cargo test -p handicap-engine --test think_time` — 상속·override·0/0·기본값없음 + open-loop 1케이스 (tokio time pause + 소요시간 단언, 기존 think_time 테스트 이디엄) | |
| R4 | 같은 테스트 파일 — parallel 분기 기본값 미적용 / 분기 명시값 적용 | |
| R5 | `--test trace_scenario` — apply on/off × 상속 스텝 | |
| R6 | `git diff master --stat` 경로 확인(리뷰 게이트) | |
| R7 | `ScenarioDefaults.test.tsx` — 입력→YAML 키 등장, 비우기→키 제거 | ✅ |
| R8 | `Inspector.test.tsx` — 상속 힌트/체크박스 0/0 write·해제 | |
| R9 | `Inspector.test.tsx` — 분기 내부 스텝 안내 present, 최상위 absent | |
| R10 | 기존 엔진·UI 테스트 전부 green + `pnpm lint && pnpm test && pnpm build` | |
| R11 | `FlowOutline.test.tsx` — 상속 스텝 칩 부재 | |
| R12 | `ko.test.ts` + 컴포넌트 리터럴 한글 grep 0 | |
| R13 | `/live-verify`: ① 기본값 500/500 + 3 http 스텝 + 2 VU → RPS ≈ 2÷(3×0.5s) ≈ 1.33 실측(기본값 없을 때 대비 수백배 하락) ② 한 스텝 0/0 → RPS 상승분이 예측과 일치 ③ parallel 그룹 p50이 기본값만큼 늘지 않음(리포트 그룹 레이턴시) ④ 에디터 GUI에서 기본값 입력 → YAML 반영 → run 생성까지 라운드트립 | ✅ |

- 라이브는 CLAUDE.md S-B 레시피(python `ThreadingHTTPServer` 200-responder + 워크트리 자체 바이너리 + 격리 DB). **워커 재빌드 필수** — `Scenario`가 `deny_unknown_fields`라 stale 워커는 `default_think_time`이 든 YAML을 파싱하지 못해 run이 즉시 failed가 된다(루트 CLAUDE.md 함정).

---

## 7. 의도적 연기 (roadmap §A12 잔여 + §B21 신설에 누적)

- **run-level "전체 무시" 토글**: RunDialog 체크박스로 시나리오를 안 건드리고 최대 처리량 baseline run을 뽑는 기능. `Profile` 필드 + proto + 워커 매핑 + `validate_run_config`가 붙는 별도 수직 슬라이스라 이번 요구(=일괄 입력 편의)와 분리. 필요해지면 그때.
- **기본값의 run-level override**(run마다 다른 기본 think time): 위와 같은 와이어 비용 + "시나리오가 부하 모델의 단일 소스"라는 현 구조와 충돌 소지 → 보류.
- **일괄-쓰기 버튼**(모든 스텝에 값 써넣기): 상속이 있으면 불필요(값 변경이 한 곳). 사용자 확인 후 기각.
- **`cookie_jar` GUI 편집**: 이번에 aside "시나리오 기본값" 섹션이라는 자리가 생기지만, YAML 전용이라는 현행이 문제로 보고된 적 없어 스코프 밖.
- **parallel 그룹 단위 대기**(분기들 *사이*의 think time): 다른 개념(그룹 후 대기)이고 요구가 없다.
- **§A12 잔여 2건**: HAR host-환경 힌트, 데이터셋 미리보기 — 별도 슬라이스.

---

## 8. 구현 순서 (plan 입력)

1. **엔진 계약 + 해석**(R1, R3, R4, R5): `scenario.rs` 필드 → `runner.rs`/`trace.rs` 파라미터·해석·parallel `None` → `tests/think_time.rs`·`trace_scenario.rs` 확장. Rust 단독 green 커밋.
2. **UI 계약**(R2, R7 스토어 절반): `model.ts` Zod + `isInsideParallelBranch` 헬퍼 + `yamlDoc.ts` Edit + `store.ts` 액션 + 단위 테스트. (엔진과 같은 브랜치에서 머지 — seam 짝 R1↔R2.)
3. **UI 표면**(R7, R8, R9, R11, R12): `ScenarioDefaults.tsx` 신규 + `EditorShell` 마운트 + `Inspector` 3상태/분기 안내 + `ko.ts` 문구 + 컴포넌트 테스트.
4. **라이브 검증**(R13): `/live-verify` — 워커 재빌드 후 RPS·0/0·parallel 그룹 레이턴시 실측 + 에디터 GUI 라운드트립.
