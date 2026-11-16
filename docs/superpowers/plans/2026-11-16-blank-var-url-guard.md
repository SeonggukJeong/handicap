# 비워진 값의 주소 전송 차단 (blank-var-url-guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조건 반복 본문에서 못 뽑아 `""`가 된 변수를 요청 주소에 쓰는 http 스텝은 전송하지 않고 스텝 에러로 세며, 시험 실행·운영 모니터·리포트·인쇄 보고서가 그 사실을 "앞 스텝이 값을 주지 않아 보내지 않음"으로 보여 준다.

**Architecture:** 엔진이 반복 변수 표와 같은 수명의 *비움 표*(이름 → 그 값을 비운 스텝 id)를 `execute_steps`/`trace_steps`에 나란히 넘기고, http 스텝 실행 직전에 주소 템플릿이 읽는 이름을 비움 표와 대조해 차단한다. 부하 경로는 집계기의 새 "보내지 않음" 길(요청 수·에러 수만)과 에러 분류 `blank_var`로, trace 경로는 `StepTrace.blocked` 선택 필드로 알린다. 컨트롤러는 `blocked` 행을 「앞 단계 실패」로 판정하고 리포트 스텝 행에 `not_sent`를 싣는다.

**Tech Stack:** Rust(engine·controller·tui), TypeScript/React(ui), vitest, cargo nextest.

**Spec:** `docs/superpowers/specs/2026-11-16-blank-var-url-guard-design.md` — 이 plan은 spec의 R0–R6·§5·§7을 그대로 구현한다. 구현자는 spec도 함께 읽는다.

REVIEW-GATE: APPROVED

## Global Constraints

- **R0**: 비워진 이름을 주소에 쓰지 않는 시나리오·조건 반복이 없는 시나리오는 전송 요청·메트릭·리포트 JSON·trace JSON·모니터 판정이 지금과 같다. 새 필드 `StepTrace.blocked`·`ReportStep.not_sent`는 없을 때 직렬화 생략. proto 필드 추가·migration 없음.
- 차단 대상은 **주소(`request.url`)의 flow 토큰**뿐. 헤더·본문·`${ENV}`·시스템 토큰은 대상이 아니다.
- runner(`execute_steps`)와 trace(`trace_steps`)는 같은 규칙이어야 한다(lockstep).
- 값은 어디에도 싣지 않는다 — `blocked`·사유·상세·문구에는 변수 **이름**과 스텝 이름/id만.
- 고정 문자열: 에러 분류 `blank_var` · trace 행 에러 `not sent: blank value in url` · 모니터 사유 `REASON_UPSTREAM`(「앞 단계 실패」, 새 사유 없음) · 상세 꼬리 `REASON_NO_VALUE`(「값 없음」).
- UI 문구는 전부 `ui/src/i18n/ko.ts` 경유(ADR-0035). 정본:
  - 분류 라벨 `blank_var`: `보내지 않음 (앞 스텝 값 없음)`
  - trace 행 문구: `앞 스텝 ${step}이(가) ${vars} 값을 주지 않아 요청을 보내지 않음` (`vars`는 `, `로 연결)
  - 인쇄 열 머리: `보내지 않음` / 인쇄 용어 설명: `앞 스텝이 값을 주지 않아 요청을 보내지 않음` / 인쇄 요약 문장 꼬리: `앞 스텝이 값을 주지 않아 요청을 보내지 않았습니다.`
- 커밋 규칙: 각 task는 독립 green 커밋. 커밋·게이트에 파이프 금지, `--no-verify` 금지, cargo-영향 커밋은 수 분 걸린다. `ui/src`·`crates/*/src` 편집은 테스트 파일을 먼저 고쳐 pending test를 만든 뒤에 한다(tdd-guard).
- 회귀 가드를 표방하는 테스트는 차단 판정(또는 해당 가지)을 꺼서 RED → 되돌려 GREEN을 실제로 확인하고 report에 그 명령과 결과를 적는다.

## Review Focus

1. **토큰 모양으로 차단을 빠져나감** — `{{ orderId }}`(공백), `{{branch.orderId}}`(분기 접두), `${X:-{{a}}}`(토큰 아님)에서 차단 판정이 엄격 렌더와 다른 이름을 읽으면 빈 주소가 나간다. → Task 1 테스트.
2. **비움 표가 반복을 넘어 살아남음** — 표는 `&mut` 인자라 안 넘기는 실수는 컴파일러가 막지만, 세 진입점 중 하나가 표를 반복 **밖**에 한 번만 만들면 앞 반복에서 비워진 이름이 다음 반복의 정당한 요청을 막는다(`run_scenario`만 타는 테스트는 곡선·open-loop의 이 실수를 못 본다). → Task 3 `table_resets_each_iteration_{closed,curve,open}`.
3. **while 없는 loop 안에서 차단이 반복** — `loop repeat: 1000000 { GET /x/{{orderId}} }`가 trace 행을 상한 없이 쌓으면 컨트롤러 메모리를 먹는다. → Task 4 테스트(요청 수 상한에서 `truncated`).
4. **같은 이름을 다시 뽑아 값이 생겼는데 계속 차단**(거짓 차단) / 응답이 정말 빈 문자열을 줬는데 차단. → Task 1·3 테스트.
5. **차단만 있는 run의 리포트 화면이 통째로 깨짐** — `ReportStepSchema`가 `.strict()`라 `not_sent` 키를 모르면 파싱 실패. → Task 6이 Zod 한 줄을 같은 커밋에 넣고 파싱 테스트.

---

### Task 1: 비움 표와 차단 판정 (엔진 순수 함수)

**Files:**
- Create: `crates/engine/src/blank_guard.rs`
- Modify: `crates/engine/src/template.rs`(`render_inner` 수집기 확장), `crates/engine/src/lib.rs`(`pub mod blank_guard;` + 재수출)
- Test: `crates/engine/src/blank_guard.rs` 인라인 `#[cfg(test)]`, `crates/engine/src/template.rs` 인라인

**Interfaces — Produces:**

```rust
// template.rs — 네 번째 진입점. lenient 렌더 + flow 변수 표에서 **실제로 읽힌**(vars에 있던) 이름을
// 나온 순서대로 `reads`에 push(중복 가능). 기존 render/render_lenient/render_collecting은 출력 불변.
pub fn render_collecting_reads(input: &str, ctx: &TemplateContext, reads: &mut Vec<String>) -> String;

// blank_guard.rs
pub type BlankTable = std::collections::BTreeMap<String, String>; // 이름 → 그 값을 비운 http 스텝 id
pub const BLOCKED_ERROR: &str = "not sent: blank value in url";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocked { pub vars: Vec<String>, pub by_step: String, pub url: String }

/// R2: 주소가 읽는 이름 중 (비움 표에 있고 ∧ ctx.vars 값이 지금도 "")인 것이 있으면 Some.
/// vars = 주소에 나온 순서·중복 제거, by_step = 첫 이름의 원인, url = lenient 렌더 결과.
pub fn check(url_template: &str, ctx: &TemplateContext, table: &BlankTable) -> Option<Blocked>;

/// 정상 실행된 http 스텝 뒤: `blanked`(blank_missing_extracts 반환)에 든 이름은 table에
/// (이름 → step_id)로 적고, `extracted`의 나머지 키는 table에서 지운다.
pub fn note_step(table: &mut BlankTable, step_id: &str, extracted: &BTreeMap<String, String>, blanked: &[String]);

/// parallel 병합: `names`(= Branch::output_var_names()) 중 `branch_vars`에 있는 k마다
/// key = "{branch_name}.{k}" — branch_table에 k가 있으면 parent에 (key → 그 원인) 삽입, 없으면 parent에서 key 제거.
pub fn merge_branch(parent: &mut BlankTable, branch_table: &BlankTable, branch_name: &str,
                    names: &[&str], branch_vars: &BTreeMap<String, String>);
```

`render_inner`의 수집 인자를 "미해결 이름"과 "읽힌 flow 이름" 두 sink를 담는 형태로 넓히되, 기존 세 진입점은 읽힌-이름 sink를 `None`으로 넘겨 동작·출력이 그대로여야 한다. `${…}` 가지에서는 읽힌 이름을 수집하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `template.rs` 인라인 `collecting_reads_leaves_other_entries_unchanged`(같은 입력 6종에 대해 `render_lenient`·`render_collecting`의 출력과 `render_collecting`의 미해결 목록이 이 변경 전 기대값 그대로이고, `render_collecting_reads`의 출력 문자열이 `render_lenient`와 같다) + `blank_guard.rs` 인라인 테스트(모듈 골격 + `todo!()` 본문과 함께 작성해 컴파일되게 한다):
  - `reads_follow_strict_tokenizer`: 입력 `"/a/{{ orderId }}/{{b.orderId}}/${X:-{{a}}}"`, vars `{orderId:"1","b.orderId":"2",a:"3"}` → `reads == ["orderId","b.orderId"]`(`a` 없음), 반환 문자열이 `render`(strict, env에 X 없음 → 기본값 `{{a`… 규칙 그대로)와 **같은 글자**.
  - `check_blocks_blank_in_url`: table `{orderId:"S1"}`, vars `{orderId:""}`, url `"/orders/{{orderId}}"` → `Some(Blocked{vars:["orderId"], by_step:"S1", url:"/orders/"})`.
  - `check_passes_when_value_refilled`: 같은 table, vars `{orderId:"7"}` → `None`.
  - `check_passes_when_not_in_table`: table 비어 있음, vars `{orderId:""}` → `None`(응답이 준 빈 문자열).
  - `check_ignores_env_and_system`: url `"${BASE}/x/${vu_id}"`, table `{BASE:"S1", vu_id:"S1"}`, **vars `{BASE:"", vu_id:""}`**(조건 2·3을 모두 참으로 만들어 조건 1만 남긴다 — vars가 비면 조건 3이 거짓이라 `${…}` 이름을 잘못 수집해도 통과한다) → `None`.
  - `check_orders_and_dedups`: url `"/{{b}}/{{a}}/{{b}}"`, table `{a:"S1", b:"S2"}`, 둘 다 `""` → vars `["b","a"]`, by_step `"S2"`.
  - `check_wins_over_unknown_var`: url `"/{{orderId}}/{{nope}}"`, table `{orderId:"S1"}`, vars `{orderId:""}` → `Some`(패닉·Err 없음).
  - `note_step_sets_and_clears`: table `{a:"S0"}` → `note_step(t,"S1",{a:"", b:""}, ["b"])` 뒤 `t == {b:"S1"}`(a는 실제로 뽑힘 → 제거).
  - `merge_branch_prefixes_and_clears`: parent `{"br.v":"OLD","br.w":"OLD"}`, branch_table `{v:"S9"}`, names `["v","w"]`, branch_vars `{v:"", w:"ok"}` → parent `{"br.v":"S9"}`.
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine blank_guard` → `todo!()` 패닉으로 실패.
- [ ] **Step 3: 구현** — 위 시그니처대로. `check`는 `render_collecting_reads` 한 번으로 url과 읽힌 이름을 얻는다.
- [ ] **Step 4: GREEN 확인** — `cargo nextest run -p handicap-engine blank_guard template` 전부 통과. 기존 template 테스트 무변경 통과.
- [ ] **Step 5: 이빨 실증** — `check`의 조건 3(값이 지금도 `""`)을 임시로 빼면 `check_passes_when_value_refilled`가 RED인지 확인 후 되돌린다.
- [ ] **Step 6: 커밋** — `feat(engine): 비움 표와 주소 차단 판정 (blank-var-url-guard)`

---

### Task 2: 집계기 "보내지 않음" 길과 분류 `blank_var`

**Files:**
- Modify: `crates/engine/src/aggregator.rs`(`StepWindow`, `Aggregator`), `crates/engine/src/error_kind.rs`, `crates/proto/proto/coordinator.proto`(`ErrorKindStat.kind` 주석의 종류 나열에 `blank_var` 추가 — 필드 변경 없음)
- Test: `crates/engine/src/aggregator.rs` 인라인, `crates/engine/src/error_kind.rs` 인라인

**Interfaces — Produces:**

```rust
// error_kind.rs — 9번째 변형. classify_send_error는 이 값을 절대 만들지 않는다.
ErrorKind::BlankVar  // as_str() == "blank_var"

// aggregator.rs
impl Aggregator {
    /// 보내지 않은 요청 1건: 그 스텝의 현재 초 창에 count+1, error_count+1,
    /// loop_index가 있으면 loop_counts도 `record`와 같은 규칙(cap·overflow 포함)으로 +1.
    /// 히스토그램·status_counts는 건드리지 않는다.
    pub fn record_not_sent(&mut self, step_id: &str, loop_index: Option<u32>);
}
```

- [ ] **Step 1: 실패하는 테스트** —
  - `not_sent_counts_without_sample_or_status`: `record_not_sent("s", None)` 2회 뒤 `drain_all()`의 그 창이 `count == 2`, `error_count == 2`, `status_counts.is_empty()`, 히스토그램 표본 수 0.
  - `not_sent_updates_loop_counts`: `Aggregator::new(8)`에서 `record_not_sent("s", Some(3))` 뒤 `drain_loop_deltas()`에 `(s, 3)` 건수 1·에러 1(기존 `record`가 에러를 loop 칸에 세는 방식과 같게 — `record`의 loop 갱신 코드를 그대로 따른다).
  - `not_sent_mixed_with_real`: `record("s", 5_000, 200, false, None)` 1회 + `record_not_sent` 1회 → `count == 2`, `status_counts == {200:1}`, 히스토그램 표본 1.
  - `blank_var_wire_name`: `ErrorKind::BlankVar.as_str() == "blank_var"`.
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine not_sent blank_var_wire_name` 컴파일 실패(메서드 없음).
- [ ] **Step 3: 구현** — `StepWindow`에 표본 없이 세는 메서드, `Aggregator::record_not_sent`. `ErrorKind` match가 있는 곳은 컴파일러가 알려 준다(워크스페이스 전체 `cargo build --workspace --tests`).
- [ ] **Step 4: GREEN + 전수** — `cargo nextest run -p handicap-engine`.
- [ ] **Step 5: 커밋** — `feat(engine): 보내지 않은 요청 집계 길과 blank_var 분류`

---

### Task 3: runner 배선 (부하 경로 세 진입점)

**Files:**
- Modify: `crates/engine/src/runner.rs` — `execute_steps` 시그니처에 `blanked: &mut BlankTable` 추가(`iter_vars` 바로 뒤), 호출부 8곳(`grep -n "execute_steps(" crates/engine/src/runner.rs`로 확정: 비재귀 3 = `run_vu`·`run_vu_curve`·`run_arrival`, 재귀 4, 정의 1), `Step::Http` 가지, `Step::Parallel` 병합
- Test: Create `crates/engine/tests/blank_guard.rs`; Modify `crates/engine/tests/error_kind_flush.rs`(등식 주석·단언을 "status `0` = `blank_var`를 뺀 분류 합"으로)

**Interfaces — Consumes:** Task 1 `blank_guard::{BlankTable, check, note_step, merge_branch}`, Task 2 `record_not_sent`·`ErrorKind::BlankVar`.

**동작(Http 가지, 순서 고정):**
1. `rg.refresh` → `ctx` 구성 → `blank_guard::check(&http.request.url, &ctx, blanked)`.
2. `Some(_)`이면(차단): `ctx`를 놓은 뒤 — 조건 반복 안(`cond_pass.is_some()`)이면 `blank_missing_extracts(http, &mut 빈 맵, iter_vars)`로 선언 이름을 전부 비우고 그 이름들을 `blanked`에 `(이름 → http.id)`로 적는다(`mark_written` 호출 없음). `agg.lock()` 한 번 안에서 `record_not_sent(&http.id, loop_index)` + `record_error_kind(&http.id, ErrorKind::BlankVar)`. `PassSamples`에 넣지 않고 `record_phase`도 없다. 그다음 **기존과 같은 think time 블록**(지금 Http 가지 끝의 `pace` 호출 — 복제하지 말고 두 경로가 같이 타게 구조를 잡는다)을 타고 다음 스텝으로(`Continue`).
3. `None`이면 기존 흐름 그대로 + `blank_missing_extracts`의 반환(지금은 버린다)을 받아 `iter_vars.extend` 앞뒤 어디서든 `blank_guard::note_step(blanked, &http.id, &outcome.extracted, &names)` 호출(strict 모드면 `names`는 빈 슬라이스).

**Parallel 가지:** 분기마다 `blanked.clone()`을 넘기고(분기 future가 `iter_vars` 복제본을 받는 자리와 같은 방식), 병합 루프에서 변수 삽입과 나란히 `blank_guard::merge_branch(blanked, &branch_table, &branch.name, &branch.output_var_names(), &branch_vars)`. 분기 future를 만들기 전에 `entry`(변수 복제본)와 같은 자리에서 `let entry_blanked = blanked.clone();`을 한 번 뜨고, 분기마다 그 복제본을 future 안으로 옮긴다. 결과 튜플 `(branch, branch_vars, flow, branch_us)`에 분기의 표를 다섯째 요소로 실어 온다.

**세 진입점:** `let mut iter_vars` 바로 옆(`grep -n "let mut iter_vars" crates/engine/src/runner.rs` — 3곳)에 `let mut blanked = BlankTable::new();`를 두고 넘긴다. 반복마다 새로 만든다.

- [ ] **Step 1: 실패하는 테스트** — `crates/engine/tests/blank_guard.rs`. 접수 건수를 세는 wiremock 서버를 쓴다(기존 `tests/loop_while.rs`의 서버·시나리오 헬퍼 이디엄을 따른다). 공통 시나리오 Y1: `loop(while {{code}} eq WAIT, repeat 3) { GET /poll extract body $.orderId→orderId, $.code→code }` → `DELETE /orders/{{orderId}}` → `GET /after`. `/poll`은 `{}`(둘 다 없음)을 200으로 준다. 테스트는 `tests/loop_split.rs`의 `run_mode(yaml, ms, mode)` 헬퍼(open이면 `target_rps`·`max_in_flight`, 곡선이면 `vu_stages`를 내장)와 같은 방식으로 **진입점을 모드로 갈라 직접 spawn**한다(`tests/think_time.rs`의 `Mode`는 그 설정을 `tweak`로 따로 넣어야 해서 빠뜨리기 쉽다).
  - `blocked_url_is_not_sent_{closed,curve,open}`(3건): run 뒤 서버가 받은 요청 중 경로가 `/orders/`로 시작하는 것이 **0건**, `/after`는 1건 이상(뒤 스텝 계속). DELETE 스텝 창 합계 `count > 0 && count == error_count`, `status_counts` 비어 있음, 히스토그램 표본 0. `error_kind_stats`에 `(DELETE 스텝, "blank_var")` 건수 == 그 스텝 `count`.
  - `header_and_body_use_still_sent`: Y1의 DELETE를 `POST /orders` + 헤더 `X-Id: {{orderId}}` + JSON 본문 `{"id":"{{orderId}}"}`로 바꾸면 `/orders` 접수 ≥ 1(R0·범위).
  - `reextract_unblocks`: `/poll`이 **첫 1회만** `{"code":"WAIT"}`(`up_to_n_times(1)`), 그 뒤로는 항상 `{"code":"DONE","orderId":"7"}` → `/orders/7` 접수 ≥ 1, `blank_var` 0건. (대체 응답이 없으면 다음 반복부터 404로 값이 다시 비어 거짓 실패한다.)
  - `real_empty_after_blank_clears_table`: `/poll`이 첫 1회만 `{"code":"WAIT"}`, 그 뒤로는 항상 `{"code":"DONE","orderId":""}`(실제 빈 문자열) → `/orders/` 접수 ≥ 1, `blank_var` 0건. 비움 표에서 **지우는 배선**(`note_step`)을 보는 유일한 모양이다 — `reextract_unblocks`는 값이 `"7"`이라 조건 3만으로 통과한다.
  - `table_resets_each_iteration_{closed,curve,open}`(3건): 시나리오 `variables: {orderId: ""}` + **조건 반복 앞**에 `GET /pre/{{orderId}}` → Y1의 loop. 여러 반복(각 모드 5회 이상 돌 만큼) 뒤 `/pre/` 접수 건수 == 그 스텝 `count`이고 그 스텝 `blank_var` 0건(사용자가 넣은 빈 값은 막지 않는다 — spec §4. 표가 반복을 넘어 살면 2회차부터 막힌다).
  - `blank_plus_unknown_var_does_not_kill_vu`: DELETE 주소를 `/orders/{{orderId}}/{{nope}}`로 → run이 `AllVusFailed` 없이 끝나고 `/after` 접수 ≥ 2(VU가 다음 반복도 돈다).
  - `blocked_step_still_paces`: DELETE 스텝에 `think_time: {min_ms: 200, max_ms: 200}`, 1 VU·1초 → DELETE 스텝 `count` ≤ 6(think가 없으면 수백 건).
  - `real_empty_string_not_blocked`: `/poll`이 `{"orderId":"","code":"DONE"}` → `/orders/` 접수 ≥ 1(응답이 준 빈 문자열은 그대로 — 지금 동작 유지).
  - `later_body_step_blocked_in_same_pass`: 본문을 `GET /poll` → `GET /detail/{{orderId}}` 두 스텝으로. `/detail/` 접수 0건, 그 스텝 `blank_var` > 0, `loop_split`(phase `loop_final`/`loop_retry`/`loop_cut`) 표본에 `/detail` 스텝 id가 없고, 양성 대조로 `/poll` 스텝의 그 phase 건수 > 0.
  - `parallel_branch_blank_blocks_namespaced_url`: 손 YAML — parallel 분기 `b` 안에 Y1의 loop, 뒤 스텝 `DELETE /orders/{{b.orderId}}` → 접수 0건.
  - `r0_no_cond_loop_unchanged`: 조건 반복 없는 2스텝 시나리오에서 `error_kind_stats`에 `blank_var` 없음, 모든 창이 `count == Σstatus_counts`.
  - `error_kind_flush.rs`: 기존 등식 테스트를 "분류 합에서 `blank_var`를 뺀 값 == status `0` 합"으로 고친다(이 파일의 기존 시나리오에는 차단이 없어 값은 같다 — 단언식만 바뀐다).
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine --test blank_guard` → `/orders/` 접수 > 0으로 실패(지금 동작).
- [ ] **Step 3: 구현** — 위 동작대로. `ctx`가 `iter_vars`를 빌린 채로는 수정할 수 없으니 차단 판정 결과를 값으로 꺼낸 뒤 블록을 닫는다(`Step::If` 가지의 스코핑 이디엄).
- [ ] **Step 4: GREEN + 엔진 전수** — `cargo nextest run -p handicap-engine`(기존 `loop_while`·`loop_split`·`parallel_node`·`genvars_per_request` 무변경 통과 = R0).
- [ ] **Step 5: 이빨 실증** — ① Http 가지의 `check` 결과를 임시로 `None` 고정 → `blocked_url_is_not_sent_*` 3건 RED. ② `run_vu_curve`의 `BlankTable::new()`를 반복 루프 **밖**으로 옮김 → `table_resets_each_iteration_curve`만 RED(closed·open은 green). ③ `note_step` 안에서 표에서 **지우는 줄만** 뺌(적는 줄은 그대로 — 호출을 통째로 빼면 표가 안 채워져 이 테스트는 green이고 ①과 같은 테스트만 깨진다) → `real_empty_after_blank_clears_table` RED(1회차 DELETE가 막혀 `blank_var` ≥ 1). 셋 다 되돌리고 GREEN 재확인.
- [ ] **Step 6: 커밋** — `feat(engine): 비워진 값이 든 주소는 보내지 않는다 — 부하 경로`

---

### Task 4: trace 배선과 `StepTrace.blocked`

**Files:**
- Modify: `crates/engine/src/trace.rs`(`StepTrace`, `trace_steps` 시그니처·Http 가지·Parallel 병합, trace 패스의 `iter_vars` 생성 자리), `crates/engine/src/lib.rs`(재수출), `StepTrace { … }` 리터럴이 있는 모든 파일에 `blocked: None` 추가(`grep -rn "StepTrace {" crates/` 기준 7개 파일: `crates/engine/src/trace.rs`, `crates/controller/src/monitor/{check,record,step_judge}.rs`, `crates/tui/src/inspect.rs`, `crates/tui/tests/{inspect_test,pick_test}.rs` — 타입 정의·`impl` 줄도 이 grep에 걸리니 리터럴만 고친다)
- Test: Create `crates/engine/tests/blank_guard_trace.rs`

**Interfaces — Produces:**

```rust
// trace.rs
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockedInfo { pub vars: Vec<String>, pub by_step: String }

pub struct StepTrace { /* 기존 필드 … */
    /// http 행 전용: 비워진 값이 주소에 쓰여 보내지 않았다(없으면 직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<BlockedInfo>,
}
```

**차단된 trace 행(값 고정 — 메서드 대문자 글자는 `executor.rs::execute_step_traced_with` 안의 매핑과 같아야 한다. 그 매핑을 작은 함수로 빼 두 곳이 같이 쓴다):** `kind: Http`, `loop_index` 그대로, `branch: None`, `request: Some(TracedRequest { method: <그 스텝 메서드 대문자>, url: Blocked.url, headers: 빈 맵, body: None })`, `response: None`, `extracted`: 조건 반복 안이면 선언 이름 전부 `""`·밖이면 빈 맵, `unbound_vars: vec![]`, `error: Some(BLOCKED_ERROR.into())`, `branch_eval: vec![]`, `timed_out: false`, `blocked: Some(BlockedInfo { vars, by_step })`. `state.requests += 1`. think time은 기존 조건(`opts.apply_think_time || force_think`) 그대로 탄다. 비움 표 갱신·parallel 병합 규칙은 Task 3과 같다(같은 `blank_guard` 함수 호출).

- [ ] **Step 1: 실패하는 테스트** — `tests/blank_guard_trace.rs`(기존 `tests/trace_scenario.rs`의 서버·`trace_scenario` 호출 이디엄), Task 3의 Y1 재사용:
  - `trace_blocks_and_marks_row`: DELETE 행이 위 "값 고정"과 필드별로 같다(`blocked == Some(BlockedInfo{vars:["orderId"], by_step: <poll 스텝 id>})`, `request.url`이 `/orders/`로 끝남, `unbound_vars.is_empty()`), 서버 `/orders/` 접수 0건, `/after` 행은 정상(`error == None`), `trace.ok == false`.
  - `trace_and_runner_block_same_steps`: Y1과 Task 3의 parallel YAML(분기 `b` 안 loop + `DELETE /orders/{{b.orderId}}`) **두 시나리오 각각**을 `trace_scenario`와 `run_scenario`(1 VU, DELETE까지 닿을 만큼 — 1초)로 돌려, trace에서 `blocked.is_some()`인 스텝 id 집합 == runner에서 `blank_var` 건수 > 0인 스텝 id 집합이고 **그 집합이 비어 있지 않다**(둘 다 안 막는 경우를 배제 — parallel YAML은 trace 쪽 병합 `merge_branch` 누락을 잡는다).
  - `blocked_step_blanks_own_extracts_in_loop`: 본문 `GET /poll`(extract orderId) → `GET /detail/{{orderId}}`(extract token) → `GET /use/{{token}}`. `/detail` 행은 `blocked.by_step == poll`, `/use` 행은 `blocked.by_step == detail`이고 `/detail` 행 `extracted == {token: ""}`.
  - `trace_json_unchanged_without_block`: 조건 반복 없는 시나리오의 trace를 `serde_json::to_value`한 결과 어느 행에도 `"blocked"` 키가 없다(`as_object().contains_key`).
  - `blocked_rows_hit_request_cap`: `loop(while…) {GET /poll}` 뒤 `loop repeat: 10000 { GET /x/{{orderId}} }`, `max_requests = 50`, 시간 상한 2초 → `trace.truncated == true`, http 행 수 ≤ 50, `/x/` 접수 0건. (이빨 실증 때 카운트를 빼도 메모리를 크게 먹지 않게 repeat·시간 상한을 작게 둔다.)
  - `blocked_field_roundtrip`: `BlockedInfo` 든 `StepTrace`를 직렬화→역직렬화하면 같고, `blocked` 키 없는 JSON도 역직렬화된다.
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-engine --test blank_guard_trace`(컴파일 실패 → 필드 추가 후 단언 실패 순).
- [ ] **Step 3: 구현** — 필드 추가 → `cargo build --workspace --tests`가 알려 주는 리터럴 전부 `blocked: None` → trace 배선.
- [ ] **Step 4: GREEN + 워크스페이스** — `cargo nextest run --workspace`(TUI·컨트롤러 테스트가 리터럴 수정으로 통과).
- [ ] **Step 5: 이빨 실증** — trace Http 가지에서 `state.requests += 1`을 빼면 `blocked_rows_hit_request_cap`이 RED(시간 상한까지 돌거나 행 수 초과)인지 확인 후 되돌린다.
- [ ] **Step 6: 커밋** — `feat(engine): 시험 실행 trace도 비워진 값 주소를 보내지 않는다`

---

### Task 5: 운영 모니터 판정

**Files:**
- Modify: `crates/controller/src/monitor/check.rs`(`judge`의 첫-에러-행 가지), `crates/controller/src/monitor/step_judge.rs`(`own_result`, 대리 원인 칸 가지)
- Test: 두 파일의 인라인 테스트

**Interfaces — Consumes:** `StepTrace.blocked`(Task 4). 기존 `REASON_UPSTREAM`·`REASON_NO_VALUE`·`step_name`·`result(at_ms, verdict, reason, detail)`.

**판정 표(spec R4 그대로, `<원인>` = `blocked.by_step`의 스텝 이름·못 찾으면 id, `<막힌>` = 그 행 스텝 이름):**

| 자리 | verdict | reason | detail |
|---|---|---|---|
| `step_judge::own_result` — 마지막 행에 `blocked`(`error_verdict` 앞) | `Fail` | `REASON_UPSTREAM` | `"{원인} · {REASON_NO_VALUE}"` |
| `step_judge` 대리 원인 칸 — 원인 행에 `blocked`(`error_verdict` 호출 앞) | `Fail` | `REASON_UPSTREAM` | `"{막힌} · {원인} · {REASON_NO_VALUE}"` |
| `step_judge` 그 밖의 뒤 칸 | 변경 없음 | | |
| `check::judge` — 첫 에러 http 행에 `blocked`(`unbound_vars` 검사 앞) | `Fail` | `REASON_UPSTREAM`(스텝 이름 접미 **붙이지 않음**) | `"{막힌} · {원인} · {REASON_NO_VALUE}"` |

detail은 `SHOWN_MAX_CHARS`를 넘지 않게 이 파일의 기존 자르기 헬퍼를 쓴다. `check.rs`에는 detail을 받는 생성자 `CheckResult::cond_result(at_ms, verdict, reason, detail)`가 이미 있고 `shown()` 자르기를 거친다 — 새 생성자를 만들지 말고 이것을 쓴다.

- [ ] **Step 1: 실패하는 테스트** — 기존 판정 표 테스트의 픽스처 헬퍼로 trace를 손으로 짓는다(스텝 `poll`(이름 "상태 조회")·`del`(이름 "주문 삭제")·`after`):
  - `step_cell_blocked_own`: 칸 = `del`, `del` 행 `blocked{vars:["orderId"], by_step:"poll"}` → `Fail`, reason `앞 단계 실패`, detail `상태 조회 · 값 없음`.
  - `step_cell_cause_stays_ok`: 칸 = `poll`(행 200·에러 없음) → `Ok`.
  - `step_cell_stand_in`: 칸 = `after`만(`del` 칸 없음) → `Fail`, detail `주문 삭제 · 상태 조회 · 값 없음`.
  - `step_cell_later_is_upstream`: 칸 = `del`, `after` → `after`는 `UpstreamFailed`, detail `주문 삭제에서 멈춤`.
  - `flow_cell_blocked`: 흐름 칸 → `Fail`, reason이 **정확히** `앞 단계 실패`(` · ` 없음), detail `주문 삭제 · 상태 조회 · 값 없음`.
  - `blocked_wins_over_unbound`: `blocked` 행에 `unbound_vars: ["x"]`를 억지로 넣어도 `ConfigError`가 아니라 `Fail`.
  - `cause_step_unknown_uses_id`: `by_step`이 시나리오에 없는 id → detail에 그 id.
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller monitor::` 중 새 7건 실패(지금은 `요청 실패`).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN + 컨트롤러 전수** — `cargo nextest run -p handicap-controller`.
- [ ] **Step 5: 커밋** — `feat(controller): 모니터가 보내지 않은 스텝을 앞 단계 실패로 판정`

---

### Task 6: 리포트 `not_sent`·연결 재사용률·지배 분류 (+ UI 스키마 한 줄)

**Files:**
- Modify: `crates/controller/src/report.rs`(`ReportStep`, `build_report`의 분류 롤업 반복문, 연결 통계), `crates/controller/src/insights.rs`(`dominant_error_kind`), `ReportStep { … }` 리터럴(`report.rs`·`export.rs`·`insights.rs` — `grep -rn "ReportStep {" crates/controller/src`), `ui/src/api/schemas.ts`(`ReportStepSchema`)
- Test: `report.rs`·`insights.rs` 인라인, `ui/src/api/__tests__/`의 리포트 스키마 테스트(`ui/src/api/__tests__/reportStepNotSent.test.ts` 생성)

**Interfaces — Produces:**

```rust
pub struct ReportStep { /* … */
    /// 보내지 않은 요청 수(분류 blank_var의 스텝별 건수). 0건이면 None(직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_sent: Option<u64>,
}
```
```ts
// ReportStepSchema(.strict())에 추가
not_sent: z.number().int().optional(),
```

- `build_report`: `error_kinds` 행(스텝별) 반복문에서 `kind == "blank_var"`를 스텝별로 모아 `ReportStep.not_sent`에 싣는다(run 전체 롤업 `error_kinds`에는 `blank_var`가 다른 종류처럼 그대로 들어간다).
- 연결 통계: `requests_total`과 `reuse_ratio`의 분모를 `total_count − Σnot_sent`(saturating)로. 요약 `count`·RPS는 `total_count` 그대로.
- `dominant_error_kind`: 합(`total`)과 후보(`best`) 양쪽에서 `blank_var`를 뺀다.
- spec R6 표의 나머지 규칙은 코드 변경 없음. **소비처 전수 확인**: `grep -rn 'error_kinds\|"0"' crates/controller/src --include='*.rs'`(zsh에서 `*.rs`는 따옴표 필수) 결과에서 R6 표에 없는 프로덕션 소비처가 나오면 STOP하고 보고한다(구현 중 실측 확정).

- [ ] **Step 1: 실패하는 테스트** —
  - Rust `report_not_sent_per_step`: 창 픽스처(스텝 `a` count 10·error 4·status `{200:6}`) + 분류 행 `(a, "blank_var", 4)`, `(b, "timeout", 2)` → 스텝 `a`의 `not_sent == Some(4)`, 스텝 `b`는 `None`이고 직렬화 JSON에 `not_sent` 키 없음(`contains_key`), `error_kinds`에 `blank_var` 4 포함.
  - Rust `reuse_ratio_excludes_not_sent`: 요청 합 10(그중 not_sent 4)·새 연결 3 → `requests_total == 6`, `reuse_ratio == 0.5`.
  - Rust `dominant_kind_ignores_blank_var`: `[blank_var 90, timeout 10]` → `Some("timeout")`; `[blank_var 5]` → `None`.
  - TS `reportStep_parses_with_and_without_not_sent`: 기존 리포트 픽스처의 스텝에 `not_sent: 3`을 넣어 `ReportSchema.parse` 성공, 없는 픽스처도 성공, `not_sent: "x"`는 실패.
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-controller report_not_sent reuse_ratio_excludes dominant_kind_ignores` / `cd ui && pnpm test reportStepNotSent`.
- [ ] **Step 3: 구현** — 리터럴은 `cargo build --workspace --tests`가 알려 준다.
- [ ] **Step 4: GREEN + 전수** — `cargo nextest run -p handicap-controller`(골든 `golden_summary_deltas_match` 포함), `cd ui && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 커밋** — `feat(controller,ui): 리포트 스텝에 보내지 않은 건수 — 재사용률·지배 분류에서 제외`

---

### Task 7: 화면 문구 — 시험 실행·모니터 기록·분류 라벨·도움말

**Files:**
- Create: `ui/src/scenario/blockedText.ts`
- Modify: `ui/src/api/schemas.ts`(`StepTraceSchema`에 `blocked: z.object({ vars: z.array(z.string()), by_step: z.string() }).optional()`), `ui/src/i18n/ko.ts`(문구 3개), `ui/src/components/scenario/TestRunPanel.tsx`, `ui/src/components/monitor/CheckRecordDialog.tsx`, `ui/src/components/monitor/PreviewResult.tsx`
- Test: `ui/src/scenario/__tests__/blockedText.test.ts`, 세 컴포넌트의 기존 테스트 파일에 케이스 추가

**Interfaces — Produces:**

```ts
// blockedText.ts — step.error를 보여 줄 문자열. blocked가 있으면 한국어 문구, 없으면 error 그대로.
export function traceErrorText(
  step: Pick<StepTrace, "error" | "blocked">,
  stepName: (id: string) => string | undefined,
): string | null;
```

- `ko.ts`: `ko.common.blockedByBlank(step: string, vars: string)`(에디터·모니터가 같이 쓰므로 `common`에 — Global Constraints의 trace 행 문구), `ko.report.errorKinds.labels.blank_var`(분류 라벨), `ko.editor.loopLenientExtractHelp` 교체. 새 값(전문 — 앞 두 문장은 지금 그대로, 셋째 문장만 바뀐다):
  `이 반복 안에서는 응답에 없는 값을 빈 값으로 두고 에러로 세지 않습니다. 요청이 실패한 스텝이 뽑는 값도 빈 값이 됩니다. 빈 값이 된 값을 뒤 스텝의 요청 주소에 쓰면(예: /orders/{{orderId}}) 그 요청은 보내지 않고 에러로 셉니다. 헤더·본문에는 빈 값이 그대로 들어가므로, 뒤에서 그 값을 쓰기 전에 조건 분기로 확인하세요.`
- 세 화면은 `step.error`를 직접 찍던 자리를 `traceErrorText(step, 이름 조회)`로 바꾼다. 스텝 이름 조회는 각 화면이 이미 가진 시나리오/스텝 이름 맵을 쓰고, 없으면 `undefined`를 돌려 id가 보이게 한다.

- [ ] **Step 1: 실패하는 테스트** —
  - `blockedText.test.ts`: `{error:"not sent: blank value in url", blocked:{vars:["orderId"], by_step:"S1"}}` + 이름 `S1→"상태 조회"` → `"앞 스텝 상태 조회이(가) orderId 값을 주지 않아 요청을 보내지 않음"`(리터럴 문자열로 단언 — `ko` 함수 재호출 금지). vars 2개 → `"orderId, code"` 포함. 이름 없음 → id `S1` 포함. `blocked` 없음 → `error` 그대로. `error: null` → `null`.
  - 세 화면 각각: `blocked` 든 스텝을 렌더하면 위 한국어 문구가 보이고 원문 `not sent: blank value in url`은 **안 보인다**; `blocked` 없는 에러 스텝은 원문 그대로(기존 테스트 유지). TestRunPanel은 미바인딩 칩(화면 글자 `unbound:`)이 그 행에 안 뜨는 것도 단언.
  - 스키마: `blocked` 있는/없는 trace 응답 둘 다 `ScenarioTraceSchema.parse` 성공.
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test blockedText TestRunPanel CheckRecordDialog PreviewResult`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN + UI 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 보내지 않은 요청을 앞 스텝 값 없음으로 보여 준다`

---

### Task 8: 인쇄 보고서 스텝 표

**Files:**
- Modify: `ui/src/print/stepTable.ts`(`Column.kind`에 `"notSent"`, `buildColumns`, 행의 잔여 식, `StepRow`에 `notSent: number`), `ui/src/print/components/StepCodeTable.tsx`(새 열 종류가 일반 칸 그리기 경로를 타는지 확인 — 열 `kind` 분기가 있으면 `notSent`를 `code` 열과 같은 가지로), `ui/src/print/sentences.ts`(`identityLine`), `ui/src/print/stepStatus.ts`(용어 설명 한 줄, 분류 내역 줄 조건, 범례), `ui/src/i18n/ko.ts`(인쇄 문구 3개 — Global Constraints)
- Test: `ui/src/print/__tests__/`의 `stepTable`·`sentences`·`stepStatus`·`PrintDocument` 테스트에 케이스 추가

**결정(spec R5 인쇄 절):**
- `buildColumns(codeTotals, hasResidual, hasNotSent)` — 세 번째 인자 추가. `fixedCount`에 `hasNotSent ? 1 : 0`을 더하고 `B = Math.max(MAX_COLS - fixedCount, hasNotSent ? 2 : 3)`. 열 순서: … `none` → **`notSent`** → `residual`. `hasNotSent`는 어느 스텝이든 `not_sent > 0`일 때 참.
- 잔여 = `Math.max(0, errorCount - countedSum - notSent)`.
- `notSent` 칸은 `residual`처럼 따로 그리지 **않는다**. 셀을 채우는 반복문(`stepTable.ts`의 `for (const col of columns)`)에서 `col.kind === "notSent"`이면 `Cell { count: row.notSent, cls: "counted", strongest: false }`를 `row.cells[col.key]`에 넣고 가장 큰 칸 후보(`best`) 비교에도 넣는다. 가장 큰 칸 표시와 범례(`legendItems`)는 둘 다 `row.cells`를 읽으므로 따로 손대지 않아도 따라온다.
- `identityLine`: 에러가 가장 많은 스텝에서 `notSent`가 0보다 크고 에러로 세는 status 칸 중 최대값 이상이면 꼬리 문장으로 새 `ko` 문구를 쓴다(기존 `identityResidual` 자리).
- 용어 설명: `notSent` 열이 있으면 한 줄 추가. 분류 내역 줄 조건을 `(hasNone || hasNotSent) && kl.length > 0`으로.
- 4xx·5xx·other 세 계열이 모두 있고 고정 열 5개가 다 있는 조합은 8열이 될 수 있다 — 받아들이고 테스트 한 건으로 열 수 8을 고정한다(spec 리뷰가 plan 세부로 넘긴 항목).

- [ ] **Step 1: 실패하는 테스트** —
  - `stepTable`: 스텝 `{count:10, error_count:4, status_counts:{200:6}, not_sent:4}` → 열 키 순서에 `notSent`가 있고 `residual` 열 **없음**(잔여 0), 그 행 `notSent == 4`, `cells.notSent == {count:4, cls:"counted", strongest:true}`. `not_sent` 없는 기존 픽스처 전부 → 열·행이 지금과 같음(기존 스냅샷/단언 무변경 통과). 고정 5열(2xx·3xx·status `0`·`not_sent`·잔여 > 0 — 잔여가 새 식으로도 0보다 크게 픽스처를 잡는다) + 4xx 3종 → 열 수 7(개별 1 + 묶음 1). 고정 5열 + 4xx·5xx·other 한 종씩 → 열 수 8.
  - `sentences`: 위 스텝이 에러 최다일 때 문장에 `앞 스텝이 값을 주지 않아 요청을 보내지 않았습니다.` 포함, `응답은 받았지만` **미포함**.
  - `stepStatus`: `notSent` 열이 있으면 용어 설명에 `앞 스텝이 값을 주지 않아 요청을 보내지 않음` 항목, status `0`이 없어도 분류 내역 줄이 `보내지 않음 (앞 스텝 값 없음) 4`를 담는다.
  - `PrintDocument`: 차단 있는 리포트를 렌더하면 열 머리 `보내지 않음`과 칸 값 `4`가 보인다.
- [ ] **Step 2: RED 확인** — `cd ui && pnpm test stepTable sentences stepStatus PrintDocument`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN + UI 게이트** — `cd ui && pnpm lint && pnpm test && pnpm build`.
- [ ] **Step 5: 커밋** — `feat(ui): 인쇄 보고서에 보내지 않음 칸 — 응답 받은 뒤 실패와 구분`

---

### Task 9: 터미널 모니터 문구

**Files:**
- Modify: `crates/tui/src/inspect.rs` — ① 스텝 목록 줄: `StepLine::Http { error: s.error.clone() }`를 채우는 자리(`inspect.rs:419` 부근, 이 자리는 `step_name` 조회를 이미 쓴다) ② 본문 보기: `body_lines`가 `step.error`를 찍는 자리(`inspect.rs:804` 부근). `inspect.rs:469`의 trace 최상위 오류는 **대상이 아니다**. `BodyInput<'a>`에 필드 `pub blocked_text: Option<&'a str>`을 더한다(본문 보기에는 이름 조회 수단이 없으므로 호출하는 쪽이 완성 문구를 넘긴다). **`Option<String>`은 안 된다** — `BodyState::ensure`가 `BodyInput { reveal: self.reveal, ..*i }`로 빌린 값에서 나머지 필드를 복사하므로(`inspect.rs:873` 부근) 복사 불가 필드가 생기면 E0507이고, `app.rs::body_input`은 `BodyInput<'a>`를 빌린 채로 돌려줘 그 안에서 만든 `String`을 담을 수도 없다. 값은 ①이 이미 한국어로 바꿔 둔 목록 줄 `StepLine::Http`의 `error`에서 빌린다 — `app.rs::body_input`이 받는 `line` 패턴에 `error`를 더해 `step.blocked.is_some()`일 때만 그 `error`(`Option<String>`)를 `as_deref()`로 빌린다. `ensure`의 `..*i`는 새 필드를 그대로 복사하므로 그 자리는 확인만 한다. `BodyInput { … }`를 만드는 자리(`grep -rn "BodyInput {" crates/tui/` — `inspect.rs`의 `ensure`, `app.rs`, `tests/inspect_test.rs` 10곳)를 모두 고친다.
- Modify: `crates/tui/src/text.rs`(문구 함수)
- Test: `crates/tui/src/text.rs` 인라인, `crates/tui/tests/inspect_test.rs`

**Interfaces — Produces:** `text::blocked_by_blank(step: &str, vars: &[String]) -> String` = `앞 스텝 {step}이(가) {vars를 ", "로 연결} 값을 주지 않아 요청을 보내지 않음`. 두 자리 모두 `blocked`가 있으면 이 문구를(스텝 이름은 `names.rs`의 `step_name` 조회, 없으면 `by_step` id), 없으면 `error` 그대로.

- [ ] **Step 1: 실패하는 테스트** — `text::blocked_by_blank_joins_vars`(리터럴 문자열 단언), `inspect_test.rs`에 `blocked_step_line_uses_korean`(목록 줄의 `error`가 위 문구), `blocked_body_view_uses_korean`(본문 보기 줄에 문구가 있고 `not sent: blank value in url`은 없음), `plain_error_unchanged`(blocked 없는 에러 행은 두 자리 모두 원문).
- [ ] **Step 2: RED 확인** — `cargo nextest run -p handicap-tui blocked_`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: GREEN** — `cargo nextest run -p handicap-tui`.
- [ ] **Step 5: 커밋** — `feat(tui): 기록 화면에 보내지 않은 요청 문구`

---

### Task 10: 문서

**Files:**
- Modify: `docs/adr/0056-conditional-loop.md`("Negative / Trade-offs"의 주소 문장과 사용 안내 "빈 값과 요청 주소" 단락을 새 동작으로), `docs/adr/0050-transport-error-taxonomy.md`(9번째 종류 `blank_var` — 전송 실패 아님, status `0`에 들어가지 않음, 등식은 `blank_var` 제외), `crates/engine/CLAUDE.md`(① 비움 표 lockstep 한 줄 ② error_kind 등식 서술 정정 ③ "`ScenarioTrace`에 필드를 더하지 말 것(TUI 거울 `deny_unknown_fields`)" 서술을 "막는 것은 TUI `CheckRecord` 층뿐이고 trace 안쪽 구조체는 선택 필드를 더할 수 있다"로 정정), `crates/controller/CLAUDE.md`(모니터 `blocked` 가지가 `unbound_vars`·`timed_out`·`classify`보다 먼저라는 한 줄), `ui/CLAUDE.md` 인쇄 절(차단 칸이 있으면 개별 코드 열 하한 2 한 줄)

- [ ] **Step 1: 편집** — 위 다섯 파일. ADR 인덱스(루트 CLAUDE.md)는 새 ADR이 없으므로 그대로.
- [ ] **Step 2: 확인** — `just doc-budget`가 FAIL이 아닌지.
- [ ] **Step 3: 커밋** — `docs: 비워진 값 주소 차단 — ADR-0056·0050, 도메인 함정 노트`

---

## 구현 뒤 (파이프라인 4–6단계 — task 아님)

- **최종 리뷰**: `handicap-reviewer`(와이어 1:1 — `StepTrace.blocked`↔Zod, `ReportStep.not_sent`↔Zod `.strict()`, runner↔trace lockstep) + **`security-reviewer` 필수**(요청 실행 경로). 초점은 spec §6 보안 게이트 줄.
- **라이브 검증**(`/live-verify`, US 척추): 접수 기록을 남기는 응답기(`/poll`이 `{}` 200)로
  | US | 절차 | 통과 신호 |
  |---|---|---|
  | US1 | Y1 시나리오로 스텝 칸 보드·흐름 칸 보드 각각 시작 | 응답기 `/orders/` 접수 0건 · 막힌 칸 빨강 「앞 단계 실패」 + 상세에 원인 스텝 이름 · 가장 긴 스텝 이름에서도 사유·상세 `scrollWidth<=clientWidth` · TUI 같은 보드 판정과 기록 화면 문구 |
  | US2 | 에디터 시험 실행 | 그 행에 한국어 문구·「미바인딩」 칩 없음 · `/orders/` 접수 0건 |
  | US3 | 부하 run(closed) 1회 → 리포트·인쇄 미리보기 | `/orders/` 접수 0건 · 리포트 JSON 그 스텝 `count == error_count == not_sent`, `status_counts` 비어 있음 · 실패 분류 표에 라벨·건수 · 인쇄 표 「보내지 않음」 칸, PDF 쪽 수 == `.p-page` 수 · 차단 없는 run의 인쇄물은 열 구성이 그대로 |
- **마무리**(`/finish-slice`): spec §7 판단 6건과 §8 연기를 roadmap 새 §B 블록에(번호는 `grep -n '^### B' docs/roadmap.md`의 마지막 + 1), §B58 (0) 첫 항목에 완료 표시, 릴리즈 노트 줄 교체.
