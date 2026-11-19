# 감싼 JSON 풀기 비용 줄이기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔진 본문 추출이 "원래 본문에서 못 찾음 + 풀리는 문자열 있음"일 때 하던 본문 통째 복사를 없애되, 추출 결과는 한 글자도 바꾸지 않는다.

**Architecture:** `json_unwrap`에 제자리 풀기 `unwrap_in_place`를 더한다. `extract.rs`의 본문 캐시는 한 항목이 3단계(안쪽까지 푼 값)로 넘어가는 순간 — 풀리는 문자열이 있을 때만 — 같은 평가의 뒤 본문 항목들의 1·2단계 결과를 먼저 구해 보관하고, 평가가 소유한 `Value`를 그 자리에서 푼다. 옛 구현을 `#[cfg(test)]` 기준으로 남겨 세 평가 함수의 결과 전체를 비교한다.

**Tech Stack:** Rust(`serde_json`·`serde_json_path`·`proptest`).

**Spec:** `docs/superpowers/specs/2026-11-20-nested-json-cost-design.md` — 매 task brief에 spec의 `사용자 스토리 (US)` 블록을 첨부한다.

REVIEW-GATE: APPROVED

## Global Constraints

- 추출 결과(값 맵·에러 글자·`evaluate_with_defaults`의 `extracted`/`error`)는 옛 구현과 같다. 에러 문구 `no match: {path}`·`body not JSON: {e}` 그대로, 새 문구 없음.
- 경로를 원래 본문에서 찾는 요청과, 풀 문자열이 없는 응답에서 하는 일은 지금과 같다(새 쿼리·복사·순회 없음).
- `unsafe` 금지.
- `crates/engine/src/json_unwrap.rs`의 기존 함수 `unwrap_json_str`·`parse_body_json`·`has_unwrappable`·`unwrap_nested`의 **본문을 고치지 않는다**(동등성 테스트의 기준이다. `unwrap_nested`를 새 함수로 다시 짜지 않는다).
- 공개 함수 `evaluate`·`evaluate_lenient`·`evaluate_with_defaults`·`jsonpath_first`의 시그니처·반환 그대로. `crates/controller`·`crates/tui`·`ui/`·proto·migration 0-diff.
- 기존 `crates/engine/src/extract.rs` 단위 테스트와 `crates/engine/tests/*.rs`는 무수정 통과(이 plan이 고치는 `tests/json_unwrap_api.rs`·`tests/nested_json_perf.rs`는 제외). 그 밖의 예외는 캐시 내부 필드를 보는 두 테스트(`found_path_does_no_unwrap_work`·`found_path_on_string_root_does_no_unwrap_work`)뿐 — Task 2가 같은 뜻으로 고쳐 쓴다. 그 밖의 테스트를 고쳐야 통과하면 STOP·보고.
- 결함을 변호하는 주석 금지 — 코드로 고친다(`docs/dev/working-rules.md` §7). 회귀 가드 테스트는 되돌려 확인(고의 회귀 → RED → 원복 → GREEN)을 실행하고 보고에 적는다.
- 커밋: 구현자는 커밋·게이트를 단일 foreground 호출(timeout 600000ms)로, `| tail`·`| head` 금지, 판정은 `; echo exit=$?`, `--no-verify` 금지, 커밋 메시지는 `-F <파일>`(파일은 `.superpowers/sdd/` 아래에), 커밋 뒤 `git log -1`로 확인. 워크트리 루트에 `.md` 쓰기 금지(보고는 `.superpowers/sdd/`).
- 리뷰 모델: 세 task 모두 엔진 경로라 code-quality 리뷰는 `model: opus`.

## Review Focus

1. 3단계를 일으킨 항목 **뒤에 놓인** 항목이 원래 본문에서 `null`을 찾는 경우 — 엄격 `""`, 너그러운 쪽 못 뽑음이어야 한다(풀린 값의 `7`이 아니다). → Task 2 Step 1 `later_null_in_original_stays_found`.
2. 3단계를 일으킨 항목 뒤에 감싼 문자열 칸 자체를 뽑는 항목(`$.data`) — 원래 문자열 통째여야 한다(풀린 객체 글자 아님). → Task 2 Step 1 `later_string_field_keeps_original`.
3. 풀 것이 없는 본문에서 앞 항목이 못 찾은 뒤의 항목 — 지금처럼 원래 본문에서 찾는다. → Task 2 Step 1 `miss_then_found_on_plain_body`.
4. 본문 뿌리가 감싼 JSON인 응답에서 3단계 뒤의 `$` 항목 — 원래 문자열 통째. → Task 2 Step 1 `later_root_dollar_keeps_original`.
5. 본문 항목 사이에 실패하는 헤더 항목이 낀 엄격 평가 — 에러 글자가 옛 구현과 같다. → Task 2 Step 1 동등성 손 사례.
6. 아주 깊은 풀기 사슬 본문 — release에서 스택이 넘치지 않는다. → Task 3 Step 4.

## 파일 지도

| 파일 | 역할 |
|---|---|
| Modify `crates/engine/src/json_unwrap.rs` | `unwrap_in_place` + 단위·proptest |
| Modify `crates/engine/tests/json_unwrap_api.rs` | 공개 API에 새 함수 |
| Modify `crates/engine/src/extract.rs` | 본문 캐시·`body_path_first` 새 흐름, `#[cfg(test)]` 옛 구현 기준, 동등성 테스트 |
| Modify `crates/engine/tests/nested_json_perf.rs` | C 단언 + 새 기록 행 |
| Modify `crates/engine/CLAUDE.md` | 함정 한 줄 |

---

### Task 1: `unwrap_in_place`

**Files:**
- Modify: `crates/engine/src/json_unwrap.rs`, `crates/engine/tests/json_unwrap_api.rs`

**Interfaces:**
- Produces: `pub fn unwrap_in_place(root: &mut serde_json::Value) -> bool` (`handicap_engine::json_unwrap::`) — 풀리는 문자열을 그 자리에서 푼 값으로 바꾼다(푼 값 안쪽도 이어서). 하나라도 바꿨으면 `true`. 재귀 없음(직접 쌓는 스택 — `unwrap_nested`의 교체 순회와 같은 순서).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `json_unwrap.rs`의 `mod tests`에:

```rust
/// 기준 둘(`unwrap_nested`, `old_unwrap_nested`)과 같은 결과.
fn assert_in_place_matches(v: &Value) {
    let mut got = v.clone();
    let changed = unwrap_in_place(&mut got);
    for want in [unwrap_nested(v), old_unwrap_nested(v)] {
        match want {
            Some(w) => {
                assert!(changed, "{v}");
                assert_eq!(got, w, "{v}");
            }
            None => {
                assert!(!changed, "{v}");
                assert_eq!(&got, v, "{v}");
            }
        }
    }
}

#[test]
fn unwrap_in_place_matches_reference() { /* unwrap_nested_matches_old_impl의 cases 5개 + fixture(cases·known_divergence) 본문 전부에 assert_in_place_matches. 읽은 본문 수 >= 14 단언 */ }

#[test]
fn unwrap_in_place_deep_value() { /* 128 MiB 스택 스레드에서 deep_value()에 unwrap_in_place == true (해제가 재귀라 큰 스택) */ }

proptest::proptest! {
    #[test]
    fn unwrap_in_place_matches_reference_prop(v in arb_value()) { assert_in_place_matches(&v); }
}
```

`arb_value()`: 깊이 ≤4의 `Value` 생성기. 문자열 잎은 평범한 글자, 후보지만 안 풀리는 글자(`[INFO] x`·`{name}`·`"12"`), 그리고 **작은 `Value`를 1–4겹 감싼 글자**(`wrap` 헬퍼) 중에서 뽑는다. 객체 키는 `[a-z]{1,3}`만 쓴다. `tests/json_unwrap_api.rs`에는 **기존 함수 `json_unwrap_public_api` 안에** `unwrap_in_place(&mut json!({"a":"{\"k\":1}"}))`가 `true`이고 값이 `{"a":{"k":1}}`인 단언을 더한다.

- [ ] **Step 2: 실패 확인** — `cargo nextest run -p handicap-engine json_unwrap ; echo exit=$?` → 컴파일 에러(`unwrap_in_place` 없음).

- [ ] **Step 3: 구현** — `unwrap_nested` 아래에 새 함수. 기존 함수 본문은 건드리지 않는다.

- [ ] **Step 4: 통과 확인** — 같은 명령 → 전부 PASS, exit=0.

- [ ] **Step 5: 되돌려 확인** — `unwrap_in_place`에서 "교체한 값의 자식도 스택에 넣기"를 빼면(교체 뒤 `continue`) `unwrap_in_place_matches_reference`가 RED(푼 값 안의 감싼 필드 사례)인지 보고 원복.

- [ ] **Step 6: 커밋** — `feat(engine): 감싼 JSON 제자리 풀기 unwrap_in_place`.

---

### Task 2: 본문 캐시가 복사 없이 3단계로 넘어간다

**Files:**
- Modify: `crates/engine/src/extract.rs`

**Interfaces:**
- Consumes: `json_unwrap::{unwrap_json_str, has_unwrappable, unwrap_in_place}`.
- Produces(모듈 안, 비공개):
  - `BodyCache::new(extracts: &[Extract]) -> BodyCache<'_>` — 평가 한 번에 하나. 안쪽 상태는 `RefCell`.
  - `fn body_path_first(cache: &BodyCache<'_>, facts: &ResponseFacts<'_>, idx: usize, path: &str) -> std::result::Result<Option<serde_json::Value>, String>` — `idx`는 `extracts` 안 자기 자리.
  - `strict_item`·`lenient_item`이 `idx: usize`를 받는다. 세 평가 함수는 `extracts.iter().enumerate()`로 돈다.
  - `#[cfg(test)] mod reference` — 이 task 시작 시점의 `BodyCache`·`body_path_first`를 그대로 옮긴 사본과, 그것으로 세 평가 함수를 다시 짠 `evaluate`·`evaluate_lenient`·`evaluate_with_defaults`(본문 항목만 사본 `body_path_first`를 쓰고 그 뒤 처리 `stringify`·`post_process`·`post_process_lenient`·`null` 거르기와 본문 아닌 항목은 운영 코드를 그대로 부른다).

**캐시 상태(이 모양으로):**

```rust
enum Nested {
    /// 아직 3단계로 넘어간 항목이 없다.
    NotTried,
    /// 풀 것이 없다 — 원래 본문 그대로. 뒤 항목은 자기 차례에 1·2단계를 찾는다.
    Nothing,
    /// 바탕 값이 제자리에서 풀렸다. `early[i]` = 풀기 전에 구해 둔 항목 i의 1·2단계 결과
    /// (`Some(v)` = 찾음 — `v`가 `null`이어도 찾음, `None` = 못 찾음 또는 본문 항목 아님).
    Unwrapped { early: Vec<Option<serde_json::Value>> },
}
```

**흐름(`body_path_first`, spec §5.2):**
1. 본문 파싱(처음 한 번). 실패면 지금 글자 그대로 `Err`.
2. `Nested::Unwrapped`면: `early[idx]`가 `Some`이면 그 값(꺼내 쓴다), 아니면 푼 바탕 값에서 찾는다. 끝.
3. 경로 글자를 한 번 파싱(실패면 `Ok(None)`). 1단계(파싱된 본문) → 뿌리가 문자열이면 2단계(뿌리를 푼 값; 안 풀리면 `Ok(None)`). 찾으면 끝.
4. `Nested::Nothing`이면 `Ok(None)`.
5. `Nested::NotTried`: 바탕 값(뿌리가 문자열이면 2단계 값, 아니면 파싱된 본문)에 `has_unwrappable`. `false`면 `Nothing`으로 굳히고 `Ok(None)`.
6. `true`면: `idx`보다 뒤의 `Extract::Body` 항목마다 3번(1·2단계)의 결과를 구해 `early`에 넣는다 → 바탕 값에 `unwrap_in_place` → `Unwrapped`로 바꾸고 → 이번 항목을 푼 값에서 찾는다.

`RefCell` 빌림은 쿼리 결과를 복사한 뒤 풀고, 6의 바꾸기 구간에서만 `borrow_mut`한다(빌린 채 다시 빌리지 않는다).

- [ ] **Step 1: 테스트를 먼저 쓴다** — `extract.rs`의 `mod tests`에. (이 시점엔 `reference` 모듈만 새로 있고 운영 코드는 그대로다. 아래 "찾은 경로" 두 테스트는 새 캐시 API를 써서 컴파일 에러로 RED, 나머지는 옛 코드에서 GREEN인 회귀 가드다 — Step 5가 되돌려 확인한다.)

  - `mod reference`(위 Interfaces).
  - 비교 헬퍼 `assert_same(body: &[u8], headers: &[(String, String)], xs: &[Extract])`: 세 함수 각각 운영 결과 == 기준 결과. 엄격은 `Ok` 맵 또는 `Err`의 `to_string()`, 기본값 함수는 `extracted`와 `error.map(|e| e.to_string())`.
  - 손 사례(`#[test] fn equivalence_hand_cases`), 본문 `B1 = {"data":"{ \"id\": 7 }","name":"kim","n":null}` — **감싼 글자에 공백을 둔다**. 공백 없는 `{"id":7}`은 풀린 객체를 글자로 바꿔도 같은 글자라(키 정렬·공백 없음) 원래 문자열과 풀린 값을 못 가른다(기존 `order_original_string_field_wins`와 같은 수법):
    - `[$.data.id, $.data, $.name]` · `[$.name, $.data.id, $.name]` · `[$.data.id, $.data.id]` · `[$.nope, $.name]` · `[$.data.id, $.n]` · `[$.data.id, $[]`(잘못된 경로) · `[$.data.id, header "x-missing", $.name]` · `[$.data.id(default "d"), $.nope(default "d"), $.name]` · 풀 것 없는 본문 `{"a":1}`에 `[$.missing, $.a]` · JSON 아닌 본문 `oops`에 `[$.a, $.b]` · 뿌리 문자열 `"{\"id\":7,\"w\":\"{\\\"k\\\":1}\"}"`에 `[$.w.k, $, $.id]` · 안 풀리는 뿌리 `"hello"`에 `[$.a, $]` · 4겹 뿌리 · 3단계에서 찾는 `null`: `{"w":"{\"id\":null}"}`에 `[$.w.id]`.
    - 각 사례를 `assert_same`에 넣고, 아래 네 개는 값도 직접 단언한다:
  - `later_null_in_original_stays_found`: 본문 `{"w":"{\"id\":7}","x":{"id":null}}`, 항목 `[a: $.w.id, b: $..id]` → 엄격 `a="7"`, `b=""`; 너그러운 쪽 `a="7"`, `b` 없음.
  - `later_string_field_keeps_original`: `B1`, `[a: $.data.id, b: $.data]` → 엄격 `a = 7`, `b = { "id": 7 }`(공백까지 원래 문자열 글자 — 풀린 객체면 `{"id":7}`).
  - `miss_then_found_on_plain_body`: `{"a":1}`, 너그러운 `[m: $.missing, a: $.a]` → `a="1"`, `m` 없음.
  - `later_root_dollar_keeps_original`: 본문 `"{\"id\":7,\"w\":\"{\\\"k\\\":1}\"}"`, 엄격 `[k: $.w.k, r: $]` → `k="1"`, `r`은 원래 문자열 글자 `{"id":7,"w":"{\"k\":1}"}`.
  - fixture(`fn equivalence_on_vectors`): `cases`·`known_divergence` 본문마다 경로 묶음 `P` = 그 본문의 잎 경로 전부(`cases`는 `leaves[*][0]`, `known_divergence`는 `leaves`가 없고 `path` 하나) + 본문을 파싱했을 때 **값이 문자열인 최상위 필드 경로**(감싼 칸 자체 — 키가 `[A-Za-z_][A-Za-z0-9_]*`일 때만 `$.<키>`로, 그 밖의 키는 건너뛴다; 뿌리가 객체가 아니면 없음) + `$` + `$..*`. "원래 본문에서 못 찾는 경로"는 본문을 `serde_json`으로 파싱한 값에 `jsonpath_first`가 `None`인 경로다. 함수별 목록(spec §6):
    - 너그러운 쪽: `[$.__none__] + P`, 그리고 뒤집은 것.
    - 엄격: `P`를 "원래 본문에서 못 찾는 경로 먼저"로 정렬한 것(= 3단계에서만 찾히는 잎이 앞), 그리고 `P` 그대로. 없는 경로는 넣지 않는다.
    - 기본값 함수: `[$.__none__(default "d")] + P`, 그리고 엄격용 목록.
    - 비교한 호출 수 단언(`>= 60`)으로 빈 순회를 막는다.
    - **`$`를 빼지 말 것**: fixture의 감싼 글자는 대부분 공백 없이 키가 정렬돼 있어 감싼 칸 경로(`$.data`)는 풀기 전후 글자가 같다. 필드가 하나라도 풀리면 항상 달라지는 것은 `$`(본문 통째)이고, 되돌려 확인 1이 세 함수에서 RED가 되는 것은 `$` 덕분이다.
  - proptest(`equivalence_prop`): `(Value, Vec<경로>, 순서 섞기, default 유무)` — 값은 Task 1의 `arb_value()`와 같은 모양(이 모듈에 다시 둔다), 경로는 그 값을 완전히 푼 뒤의 실제 잎 경로 일부 + `$`(항상) + `$.__none__`(넣을지 말지도 뽑는다) + `$..*` + `$.*`. 감싼 글자의 절반쯤은 앞뒤·안쪽에 공백을 넣어 만든다(`{ "k": 1 }` 꼴 — 풀린 값과 글자가 달라지게). 키는 `[a-z]{1,3}`이라 경로는 `$.k`·`[n]`만으로 만든다. 본문 = 값의 JSON 글자. `assert_same`.
  - 고쳐 쓰는 두 테스트: `found_path_does_no_unwrap_work`·`found_path_on_string_root_does_no_unwrap_work` — `BodyCache::new(&xs)` + `body_path_first(&cache, &facts, 0, path)` 뒤 "풀기 상태가 `NotTried`이고 2단계 값이 안 만들어졌다"를 단언(같은 뜻).
  - 새 테스트 `plain_body_miss_settles_nothing`: `{"a":"[INFO] x","b":1}`에 `$.nope` → 상태가 `Nothing`.

- [ ] **Step 2: 상태 확인** — `cargo nextest run -p handicap-engine extract:: ; echo exit=$?` → 컴파일 에러(`BodyCache::new` 등 없음).

- [ ] **Step 3: 구현** — 위 흐름대로 `BodyCache`·`body_path_first`·`strict_item`·`lenient_item`·세 평가 함수의 순회를 고친다. `use crate::json_unwrap::{…}`에서 `unwrap_nested`를 빼고 `has_unwrappable`·`unwrap_in_place`를 넣는다(`reference` 모듈은 `unwrap_nested`를 자기 `use`로). `BodyCache` 머리 주석은 "3단계로 넘어가면 든 본문 값이 풀린 값으로 바뀐다 — 그 전에 뒤 본문 항목의 1·2단계를 구해 둔다"는 사실을 적는다.

- [ ] **Step 4: 통과 확인** — `cargo nextest run -p handicap-engine ; echo exit=$?` → 전부 PASS(엔진 전체 — `tests/extract_*.rs`·`executor_extract.rs`·`nested_json_depth.rs` debug 1건 포함).

- [ ] **Step 5: 되돌려 확인 두 가지** (각각 RED 확인 뒤 원복):
  1. 흐름 6에서 뒤 항목 미리 구하기를 건너뛴다(`early`를 전부 `None`으로) → `later_string_field_keeps_original`, 그리고 `equivalence_on_vectors`가 **엄격·너그러운·기본값 세 함수 모두에서** RED인지(실패 메시지에 어느 함수인지 찍히게 `assert_same`이 함수 이름을 싣는다).
  2. 흐름 2에서 `early[idx]`가 `Some(null)`이면 못 찾음으로 다룬다 → `later_null_in_original_stays_found` RED.

- [ ] **Step 6: 커밋** — `perf(engine): 본문 추출 3단계가 본문을 복사하지 않고 제자리에서 푼다`.

---

### Task 3: 측정 단언 + 깊이 확인 + 함정 기록

**Files:**
- Modify: `crates/engine/tests/nested_json_perf.rs`, `crates/engine/CLAUDE.md`

**Interfaces:**
- Consumes: 공개 `evaluate_extracts`·`evaluate_lenient`·`jsonpath_first`(이미 쓰는 것).

- [ ] **Step 1: 측정 테스트를 고친다** — 모두 `#[ignore]` 유지.
  - `body_with`에 항목 수 인자를 더한다(`2200` → 인자; 작은 본문은 `90`으로 ≈4 KiB). 감싼 필드 주기도 인자로(`100`마다 / `1`마다).
  - `miss_ratio_no_candidates`에 단언 추가: **C(풀림) ≤ 1.10**. A ≤ 1.25 단언 유지. B는 출력만.
  - 새 테스트 `nested_cost_rows`(출력만, 단언 없음): ① 작은 본문 C의 못 찾음 비율 ② 3단계에서 값을 찾는 경로(`$.items[0].payload.k`) ③ 풀리는 문자열 2,200개 본문의 못 찾음 ④ 엄격 2항목 `[$.nope, $.items]`를 풀 것 없는 본문 A에서 ⑤ 같은 2항목을 풀리는 본문 C에서. 비율의 분모는 "항목마다 파싱 없이 `jsonpath_first` 한 번 + 본문 파싱 한 번"의 옛 길.

- [ ] **Step 2: 측정 실행·기록** — `cargo test -p handicap-engine --release --test nested_json_perf -- --ignored --nocapture ; echo exit=$?` → exit=0. 출력 줄 전부를 보고에 붙인다. C가 1.10을 넘으면 STOP·보고(한 번 흔들린 것이면 다시 돌려 본다 — 3회 중 최솟값이 기준).

- [ ] **Step 3: 되돌려 확인** — Task 2 흐름 6의 `unwrap_in_place`를 "바탕 값을 `clone()`한 사본에 풀고 그 사본으로 바꾸기"로 잠깐 바꿔 Step 2 명령이 C 단언에서 실패하는지 보고 원복. 실패하지 않으면 단언이 복사 부활을 못 잡는 것이므로 STOP·보고.

- [ ] **Step 4: 깊이(release)** — `cargo test -p handicap-engine --release --test nested_json_depth ; echo exit=$?` → 2 passed, exit=0.

- [ ] **Step 5: 함정 한 줄** — `crates/engine/CLAUDE.md`의 "## 테스트" 묶음 끝에:
  `- **본문 추출이 3단계(안쪽까지 푼 값)로 넘어가면 평가가 든 본문 `Value`가 그 자리에서 풀린다 — 그 뒤 원래 본문이 필요한 일은 넘어가기 전에 `early`로 구해 둔다(`extract.rs` `body_path_first`). 추출 평가 안에 원래 본문을 읽는 코드를 더하면 이 목록에 넣을 것. 옛 구현 사본 `mod reference`와의 동등성 테스트가 지킨다. 측정 `nested_json_perf`의 C ≤ 1.10 단언은 `#[ignore]`라 게이트 밖 — 추출을 고치면 손으로 돌릴 것** (nested-json-cost)`

- [ ] **Step 6: 커밋** — `test(engine): 풀림 사례 비용 단언 + 측정 행, 함정 기록`.

---

## Task 뒤 (파이프라인 4–6단계 — task가 아니다)

0. **변이 점검(사용자 결정 2026-11-20 — 합류 조건이 아닌 점검)** — Task 3 커밋 뒤, 최종 리뷰 전에 `/mutation-audit`를 이번에 고친 코드로 좁혀 한 번. 워크트리 root에서, 다른 `cargo`와 겹치지 않게:
   - `cargo mutants -p handicap-engine -f src/json_unwrap.rs --timeout 120`
   - `cargo mutants -p handicap-engine -f src/extract.rs --re 'body_path_first|BodyCache' --timeout 120` — 먼저 같은 인자에 `--list`를 붙여 변이 목록이 본문 캐시·`body_path_first`를 덮는지 확인한다(`--re`가 안 맞으면 목록을 보고 정규식을 고친다; `mod reference`의 변이는 뺀다).
   - 살아남은(missed) 변이를 하나씩 분류한다: **값이 달라지는데 살아남음** → 그 변이를 죽이는 테스트를 더하고 커밋 / **결과는 같고 비용만 달라짐**(예: `has_unwrappable` 확인을 건너뜀, 미리 구하기를 더 많이 함) → 정상, 측정 단언이 지키는 쪽 / 그 밖의 동등 변이 → 근거 한 줄.
   - 분류 표(변이 · 분류 · 조치)를 roadmap 새 §B에 적는다. 끝나면 `mutants.out*` 삭제 + `git status --porcelain`으로 잔류 0 확인.
1. **최종 리뷰** `handicap-reviewer`(초점: 옛 동작의 부수효과에 기대던 소비자 — `executor.rs` 두 호출부, 모니터 칸이 도는 `trace_scenario` 경로). `finish-slice` §0 보안 grep을 직접 돌려 걸리면 `security-reviewer`.
2. **라이브(spec §6)** — `/live-verify`. master와 이 브랜치의 release 컨트롤러·워커를 따로 빌드(`CARGO_TARGET_DIR`는 절대경로), 4 VU × 15초, 본문 ≈142 KB, 요청당 워커 CPU(`scripts/bench-throughput.sh` 방식 — 컨트롤러 자식 PID의 `ps -o time=` 차이 ÷ 요청 수), 교차 3회 이상, 먼저 master 대 master로 흔들림.
   - ⓐ 찾는 경로만: master 대비 ±3% · ⓑ 못 찾음 + 후보 없음: master 대비 ±3% — **둘 중 하나라도 벗어나면 합류하지 않는다**(사용자 우려: 일반 시나리오 영향).
   - ⓒ 못 찾음 + 풀림: 이 브랜치에서 같은 (감싼 문자열이 든) 본문에 찾는 경로만 둔 시나리오 대비 +5% 안(US1). master ⓒ도 같은 날 다시 잰다.
   - 기록만: 작은 본문 ⓒ, 3단계에서 값을 찾는 시나리오. ⓒ의 에러 수·추출 실패 수가 master와 같은지.
   - 이전 측정의 응답기·시나리오 모양은 `docs/build-log.md`의 scenario-nested-json 단락과 roadmap §B72 (4).
3. **마무리** `/finish-slice` — roadmap 새 §B(`grep -n '^### B' docs/roadmap.md` 마지막 +1): 모니터 `BodyJson` 연기(spec §4 비용·해소 경로, 사용자 승인 2026-11-20), 미리 구한 값의 버려짐·동시 보유(spec §5.2), 측정 수치, §B72 (2) 첫 항목 해소 표시, 릴리즈 노트 한 줄(성능, 행동 변화 없음).
