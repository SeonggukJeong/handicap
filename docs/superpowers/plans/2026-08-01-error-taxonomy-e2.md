# error-taxonomy E2 — onset·원인 후보 인사이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E1이 운반해 온 `ReportJson.error_kinds`를 읽어, "t=N초까지 정상 → 이후 실패 급증" 시간 패턴과 "테스터 자신의 포트 고갈"을 서버측에서 판정하고, 지배 kind에 따른 **원인 후보 안내**를 리포트에 띄운다.

**Architecture:** 신규 집계 채널·마이그레이션·proto 변경 **0**. 컨트롤러 `insights.rs::derive_insights`가 기존 초당 시계열(`ReportWindow`)과 E1의 `error_kinds`를 입력으로 받아 순수 함수로 인사이트 2종을 파생하고, `Insight`에 additive 필드 `error_kind` 하나가 붙어 export 17열·UI `InsightPanel`까지 흐른다. 인사이트 미발행 run은 전 레이어 byte-identical.

**Tech Stack:** Rust(컨트롤러 `insights.rs`/`export.rs`/`report.rs`, 엔진 `executor.rs`) + TypeScript/React(`ui/src/api/schemas.ts`, `ui/src/i18n/ko.ts`, `ui/src/components/report/InsightPanel.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-01-error-taxonomy-design.md` — E2 범위는 §5.4 + §7.1(Insight)·7.3·7.5 + export 17열, 서브슬라이스 정의는 §13.

---

## Global Constraints

이 절의 값은 spec에서 verbatim 복사한 것이다. **모든 task의 요구사항은 이 절을 암묵적으로 포함한다.**

1. **byte-identical 불변식 (정확한 범위)** — 인사이트 2종 어느 것도 발행되지 않는 run은:
   - `/report` **JSON**: 완전 동일. `Insight.error_kind`는 `#[serde(skip_serializing_if = "Option::is_none")]`라 `None`이면 **키 자체가 부재**(null 아님).
   - **UI 렌더**: 완전 동일(신규 kind가 없으니 `message`/`actionFor` 신규 분기 미도달).
   - **CSV/XLSX**: **기존 16열의 값이** 동일. 17번째 열 `error_kind`는 헤더와 빈 셀이 **무조건 추가된다** — 이건 위반이 아니라 의도된 스키마 확장이다(export 열 추가의 기존 성질: `runner_up_ms` 추가 때도 동일했다). 그래서 `export.rs:1077`·`:1130`·`tests/export_routes_test.rs:521`의 하드코딩 헤더 문자열은 **고쳐야 할 대상**이지 불변식 위반의 증거가 아니다.
2. **소급 발행(수용)** — 리포트는 조회 시 재계산되므로 슬라이스 이전 run에도 onset 인사이트가 소급 등장할 수 있고(그 run들은 `error_kinds`가 비어 일반 조치문), 그때 `status_temporal`이 억제로 사라질 수 있다. spec §8 표에 기재된 **수용된 예외**다.
3. **조치문은 단정 금지** — 원인 문구는 항상 "가능성"·"확인하세요" 형태. h2 GOAWAY debug-data(서버가 제어하는 문자열)가 E1 규칙 5의 문자열 매치로 `tls` 오분류를 유발할 수 있어, 지배 kind는 **SUT가 유도할 수 있는 입력**이다(roadmap §B27). 단정문은 "SUT가 자기 진단 문구를 유도"하는 표면이 된다.
4. **용량 주장 금지** — narrative `cannot_claim: sut_capacity`와 충돌하지 않도록, 조치문은 측정치(RPS/레이턴시)로 용량을 판단하라고 말하지 **않는다**. 대신 SUT *상태*(TIME_WAIT·재사용 설정·backlog·FD 한도) 점검을 안내한다 (spec §5.4 R5/R6).
5. **모든 사용자 노출 문구는 `ui/src/i18n/ko.ts` 경유** (ADR-0035). `aria-label`도 포함. 고유명사(TIME_WAIT, SO_REUSEADDR, backlog, FD)는 원어 병기.
6. **조치문 `computed: true`** — 두 인사이트의 조치문은 run-특정 진단이므로 기본-숨김 토글(`readShowInsightActions()` 기본 false)과 무관하게 렌더한다. 이게 없으면 새 브라우저 프로필에서 US2가 실패한다 (spec §5.4 C1).
7. **`error_kinds`가 비어도 크래시·오작동 없음** — 구 워커 혼합 fan-out·과거 run은 `error_kinds`가 부분적이거나 빈 배열이다. 이때 onset은 `error_kind = None` + 일반 조치문으로 발행되고, loadgen 인사이트는 미발행이다.
8. **`grep -n`으로만 줄번호 확정** — 이 plan의 `파일:줄` 포인터는 작성 시점(base `d94356dd` + worktree) 기준이다. 편집 전 반드시 `grep -n`으로 재확인할 것(앞 task의 편집이 뒷 task의 줄번호를 민다).
9. **커밋 규율** — cargo-영향 커밋은 전체 workspace 빌드라 수 분. `git commit`에 `| tail`/`| head` 파이프 금지(종료코드 마스킹, git-guard가 deny), `--no-verify` 금지.

### 결정 기록 (이 plan이 spec §13의 "E2 plan 필수 항목"에 답한 것)

| 항목 | 결정 | 근거 |
|---|---|---|
| onset **지속 구간 하한** conjunct | **도입** — `(m − t0 + 1) ≥ 5` | 현행 수식은 `t0 = m`일 때 `1 ≥ 0.5×1`로 항상 참이라 **마지막 1초 blip에도 critical 인사이트를 발행**한다. `critical` 심각도 + 강한 인과 주장("SUT 소켓/포트 고갈 가능성")의 거짓양성 비용이 크고, report-advice-noise 슬라이스가 세운 "조언 밀도 축소" 규율과 정면 충돌. 사용자 결정 2026-08-01. |

**하한 값 `5`의 근거 — 실측이 아니라 수식 내적 근거다(정직하게 기록).** spec §13은 "E1 실측으로 확정"을 요구했지만, **E1의 라이브 run은 ephemeral DB(`/tmp`)에 있었고 슬라이스 종료와 함께 사라져 소급 측정이 불가능**하다. 따라서 5는 다음 논거로 골랐다: 기존 50% 규칙과 결합했을 때 `tail = 5`는 **bad 초가 최소 3개**여야 발행된다(⌈0.5×5⌉ = 3) — 즉 "한 번 튄 것"이 아니라 **패턴**임을 요구하는 최소 길이다. `tail = 3`이면 2초, `tail = 2`면 1초로 떨어져 blip과 구별되지 않는다.
**→ 이 값은 튜너블로 취급한다.** 도그푸딩 후 (a) 실제 고갈 run이 미발행되거나 (b) 여전히 거짓양성이 나면 재조정한다. finish-slice 때 roadmap §B27에 "`ONSET_MIN_TAIL_SECONDS` 도그푸딩 후 재평가" 한 줄을 남길 것.
| §B27 `e.without_url()` 교체 2곳 | **E2에 fold** (Task 4) | test-run trace 경로(`executor.rs:457`)는 `HttpTrace.error` → `StepTrace` → `TestRunPanel`로 **실도달**해 resolved 시크릿이 화면에 뜰 수 있다(pre-existing). E3 일정 미정이라 더 미루면 유실 위험. 사용자 결정 2026-08-01. |

### 알려진 한계 (수용 — 리뷰·라이브 검증 때 결함으로 오판하지 말 것)

1. **국소 고갈 미검출** — `bad(t)`는 전 스텝 합산이라 N-스텝 시나리오에서 한 스텝만 전멸하면 `bad ≤ 1/N`이다. 11스텝 이상에서 단일 엔드포인트만 고갈되면 onset이 안 잡힌다. per-step onset은 연기(spec §2·§5.4 R9).
2. **비교 뷰에서 onset이 두 행으로 갈릴 수 있다** — `InsightCompareMatrix.tsx:24-26`은 행 키를 `kind | step_id ?? status_class`로 만든다. `status_class`는 onset 이후 5xx가 10건 이상일 때만 붙으므로, 5xx 동반 run과 transport-only run을 비교하면 "런 도중 실패 급증 · 5xx"와 "런 도중 실패 급증" **두 행**이 생긴다. 기존 매트릭스 메커니즘의 새 발현이고 정보 손실은 없어 v1 수용 — finish-slice 때 roadmap §B27에 한 줄 남길 것.
3. **소급 발행** — Global Constraint 2 참조.

### spec의 사실 주장 1건 — 기각(검증 완료)

spec §9.2는 *"`status_temporal` 기존 테스트 3건(`insights.rs:744`/`:773`/`:791`)과 fixture(`:930`)의 전제를 억제 규칙에 맞춰 조정"* 을 요구한다. **이 주장은 틀렸다 — 조정 불필요.** 네 fixture 모두 `midrun_error_onset` 발행 조건에 도달하지 못한다:

| fixture | windows | data-seconds `m` | clean prefix `h` | `h ≥ 10`? |
|---|---|---|---|---|
| `status_temporal_emits_when_5xx_is_late` (:744) | ts 0(200×5), 9(500×3), 10(500×2) | 3 | 1 | ✗ |
| `no_status_temporal_when_5xx_early` (:773) | ts 0(500×5), 10(200×5) | 2 | 0 | ✗ |
| `no_status_temporal_single_second` (:791) | ts 7(500×5) | 1 | 0 | ✗ |
| order fixture (:915) | ts 0(200×1), 9(500×1) | 2 | 1 | ✗ |

→ 억제가 발동하지 않으므로 네 테스트 모두 **무수정 통과해야 한다**. Task 2 Step 8이 이를 기계적으로 확인한다. 대신 억제 규칙 자체의 회귀 가드는 Task 2가 **새 테스트**로 세운다(`h ≥ 10`을 실제로 만족하는 fixture).

---

## File Structure

| 파일 | 책임 | Task |
|---|---|---|
| `crates/controller/src/insights.rs` (수정) | `Insight.error_kind` 필드 · `derive_insights` 11번째 인자 · 인사이트 2종 파생 · `order_rank` · `status_temporal` 억제 | 1, 2 |
| `crates/controller/src/export.rs` (수정) | `INSIGHT_COLUMNS` 16→17 · `insight_csv_cells` · `write_insight_xlsx_row` · **테스트 `Insight` 리터럴 7곳 + 하드코딩 헤더 2곳** | 1 |
| `crates/controller/src/validity.rs` (수정) | **테스트 헬퍼 `insight()`의 `Insight` 리터럴 1곳** (필드 추가 파급) | 1 |
| `crates/controller/tests/export_routes_test.rs` (수정) | **하드코딩 CSV 헤더 문자열 1곳** (컴파일러 비검출) | 1 |
| `crates/controller/src/report.rs` (수정) | `derive_insights` 호출부에 `&error_kinds_rolled` 전달 | 2 |
| `ui/src/api/schemas.ts` (수정) | `InsightSchema.error_kind: z.string().optional()` | 3 |
| `ui/src/i18n/ko.ts` (수정) | `insightLabels` 2키 · 신규 `errorOnset` 네임스페이스(조치문 4종) · 본문 문구 | 3 |
| `ui/src/components/report/InsightPanel.tsx` (수정) | `message()` 2 case · `actionFor()` 4분기(전부 `computed: true`) | 3 |
| `ui/src/components/report/__tests__/InsightPanel.test.tsx` (수정) | RTL — 토글 off에서도 조치문 렌더 · 지배 kind 분기 | 3 |
| `crates/engine/src/executor.rs` (수정) | `e.without_url()` 2곳 + 인라인 회귀 테스트 2건 | 4 |

**신규 파일 없음.** migration·proto·store·engine 집계 채널 전부 0-diff (Task 4의 executor 2줄 제외).

---

### Task 1: `Insight.error_kind` 필드 + export 17열

**Files:**
- Modify: `crates/controller/src/insights.rs` (`Insight` struct — `runner_up_ms` 필드가 `:48-51`, `Insight::new`의 초기화 목록 `:56-73`)
- Modify: `crates/controller/src/export.rs` (`INSIGHT_COLUMNS` `:89-106`, `insight_csv_cells` `:109-130`, `write_insight_xlsx_row` `:134-185`, **테스트 리터럴·헤더 9곳** — 아래 Step 4 표)
- Modify: `crates/controller/src/validity.rs` (테스트 헬퍼 `insight()` `:252-271`)
- Modify: `crates/controller/tests/export_routes_test.rs` (하드코딩 헤더 `:521`)
- Test: `export.rs`의 인라인 `#[cfg(test)] mod tests`(`:576`부터)

**Interfaces:**
- Consumes: 없음 (첫 task)
- Produces: `pub struct Insight { …, pub error_kind: Option<String> }` — 필드 **선언 순서상 `runner_up_ms` 다음, 즉 마지막**. Task 2가 이 필드에 값을 채우고, Task 3이 Zod로 파싱한다.

**왜 이 task를 signature 변경과 분리하나:** `derive_insights`에 인자만 먼저 추가하면 Task 2까지 그 인자가 미사용이라 rustc `unused_variables`가 `-D warnings`에서 빌드를 깬다. 그래서 Task 1은 **필드+export만**, Task 2가 인자와 사용을 같은 커밋에 넣는다.

> **`Insight`와 모든 필드는 `pub`이다**(`insights.rs:9-52`). 새 생성자를 만들 필요 없다 — `export.rs:1043`에 이미 `fn insight(kind, severity) -> crate::insights::Insight` 테스트 헬퍼가 있다. 이걸 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — export 17열 정합**

`crates/controller/src/export.rs`의 `mod tests` 안, 기존 `insight_columns_are_single_source`(~`:1094`) **바로 뒤**에 추가:

```rust
    #[test]
    fn insight_error_kind_column_round_trips() {
        // E2: 17번째 열 `error_kind`. Some이면 셀에 kind 문자열, None이면 빈 셀.
        // INSIGHT_COLUMNS는 Insight 필드 선언 순서와 1:1이므로 마지막 열이다.
        assert_eq!(
            INSIGHT_COLUMNS.len(),
            17,
            "E2가 error_kind 열을 더해 16→17이어야 한다"
        );
        assert_eq!(*INSIGHT_COLUMNS.last().expect("non-empty"), "error_kind");

        let mut ins = insight("midrun_error_onset", "critical");
        ins.error_kind = Some("connection_reset".to_string());
        let cells = insight_csv_cells(&ins);
        assert_eq!(cells.len(), 17);
        assert_eq!(cells[16], "connection_reset");

        let bare = insight("slo_pass", "info");
        let bare_cells = insight_csv_cells(&bare);
        assert_eq!(bare_cells.len(), 17);
        assert_eq!(bare_cells[16], "", "None → 빈 문자열");
    }
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cargo test -p handicap-controller --lib export::tests::insight_error_kind_column_round_trips 2>&1 | tail -20`
Expected: 컴파일 실패 — `no field 'error_kind' on type 'Insight'`.

- [ ] **Step 3: `Insight`에 필드를 추가한다**

`crates/controller/src/insights.rs` — `runner_up_ms` 필드(`:48-51`) **바로 뒤**, struct 닫는 `}` 앞:

```rust
    /// transport 실패의 지배 kind(총합 대비 ≥50%). onset 인사이트가 원인 후보
    /// 조치문을 고르는 근거이자 export 17번째 열. 지배 kind가 없거나
    /// `error_kinds`가 비면(구 워커 혼합·과거 run) None → 일반 조치문.
    /// `loadgen_port_exhaustion` 인사이트에선 항상 "local_port_exhaustion".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
```

`Insight::new`의 필드 초기화 목록(`:72` `runner_up_ms: None,` 뒤)에:

```rust
            error_kind: None,
```

- [ ] **Step 4: 필드 추가가 파급되는 11곳을 전부 방문한다** (컴파일 실패 4 · 조용히 깨짐 3 · 확인만 4)

`Insight`는 exhaustive struct 리터럴로 만들어지는 곳이 많고, CSV 헤더는 **문자열로 하드코딩**된 곳이 있다. 후자는 **컴파일러가 못 잡으므로** 반드시 손으로 확인할 것.

**(A) `Insight { … }` 리터럴 8곳** (전부 `#[cfg(test)]` 안이다. 프로덕션 리터럴은 `Insight::new` 하나뿐). **이 중 4곳만 실제로 깨진다** — 나머지 4곳은 `..insight(…)` **FRU**(functional update syntax)라 새 필드가 자동으로 채워진다:

| 파일 | 줄 | 형태 | 조치 |
|---|---|---|---|
| `crates/controller/src/export.rs` | `:775`, `:797`, `:1044`(헬퍼 `insight()` 본체) | exhaustive | **`error_kind: None,` 추가** |
| `crates/controller/src/validity.rs` | `:253` (헬퍼 `insight()` 본체 — `:273`/`:279`의 `insight_count`/`insight_sc`는 이걸 호출하므로 자동 해소) | exhaustive | **`error_kind: None,` 추가** |
| `crates/controller/src/export.rs` | `:1067`, `:1110`, `:1115`, `:1153` | `..insight("…", "…")` FRU | **수정 불필요 — 확인만** |

**`cargo build --workspace --tests`는 E0063을 정확히 4개** 낸다(8개가 아니다 — FRU 4곳은 애초에 에러가 아니다). 4개를 고쳐 0 에러가 되면 (A)는 끝이다. "4개밖에 안 나온다"를 **전수 스윕 실패로 오독하지 말 것.**

**(B) 컴파일러가 **못** 잡는 곳 — 하드코딩 CSV 헤더 문자열 3곳** (여기가 진짜 위험 지점):

| 파일 | 줄 | 현재 | 고칠 것 |
|---|---|---|---|
| `crates/controller/src/export.rs` | `:1077` | `"kind,…,runner_up_ms"` (16열) | 끝에 `,error_kind` |
| `crates/controller/src/export.rs` | `:1130` | `"run_id,kind,…,runner_up_ms"` (run_id + 16열) | 끝에 `,error_kind` |
| `crates/controller/tests/export_routes_test.rs` | `:521` | `"kind,…,runner_up_ms"` (16열) | 끝에 `,error_kind` |

**(C) 건드리지 않는 곳(확인만):** `export.rs:869-877`의 XLSX 헤더 단언은 `runner_up_ms`를 **col 15**로 집는데, `error_kind`는 col 16에 추가되므로 **무영향**이다. 주석 `// 16번째 열 runner_up_ms (col 15 = P)`도 여전히 정확하다(17열 중 16번째). 수정 불필요.

- [ ] **Step 5: export 3사이트를 배선한다**

`crates/controller/src/export.rs`:

(a) `INSIGHT_COLUMNS` 선언(`:89`)의 타입과 마지막 원소:

```rust
const INSIGHT_COLUMNS: [&str; 17] = [
```

`"runner_up_ms",` 뒤에 한 줄 추가:

```rust
    "error_kind",
```

(b) `insight_csv_cells`(`:108`) doc 주석의 "16개"를 "17개"로 고치고, `f(ins.runner_up_ms),` 뒤에 추가:

```rust
        ins.error_kind.clone().unwrap_or_default(),
```

(c) `write_insight_xlsx_row`(`:132`) doc 주석의 "16개"를 "17개"로 고치고, `runner_up_ms` 블록(`:182-184`) 뒤·함수 닫는 `}`(`:185`) 앞에 추가:

```rust
    if let Some(v) = &ins.error_kind {
        ws.write_string(row, c(16), v).expect("w");
    }
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cargo test -p handicap-controller --lib export:: 2>&1 | tail -30`
Expected: PASS — 신규 테스트 + 기존 `insight_columns_are_single_source` + Step 4(B)에서 고친 헤더 단언 2건. **Step 4를 건너뛰었다면 여기서 헤더 문자열 불일치로 FAIL한다** — 그게 이 스텝의 목적이다.

- [ ] **Step 7: byte-identical 회귀를 전체 게이트로 확인한다**

Run: `cargo build --workspace --tests 2>&1 | tail -5 && cargo nextest run -p handicap-controller 2>&1 | tail -20`
Expected: 0 failed. 특히 ① `golden_summary_deltas_match`(골든 fixture 역직렬화 — `error_kind`가 `skip_serializing_if`+`Option`이라 기존 골든 JSON은 무변경이어야 한다) ② `export_routes_test`(Step 4(B)의 통합 테스트 헤더) ③ XLSX 라운드트립.

- [ ] **Step 8: 이빨 실증 — 열 값 회귀를 주입해 RED 확인**

`INSIGHT_COLUMNS`의 `"error_kind",`를 **삭제하지 말고**(배열 길이가 17로 선언돼 있어 E0308 컴파일 에러가 나면 단언이 아예 안 돌아 아무것도 증명 못 한다) **값만 바꾼다**: `"error_kind",` → `"error_kindX",` →
Run: `cargo test -p handicap-controller --lib export::tests::insight_error_kind_column_round_trips 2>&1 | tail -10`
Expected: **FAIL** — `INSIGHT_COLUMNS.last()` 단언이 깨진다(컴파일은 성공). → 값 복원 → 재실행 GREEN.

두 번째 이빨: `insight_csv_cells`에서 `ins.error_kind.clone().unwrap_or_default(),` 줄을 `String::new(),`로 임시 교체 → 같은 테스트가 `cells[16] == "connection_reset"`에서 **FAIL** → 원복 → GREEN.

`git diff crates/controller/src/export.rs`로 두 원복을 확인한다(production diff는 최종 의도한 것만 남아야 한다).

- [ ] **Step 9: 커밋 — 4개 파일 전부**

```bash
git add crates/controller/src/insights.rs crates/controller/src/export.rs \
        crates/controller/src/validity.rs crates/controller/tests/export_routes_test.rs
git diff --cached --name-only   # 4개 파일이 보여야 한다
git commit -m "feat(controller): Insight.error_kind 필드 + export 17열 (E2 Task 1)"
```

> **`git add`에서 `validity.rs`·`export_routes_test.rs`를 빠뜨리면 커밋된 트리가 컴파일되지 않는다.** pre-commit 훅은 **작업트리**를 빌드하지 인덱스를 빌드하지 않으므로 게이트는 통과하고, 뒤 task 중 어느 것도 그 파일들을 스테이징하지 않아 red가 그대로 landed된다. 커밋 전 `git diff --cached --name-only` 확인이 유일한 방어다.

---

### Task 2: 인사이트 2종 파생 + `order_rank` + `status_temporal` 억제

**Files:**
- Modify: `crates/controller/src/insights.rs` (`order_rank` `:80-93`, `derive_insights` 시그니처 `:136-147`, `status_temporal` 블록 `:236-263`, 새 헬퍼 + 새 발행 블록, 테스트 call site 35곳)
- Modify: `crates/controller/src/report.rs` (`derive_insights` 호출부 `:801-821`)
- Test: `crates/controller/src/insights.rs` 인라인 `mod tests`

**Interfaces:**
- Consumes: `Insight.error_kind: Option<String>` (Task 1)
- Produces:
  - `pub fn derive_insights(…, error_kinds: &[crate::report::ErrorKindCount]) -> Vec<Insight>` — **`error_kinds`가 마지막(11번째) 인자**
  - 인사이트 kind 문자열 2종: `"midrun_error_onset"`(severity `"critical"`), `"loadgen_port_exhaustion"`(severity `"critical"`) — Task 3의 ko 키·`actionFor` 분기가 이 문자열에 1:1 대응
  - `midrun_error_onset` 필드 계약: `onset_second: Some(i64)`, `count: Some(u64)`(onset 이후 status0+5xx 합), `status_class: Some("5xx")`(onset 이후 5xx 합 ≥ 10일 때만), `error_kind: Option<String>`(지배 kind가 인식 4종일 때만)
  - `loadgen_port_exhaustion` 필드 계약: `count: Some(u64)`(local_port_exhaustion 건수), `error_kind: Some("local_port_exhaustion")`

**발행 수식 (spec §5.4 ① + 사용자 결정 하한):**

```
행 집합: ReportWindow 전체를 ts_second로 재집계(per-step·per-worker 행 중복 무관 — 전부 합산).
data_seconds = { t | Σ count(t) > 0 }를 오름차순 정렬한 s_1..s_m   (요청 0인 초는 존재하지 않는 초)
bad(s_i) = (status "0" 합 + 5xx 합) / count 합                      (5xx = 첫 글자 '5'인 status 키)
h  = bad(s_i) < 0.01 이 연속인 최장 프리픽스 길이
t0 = min{ i > h : bad(s_i) ≥ 0.10 }
발행 ⇔ h ≥ 10  ∧  t0 존재  ∧  (m − t0 + 1) ≥ 5  ∧  |{ i ≥ t0 : bad(s_i) ≥ 0.10 }| ≥ 0.5 × (m − t0 + 1)
onset_second = s_{t0} − s_1                                         (run 시작초 정본 = 첫 data-second)
```

- [ ] **Step 1: 실패하는 테스트를 쓴다 — onset 발행/미발행 경계**

`crates/controller/src/insights.rs`의 `mod tests` 안, `win` 헬퍼(`:730-741`) 뒤에 헬퍼와 테스트를 추가한다.

```rust
    /// onset fixture 헬퍼 — 한 초의 (총 요청, 나쁜 요청) 쌍을 status_counts로 만든다.
    /// `count`가 status 합과 일치하도록 "200"을 채운다(프로덕션 불변식 — bad(t) ∈ [0,1]).
    fn win_bad(ts: i64, total: u64, bad: u64, bad_key: &str) -> ReportWindow {
        let ok = total - bad;
        let mut sc: BTreeMap<String, u64> = BTreeMap::new();
        if ok > 0 {
            sc.insert("200".to_string(), ok);
        }
        if bad > 0 {
            sc.insert(bad_key.to_string(), bad);
        }
        ReportWindow {
            ts_second: ts,
            step_id: "a".to_string(),
            count: total,
            error_count: bad,
            status_counts: sc,
            p50_ms: 1,
            p95_ms: 1,
            p99_ms: 1,
        }
    }

    /// clean 10초(ts 0..9) + 이후 `tail` 초를 전부 bad로 채운 표준 onset fixture.
    fn onset_windows(tail: usize, bad_key: &str) -> Vec<ReportWindow> {
        let mut v: Vec<ReportWindow> = (0..10).map(|t| win_bad(t, 100, 0, bad_key)).collect();
        for k in 0..tail {
            v.push(win_bad(10 + k as i64, 100, 100, bad_key));
        }
        v
    }

    fn kinds(pairs: &[(&str, u64)]) -> Vec<crate::report::ErrorKindCount> {
        pairs
            .iter()
            .map(|(k, c)| crate::report::ErrorKindCount {
                kind: k.to_string(),
                count: *c,
            })
            .collect()
    }

    fn onset_of(windows: &[ReportWindow], ek: &[crate::report::ErrorKindCount]) -> Option<Insight> {
        derive_insights(
            &summary(),
            &[],
            windows,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
            ek,
        )
        .into_iter()
        .find(|i| i.kind == "midrun_error_onset")
    }

    #[test]
    fn onset_emits_with_clean_prefix_and_sustained_tail() {
        let w = onset_windows(5, "0");
        let got = onset_of(&w, &kinds(&[("connection_reset", 400), ("other", 100)])).expect("발행");
        assert_eq!(got.severity, "critical");
        assert_eq!(got.onset_second, Some(10), "s_t0(=10) − s_1(=0)");
        assert_eq!(got.count, Some(500), "onset 이후 status0+5xx 합");
        assert_eq!(
            got.error_kind.as_deref(),
            Some("connection_reset"),
            "400/500 = 80% ≥ 50% → 지배 kind"
        );
        assert_eq!(got.status_class, None, "5xx가 0건이므로 미부착");
    }

    #[test]
    fn onset_not_emitted_when_clean_prefix_is_nine() {
        // h = 9 < 10. 경계 아래.
        let mut w: Vec<ReportWindow> = (0..9).map(|t| win_bad(t, 100, 0, "0")).collect();
        for k in 0..10 {
            w.push(win_bad(9 + k, 100, 100, "0"));
        }
        assert!(onset_of(&w, &[]).is_none());
    }

    #[test]
    fn onset_not_emitted_when_tail_shorter_than_five() {
        // 사용자 결정 2026-08-01: (m − t0 + 1) ≥ 5. tail=4는 미발행, tail=5는 발행.
        assert!(
            onset_of(&onset_windows(4, "0"), &[]).is_none(),
            "tail 4초 — 하한 미달"
        );
        assert!(
            onset_of(&onset_windows(5, "0"), &[]).is_some(),
            "tail 5초 — 하한 충족"
        );
    }

    #[test]
    fn onset_not_emitted_for_tail_blip() {
        // 하한 conjunct가 없으면 t0 = m에서 1 ≥ 0.5×1로 항상 참이 되어 발행됐다.
        // 이 테스트가 그 회귀를 막는다.
        let w = onset_windows(1, "0");
        assert!(onset_of(&w, &[]).is_none(), "마지막 1초 blip은 발행 금지");
    }

    #[test]
    fn onset_clean_threshold_is_strictly_below_one_percent() {
        // clean 판정은 `< 0.01`. 10번째 초를 정확히 0.01로 두면 clean이 아니라서
        // h = 9 → 미발행. 0.009면 clean이라 h = 10 → 발행.
        // 두 fixture가 짝이어야 경계를 *구별*한다(한쪽만이면 h<10로 항상 None이라 공허).
        let build = |tenth_bad: u64| {
            let mut w: Vec<ReportWindow> = (0..9).map(|t| win_bad(t, 1000, 0, "0")).collect();
            w.push(win_bad(9, 1000, tenth_bad, "0"));
            for t in 10..20 {
                w.push(win_bad(t, 1000, 1000, "0"));
            }
            w
        };
        assert!(
            onset_of(&build(10), &[]).is_none(),
            "10/1000 = 0.01은 clean이 아니다(< 아니라 =) → h=9 → 미발행"
        );
        assert!(
            onset_of(&build(9), &[]).is_some(),
            "9/1000 = 0.009 < 0.01 → clean → h=10 → 발행"
        );
    }

    #[test]
    fn onset_bad_threshold_is_at_least_ten_percent() {
        // t0는 `bad ≥ 0.10`인 최초의 초. 정확히 0.10이면 t0가 된다.
        // clean 10초 뒤 9% 초 5개 → t0 없음(미발행), 10%면 t0 성립(발행).
        let build = |bad: u64| {
            let mut w: Vec<ReportWindow> = (0..10).map(|t| win_bad(t, 1000, 0, "0")).collect();
            for t in 10..20 {
                w.push(win_bad(t, 1000, bad, "0"));
            }
            w
        };
        assert!(onset_of(&build(99), &[]).is_none(), "9.9% < 10% → t0 부재");
        let got = onset_of(&build(100), &[]).expect("정확히 10%면 t0");
        assert_eq!(got.onset_second, Some(10));
    }

    #[test]
    fn onset_requires_half_the_tail_to_be_bad() {
        // spec §9.2가 요구한 sustained 50% 경계. tail = 8일 때 ⌈0.5×8⌉ = 4.
        // bad 3개(37.5%) → 미발행, 4개(50%) → 발행.
        // 주의: t0 자신은 항상 bad이므로 bad 초는 t0 + (그 뒤 bad 개수)다.
        let build = |bad_count: usize| {
            let mut w: Vec<ReportWindow> = (0..10).map(|t| win_bad(t, 100, 0, "0")).collect();
            for k in 0..8usize {
                // 앞에서부터 bad_count개만 나쁘게, 나머지는 정상(2%: clean도 bad도 아님)
                let bad = if k < bad_count { 100 } else { 2 };
                w.push(win_bad(10 + k as i64, 100, bad, "0"));
            }
            w
        };
        assert!(
            onset_of(&build(3), &[]).is_none(),
            "tail 8초 중 bad 3초(37.5%) < 50% → 미발행"
        );
        assert!(
            onset_of(&build(4), &[]).is_some(),
            "tail 8초 중 bad 4초(50%) → 발행"
        );
    }

    #[test]
    fn onset_catches_gradual_band_crossing() {
        // 리뷰 N1: 1% → 5% → 80%처럼 밴드를 거쳐 오르는 급증도 잡아야 한다.
        // t0는 "≥10%인 최초의 초"라 5% 구간을 건너뛰고 80% 구간을 집는다.
        let mut w: Vec<ReportWindow> = (0..10).map(|t| win_bad(t, 100, 0, "0")).collect();
        w.push(win_bad(10, 100, 1, "0")); // 1% — clean 아님(≥0.01), bad도 아님
        w.push(win_bad(11, 100, 5, "0")); // 5% — 여전히 밴드 안
        for t in 12..20 {
            w.push(win_bad(t, 100, 80, "0")); // 80%
        }
        let got = onset_of(&w, &[]).expect("발행");
        assert_eq!(got.onset_second, Some(12), "≥10%인 최초 초 = ts 12");
    }

    #[test]
    fn onset_ignores_seconds_with_no_requests() {
        // 요청 0인 초는 "존재하지 않는 초" — 갭이 있어도 h/t0 산정에 안 낀다.
        let mut w: Vec<ReportWindow> = (0..10).map(|t| win_bad(t, 100, 0, "0")).collect();
        w.push(win_bad(10, 0, 0, "0")); // count=0 → 제외
        for t in 11..17 {
            w.push(win_bad(t, 100, 100, "0"));
        }
        let got = onset_of(&w, &[]).expect("발행");
        assert_eq!(got.onset_second, Some(11));
    }

    #[test]
    fn onset_aggregates_duplicate_rows_per_second() {
        // per-step·per-worker로 같은 ts_second 행이 여러 개여도 전부 합산한다.
        let mut w: Vec<ReportWindow> = Vec::new();
        for t in 0..10 {
            w.push(win_bad(t, 50, 0, "0"));
            w.push(win_bad(t, 50, 0, "0")); // 같은 초, 다른 스텝
        }
        for t in 10..16 {
            w.push(win_bad(t, 50, 50, "0"));
            w.push(win_bad(t, 50, 50, "0"));
        }
        let got = onset_of(&w, &[]).expect("발행");
        assert_eq!(got.onset_second, Some(10));
        assert_eq!(got.count, Some(600), "6초 × (50+50)");
    }

    #[test]
    fn onset_attaches_5xx_class_and_dominant_kinds() {
        let w = onset_windows(6, "503");
        let got = onset_of(&w, &kinds(&[("timeout", 300), ("dns", 100)])).expect("발행");
        assert_eq!(
            got.status_class.as_deref(),
            Some("5xx"),
            "onset 이후 5xx 600건 ≥ 10"
        );
        assert_eq!(got.error_kind.as_deref(), Some("timeout"), "300/400 = 75%");
    }

    #[test]
    fn onset_error_kind_none_when_no_dominant_or_empty() {
        // ① error_kinds 빈 경우(과거 run·구 워커) → None → 일반 조치문
        let got = onset_of(&onset_windows(6, "0"), &[]).expect("발행");
        assert_eq!(got.error_kind, None);
        // ② 지배 kind 없음(어느 것도 50% 미만)
        let got2 = onset_of(
            &onset_windows(6, "0"),
            &kinds(&[("connection_reset", 40), ("timeout", 35), ("dns", 30)]),
        )
        .expect("발행");
        assert_eq!(got2.error_kind, None, "최대 40/105 = 38% < 50%");
        // ③ 지배하지만 인식 4종이 아님 → None(일반 조치문)
        let got3 = onset_of(&onset_windows(6, "0"), &kinds(&[("other", 99), ("dns", 1)]))
            .expect("발행");
        assert_eq!(got3.error_kind, None, "other는 원인 후보를 특정 못 함");
    }

    #[test]
    fn onset_suppresses_status_temporal() {
        // 같은 현상의 더 구체적 판정이 우선(spec §5.4 R7).
        let w = onset_windows(6, "503");
        let got = derive_insights(
            &summary(),
            &[],
            &w,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
            &[],
        );
        assert!(got.iter().any(|i| i.kind == "midrun_error_onset"));
        assert!(
            got.iter().all(|i| i.kind != "status_temporal"),
            "onset 발행 시 status_temporal 억제"
        );
    }

    #[test]
    fn loadgen_port_exhaustion_emits_on_single_occurrence() {
        // 1건 임계는 의도 — 테스터 자신의 포트 고갈은 1건이라도 측정 오염 신호.
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
            &kinds(&[("local_port_exhaustion", 1), ("connect_refused", 900)]),
        );
        let l = got
            .iter()
            .find(|i| i.kind == "loadgen_port_exhaustion")
            .expect("발행");
        assert_eq!(l.severity, "critical");
        assert_eq!(l.count, Some(1));
        assert_eq!(l.error_kind.as_deref(), Some("local_port_exhaustion"));
    }

    #[test]
    fn loadgen_port_exhaustion_absent_without_the_kind() {
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
            &kinds(&[("connect_refused", 900)]),
        );
        assert!(got.iter().all(|i| i.kind != "loadgen_port_exhaustion"));
    }

    #[test]
    fn new_insights_sort_above_existing_ones() {
        // order_rank: loadgen(측정 유효성) 최상단, onset 그 다음, 이후 기존 순서.
        let w = onset_windows(6, "503");
        let got = derive_insights(
            &summary(),
            &[],
            &w,
            &dist(&[("200", 900), ("500", 100)]),
            None,
            "",
            0,
            None,
            None,
            None,
            &kinds(&[("local_port_exhaustion", 2), ("timeout", 400)]),
        );
        let order: Vec<&str> = got.iter().map(|i| i.kind.as_str()).collect();
        let li = order
            .iter()
            .position(|k| *k == "loadgen_port_exhaustion")
            .expect("loadgen");
        let oi = order
            .iter()
            .position(|k| *k == "midrun_error_onset")
            .expect("onset");
        let si = order
            .iter()
            .position(|k| *k == "status_class")
            .expect("status_class 5xx");
        assert!(li < oi, "loadgen이 onset보다 앞");
        assert!(oi < si, "onset이 기존 인사이트보다 앞");
    }
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cargo test -p handicap-controller --lib insights::tests::onset 2>&1 | tail -20`
Expected: 컴파일 실패 — `derive_insights` takes 10 arguments but 11 were supplied.

- [ ] **Step 3: `derive_insights` 시그니처에 인자를 더하고 기존 호출부 36곳(테스트 35 + 프로덕션 1)을 갱신한다**

`crates/controller/src/insights.rs:136-147` — 파라미터 목록 마지막(`scheduled_arrivals: Option<f64>,` 뒤)에:

```rust
    /// E1이 운반한 run-level transport 실패 분류(count desc → kind asc 정렬).
    /// 비어 있을 수 있다: 과거 run·구 워커 혼합 fan-out(§8 proto additive 거동).
    error_kinds: &[crate::report::ErrorKindCount],
```

그리고 `:132-134`의 인자수 주석을 갱신한다:

```rust
// 11 인자: A9 사이징(max_in_flight/target_rps/scheduled_arrivals)에 E2의 error_kinds가
// 더해져 clippy 임계(7)를 넘는다.
```

`crates/controller/src/report.rs:801-821` 호출부 — 마지막 인자 뒤에 추가한다. `error_kinds_rolled`는 `:503`에서 이미 만들어져 `:964`에서 소비되므로 이 지점에서 빌려 쓸 수 있다:

```rust
        &error_kinds_rolled,
```

인라인 테스트 35개 call site: 각 호출의 닫는 `)` 앞에 `&[],`(또는 위 헬퍼가 만든 값)를 더한다. **`cargo build --workspace --tests`가 전수를 강제**하므로 컴파일러 출력을 따라 0 에러까지 반복한다.

- [ ] **Step 4: 테스트가 컴파일되고 *로직 미구현으로* 실패하는지 확인한다**

Run: `cargo test -p handicap-controller --lib insights::tests::onset 2>&1 | tail -30`
Expected: 컴파일 성공, `onset_emits_with_clean_prefix_and_sustained_tail` 등이 `발행` panic(=`expect` 실패)으로 FAIL. **컴파일 에러가 아니라 assertion 실패여야 한다** — 아니면 Step 3이 덜 끝난 것.

- [ ] **Step 5: onset 파생 헬퍼를 구현한다**

`crates/controller/src/insights.rs` — `derive_insights` 함수 **앞**(`:132`의 주석 블록 위)에 상수·타입·헬퍼를 둔다:

```rust
/// `midrun_error_onset` 판정 상수 (spec §5.4 ①).
/// 하한 conjunct는 사용자 결정 2026-08-01 — 없으면 t0 = m에서 1 ≥ 0.5×1이 항상
/// 참이라 마지막 1초 blip에도 critical 인사이트가 발행된다.
const ONSET_CLEAN_MAX: f64 = 0.01;
const ONSET_BAD_MIN: f64 = 0.10;
const ONSET_MIN_CLEAN_SECONDS: usize = 10;
const ONSET_MIN_TAIL_SECONDS: usize = 5;
/// onset 이후 5xx가 이만큼 쌓여야 `status_class = "5xx"`를 붙인다.
const ONSET_5XX_MIN: u64 = 10;

/// ts_second로 재집계한 한 초. `count`는 그 초의 총 요청 수(모든 스텝·워커 합).
struct OnsetSecond {
    ts: i64,
    count: u64,
    /// status "0"(transport 실패) + 5xx 합.
    bad: u64,
    fivexx: u64,
}

struct OnsetFacts {
    onset_second: i64,
    bad_after: u64,
    fivexx_after: u64,
}

/// "처음엔 정상 → 도중부터 실패 급증" 시간 패턴을 초당 시계열에서 판정한다.
/// 한계(spec §5.4 R9): bad(t)는 전 스텝 합산이라 N-스텝 시나리오에서 한 스텝만
/// 전멸하면 bad ≤ 1/N — 11스텝 이상 단일-엔드포인트 국소 고갈은 미검출.
/// per-step onset은 연기(spec §2).
fn midrun_onset(windows: &[ReportWindow]) -> Option<OnsetFacts> {
    let mut by_sec: BTreeMap<i64, (u64, u64, u64)> = BTreeMap::new();
    for w in windows {
        let five: u64 = w
            .status_counts
            .iter()
            .filter(|(k, _)| k.starts_with('5'))
            .map(|(_, v)| *v)
            .sum();
        let zero = w.status_counts.get("0").copied().unwrap_or(0);
        let e = by_sec.entry(w.ts_second).or_insert((0, 0, 0));
        e.0 += w.count;
        e.1 += zero + five;
        e.2 += five;
    }
    // 요청 0인 초는 "존재하지 않는 초"로 취급 — 갭이 h/t0 산정을 오염시키지 않는다.
    let secs: Vec<OnsetSecond> = by_sec
        .into_iter()
        .filter(|(_, (count, _, _))| *count > 0)
        .map(|(ts, (count, bad, fivexx))| OnsetSecond {
            ts,
            count,
            bad,
            fivexx,
        })
        .collect();
    let m = secs.len();
    if m == 0 {
        return None;
    }
    let ratio = |s: &OnsetSecond| s.bad as f64 / s.count as f64; // count > 0 보장

    // h = bad < 0.01이 연속인 최장 프리픽스 길이(프리픽스이므로 유일).
    let h = secs.iter().take_while(|s| ratio(s) < ONSET_CLEAN_MAX).count();
    if h < ONSET_MIN_CLEAN_SECONDS {
        return None;
    }
    // t0 = h 이후 처음으로 bad ≥ 0.10인 초(최소성으로 유일 — 밴드를 거치는
    // 점진적 급증도 포착).
    let t0 = (h..m).find(|&i| ratio(&secs[i]) >= ONSET_BAD_MIN)?;
    let tail = m - t0;
    if tail < ONSET_MIN_TAIL_SECONDS {
        return None;
    }
    let bad_secs = (t0..m).filter(|&i| ratio(&secs[i]) >= ONSET_BAD_MIN).count();
    if (bad_secs as f64) < 0.5 * tail as f64 {
        return None;
    }
    Some(OnsetFacts {
        // run 시작초 정본 = 첫 data-second(ReportRun.started_at 아님 — 리뷰 C5).
        onset_second: secs[t0].ts - secs[0].ts,
        bad_after: secs[t0..].iter().map(|s| s.bad).sum(),
        fivexx_after: secs[t0..].iter().map(|s| s.fivexx).sum(),
    })
}

/// 총합 대비 ≥50%를 차지하면서 **원인 후보를 특정할 수 있는** kind를 고른다.
/// 인식 4종이 아니거나(예 `other`·`tls`) 지배 kind가 없으면 None → 일반 조치문.
/// 동률은 kind 사전순으로 깬다(report.rs 롤업 정렬과 같은 규칙 → 결정적).
fn dominant_error_kind(error_kinds: &[crate::report::ErrorKindCount]) -> Option<String> {
    const RECOGNIZED: [&str; 4] = [
        "connection_reset",
        "connect_timeout",
        "timeout",
        "connect_refused",
    ];
    let total: u64 = error_kinds.iter().map(|k| k.count).sum();
    if total == 0 {
        return None;
    }
    let mut best: Option<&crate::report::ErrorKindCount> = None;
    for k in error_kinds {
        if best.is_none_or(|b| k.count > b.count || (k.count == b.count && k.kind < b.kind)) {
            best = Some(k);
        }
    }
    let best = best?;
    if (best.count as f64) < 0.5 * total as f64 {
        return None;
    }
    RECOGNIZED
        .contains(&best.kind.as_str())
        .then(|| best.kind.clone())
}
```

- [ ] **Step 6: 발행 블록 2개를 `derive_insights`에 넣고 `status_temporal`을 억제한다**

`crates/controller/src/insights.rs`의 `status_temporal` 블록(`:236` `{`으로 시작)을 **onset 판정 뒤로 게이트**한다. 블록 시작 직전에 onset을 계산하고, `status_temporal` 블록 전체를 `if onset.is_none() { … }`로 감싼다:

```rust
    // midrun_error_onset (spec §5.4 ①, E2). status_temporal보다 구체적인 판정이라
    // 발행되면 그쪽을 억제한다(리뷰 R7 — 같은 현상의 두 문장 방지).
    let onset = midrun_onset(windows);
    if let Some(f) = &onset {
        let mut ins = Insight::new("midrun_error_onset", "critical");
        ins.onset_second = Some(f.onset_second);
        ins.count = Some(f.bad_after);
        if f.fivexx_after >= ONSET_5XX_MIN {
            ins.status_class = Some("5xx".to_string());
        }
        ins.error_kind = dominant_error_kind(error_kinds);
        out.push(ins);
    }

    // loadgen_port_exhaustion (spec §5.4 ②, E2). 1건 임계는 의도 — 테스터 자신의
    // 포트 고갈은 단 1건이라도 그 run의 측정 전체가 오염됐다는 신호다.
    if let Some(k) = error_kinds
        .iter()
        .find(|k| k.kind == "local_port_exhaustion" && k.count >= 1)
    {
        let mut ins = Insight::new("loadgen_port_exhaustion", "critical");
        ins.count = Some(k.count);
        ins.error_kind = Some("local_port_exhaustion".to_string());
        out.push(ins);
    }
```

그리고 기존 `status_temporal` 블록을 감싼다 — `:236`의 여는 `{`를 다음으로 교체:

```rust
    // status_temporal: 5xx that appears late. onset이 같은 현상을 더 구체적으로
    // 판정했다면 미발행(E2 억제 규칙, spec §5.4 R7).
    if onset.is_none() {
```

(블록 닫는 `}`는 그대로 두면 된다 — 들여쓰기만 `cargo fmt`가 정리한다.)

`Insight.onset_second`의 doc 주석(`:38-41`)이 `load_gen_saturated` 전용 서술이므로 두 kind 공용으로 갱신한다(리뷰 N6):

```rust
    /// 시점(run-relative seconds). 두 kind가 공용한다:
    /// `load_gen_saturated` = 포화 도달 시점(ramp run에서만 Some, spec R6),
    /// `midrun_error_onset` = 실패 급증 시작 시점(= s_t0 − s_1, 항상 Some).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_second: Option<i64>,
```

- [ ] **Step 7: `order_rank`를 재번호한다**

`crates/controller/src/insights.rs:80-93` 의 match 본문을 통째로 교체한다. 신규 2종을 최상단에 넣기 위해 기존 랭크를 +2 한다 — **상대 순서는 불변**이므로 기존 순서 단언 테스트는 그대로 통과해야 한다:

```rust
fn order_rank(i: &Insight) -> u8 {
    match (i.kind.as_str(), i.status_class.as_deref()) {
        // E2: 측정 유효성 문제가 최상단(이 run의 수치를 믿을 수 있는가),
        // 그 다음이 원인 후보를 든 시간 패턴.
        ("loadgen_port_exhaustion", _) => 1,
        ("midrun_error_onset", _) => 2,
        ("slo_failure", _) => 3,
        ("status_class", Some("5xx")) => 4,
        ("load_gen_saturated", _) => 5,
        ("no_request_step", _) => 6,
        ("error_hotspot", _) => 7,
        ("status_class", Some("4xx")) => 8,
        ("status_temporal", _) => 9,
        ("slowest_step", _) => 10,
        ("slo_pass", _) => 11,
        _ => 99,
    }
}
```

`:971`의 주석 `// order_rank 8 then 9`를 `// order_rank 10 then 11`로 고친다(주석-only).

- [ ] **Step 8: 전체 테스트를 돌린다 — 신규 green + 기존 4 fixture 무수정 통과**

Run: `cargo test -p handicap-controller --lib insights:: 2>&1 | tail -30`
Expected: 0 failed. 특히 **위 "spec의 사실 주장 1건" 표의 네 테스트**(`status_temporal_emits_when_5xx_is_late`, `no_status_temporal_when_5xx_early`, `no_status_temporal_single_second`, order fixture)가 **수정 없이** 통과해야 한다. 하나라도 깨지면 억제 게이트가 의도보다 넓게 걸린 것이니 `h` 계산을 재확인할 것.

- [ ] **Step 9: 이빨 실증 — 네 게이트를 하나씩 제거해 RED 확인**

각 게이트를 임시로 무력화하고 지정된 테스트가 **FAIL**하는지 확인한 뒤 **원복**한다. 하나라도 green으로 남으면 그 테스트는 공허하다.

| 무력화할 것 | RED가 나야 할 테스트 |
|---|---|
| `if tail < ONSET_MIN_TAIL_SECONDS { return None; }` 삭제 | `onset_not_emitted_for_tail_blip` |
| `if (bad_secs as f64) < 0.5 * tail as f64 { return None; }` 삭제 | `onset_requires_half_the_tail_to_be_bad` |
| `ONSET_CLEAN_MAX` 비교를 `<` → `<=` | `onset_clean_threshold_is_strictly_below_one_percent` |
| `ONSET_BAD_MIN` 비교를 `>=` → `>` | `onset_bad_threshold_is_at_least_ten_percent` |
| `if onset.is_none() {` → `if true {` | `onset_suppresses_status_temporal` |

**production diff는 최종 0**이어야 하므로 마지막에 `git diff crates/controller/src/insights.rs`로 다섯 원복을 모두 확인한다.

> **부동소수 경계 주의:** 위 두 임계 테스트는 `10/1000`·`100/1000`처럼 **나눗셈 결과가 리터럴 `0.01`/`0.10`과 같은 double로 정확히 반올림되는** 값을 골랐다(IEEE 나눗셈은 correctly-rounded라 `10.0/1000.0 == 0.01`이 성립). 만약 이 단언이 환경에 따라 흔들리면 **비교 연산자를 바꾸지 말고** fixture를 경계에서 한 칸 떨어뜨려라(예 `11/1000`) — 연산자를 바꾸면 spec 수식이 바뀐다.

- [ ] **Step 10: 워크스페이스 게이트**

Run: `cargo fmt --all && cargo build --workspace --tests 2>&1 | tail -5 && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -10 && cargo nextest run 2>&1 | tail -20`
Expected: 전부 0 failed / 0 warnings.

- [ ] **Step 11: 커밋**

```bash
git add crates/controller/src/insights.rs crates/controller/src/report.rs
git commit -m "feat(controller): midrun_error_onset·loadgen_port_exhaustion 인사이트 (E2 Task 2)"
```

---

### Task 3: UI — Zod · ko 카탈로그 · InsightPanel

**Files:**
- Modify: `ui/src/components/report/__tests__/InsightPanel.test.tsx`
- Modify: `ui/src/api/schemas.ts` (`InsightSchema` `:385-403`)
- Modify: `ui/src/i18n/ko.ts` (`insightLabels` `:1208-1217`, 새 `errorOnset` 네임스페이스)
- Modify: `ui/src/components/report/InsightPanel.tsx` (`message()` `:29-63`, `actionFor()` `:74-98`)

**Interfaces:**
- Consumes: Task 2가 정한 kind 문자열 `"midrun_error_onset"` / `"loadgen_port_exhaustion"` 과 필드 계약(`onset_second`·`count`·`status_class`·`error_kind`)
- Produces: 없음 (마지막 UI task)

**tdd-guard 주의:** `ui/src` 편집은 작업트리에 pending test 파일이 있어야 통과한다. **반드시 Step 1(테스트 파일 편집)을 먼저** 하고 src를 건드릴 것.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`ui/src/components/report/__tests__/InsightPanel.test.tsx`에 추가한다. 기존 파일의 render 헬퍼·import 관용구를 그대로 따르되, 없으면 아래 형태로.

**import 확인 먼저 — 추가가 아니라 *교체*다.** 현재 파일 상단은 이렇다:

```ts
import type { Insight } from "../../../api/schemas";   // :5
import { ko } from "../../../i18n/ko";                 // :6
```

`ko`는 이미 있으니 **건드리지 말 것**(중복 추가 시 TS2300). `InsightSchema`는 `.safeParse`를 **런타임에** 호출하므로 `import type`이면 안 된다 → **`:5` 줄을 다음으로 교체**한다(새 줄을 *추가*하면 `Insight`가 중복 선언되어 TS2300 — `pnpm test`는 esbuild라 통과하고 Step 8의 `pnpm build`에서만 터진다):

```ts
import { InsightSchema, type Insight } from "../../../api/schemas";
```

```tsx
  it("onset 인사이트를 렌더하고 조치문을 토글 off에서도 보여준다", () => {
    // computed:true 계약 — 새 브라우저 프로필(토글 기본 false)에서도 보여야 한다.
    window.localStorage.clear();
    render(
      <InsightPanel
        insights={[
          {
            kind: "midrun_error_onset",
            severity: "critical",
            onset_second: 20,
            count: 1500,
            status_class: "5xx",
            error_kind: "connection_reset",
          },
        ]}
        meta={new Map()}
      />,
    );
    const line = screen.getByTestId("insight");
    expect(line).toHaveTextContent("20");
    expect(line).toHaveTextContent("5xx 동반");
    expect(screen.getByText(ko.errorOnset.sutExhaustion)).toBeInTheDocument();
  });

  it("status_class가 없으면 '5xx 동반'을 붙이지 않는다", () => {
    window.localStorage.clear();
    const ins: Insight = {
      kind: "midrun_error_onset",
      severity: "critical",
      onset_second: 7,
      count: 30,
    };
    render(<InsightPanel insights={[ins]} meta={new Map()} />);
    expect(screen.getByTestId("insight")).not.toHaveTextContent("5xx 동반");
  });

  it("지배 kind에 따라 조치문이 갈린다", () => {
    window.localStorage.clear();
    // `severity`를 string으로 widening시키지 않도록 반드시 Insight로 annotate한다
    // (annotate 없으면 pnpm test는 통과하고 pnpm build의 tsc -b만 잡는다).
    const base: Insight = {
      kind: "midrun_error_onset",
      severity: "critical",
      onset_second: 5,
      count: 10,
    };
    const { rerender } = render(
      <InsightPanel insights={[{ ...base, error_kind: "connect_refused" }]} meta={new Map()} />,
    );
    expect(screen.getByText(ko.errorOnset.refused)).toBeInTheDocument();

    rerender(<InsightPanel insights={[base]} meta={new Map()} />);
    expect(screen.getByText(ko.errorOnset.generic)).toBeInTheDocument();
    expect(screen.queryByText(ko.errorOnset.refused)).not.toBeInTheDocument();
  });

  it("loadgen 포트 고갈은 대상 서버 문제가 아님을 명시한다", () => {
    window.localStorage.clear();
    render(
      <InsightPanel
        insights={[
          {
            kind: "loadgen_port_exhaustion",
            severity: "critical",
            count: 3,
            error_kind: "local_port_exhaustion",
          },
        ]}
        meta={new Map()}
      />,
    );
    expect(screen.getByText(ko.errorOnset.loadgen)).toBeInTheDocument();
  });

  it("error_kind가 없는 과거 리포트도 파싱·렌더된다", () => {
    // 서버 skip_serializing_if → 키 부재(null 아님). Zod .optional() 계약.
    expect(
      InsightSchema.safeParse({ kind: "midrun_error_onset", severity: "critical" }).success,
    ).toBe(true);
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e2/ui && pnpm test InsightPanel 2>&1 | tail -25`
Expected: FAIL — `ko.errorOnset` undefined.

- [ ] **Step 3: Zod에 `error_kind`를 더한다**

`ui/src/api/schemas.ts` — `InsightSchema`의 `runner_up_ms: z.number().optional(),`(`:402`) 뒤:

```ts
  // E2: onset 인사이트의 지배 transport kind. 서버가 skip_serializing_if(absent,
  // null 아님)라 레포 규약대로 .optional()(.nullish() 아님).
  error_kind: z.string().optional(),
```

- [ ] **Step 4: ko 카탈로그를 채운다**

`ui/src/i18n/ko.ts` — `insightLabels`(`:1208-1217`)의 `load_gen_saturated` 뒤에 2키:

```ts
    midrun_error_onset: "런 도중 실패 급증",
    loadgen_port_exhaustion: "부하 발생기 포트 고갈",
```

`saturation` 네임스페이스(계산된 조치문의 선례) **뒤**에 신규 네임스페이스를 추가한다:

```ts
  // E2 원인 후보 안내(ADR-0050). 전부 computed:true로 렌더되므로 조치문 토글과
  // 무관하게 보인다. **단정 금지** — 지배 kind는 SUT가 유도할 수 있는 입력이고
  // (h2 GOAWAY debug-data가 tls 오분류를 낼 수 있다, roadmap §B27), 용량 주장도
  // 하지 않는다(narrative cannot_claim: sut_capacity와의 공존 정책, spec §5.4).
  errorOnset: {
    sutExhaustion:
      "대상 서버(SUT) 쪽 소켓·자원 고갈 가능성이 있어요. 측정치(RPS·응답 시간)로 서버 용량을 판단하지 말고(유효성 안내 참고), 서버 상태를 점검하세요: TIME_WAIT와 소켓 재사용(SO_REUSEADDR·tcp_tw_reuse) 설정, 연결 대기열(backlog), 파일 디스크립터(FD) 한도.",
    refused:
      "대상 서버(SUT)가 연결을 거부했어요 — 서비스가 내려갔거나 포트·주소가 잘못됐을 가능성이 있어요. 대상 주소와 서버 프로세스 상태를 확인하세요.",
    generic:
      "실패가 런 도중부터 늘었어요 — 그 시점의 서버 로그와 자원 지표(CPU·메모리·연결 수)를 확인하세요.",
    loadgen:
      "부하 발생기 머신 자체의 문제예요 — 대상 서버(SUT) 문제가 아닙니다. 이 머신의 임시 포트 범위(ephemeral port range)와 소켓 재사용 설정을 확인하세요. 이 run의 측정치는 신뢰하기 어렵습니다.",
  },
```

`ko.report` 안에 본문 문구 2개를 추가한다(`slowestStep` 옆 — 매개변수 문구는 함수 상수 관용구):

```ts
    // E2 인사이트 본문. 숫자는 호출부에서 en-US toLocaleString으로 고정.
    midrunOnset: (sec: string, count: string, with5xx: boolean) =>
      `약 ${sec}초 지점까지는 정상이었는데, 그 뒤로 실패가 급증했어요` +
      `(${count}건${with5xx ? ", 5xx 동반" : ""})`,
    loadgenPortExhaustion: (count: string) =>
      `부하 발생기 머신의 포트가 부족했어요 (${count}건) — 이 run의 측정치가 오염됐을 수 있어요`,
```

**문구 충돌 점검(필수):** 새 문자열 6개 각각에 대해 기존 카탈로그와 **양방향** 포함관계를 확인한다 (thinkboard-defaults 함정 — `toHaveTextContent`/`getByText`가 부분문자열 매칭이라 포함관계가 있으면 단언이 엉뚱한 분기에서 통과한다):

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e2
python3 - <<'PY'
import re, pathlib
src = pathlib.Path("ui/src/i18n/ko.ts").read_text()
# 쌍따옴표 리터럴 + 백틱 템플릿 둘 다 스캔한다(ko.saturation.* 등은 템플릿이라
# 쌍따옴표만 보면 안 보인다 — 이 카탈로그의 절반이 그렇다).
vals = {m.group(1) for m in re.finditer(r'"((?:[^"\\]|\\.){4,})"', src)}
vals |= {m.group(1) for m in re.finditer(r'`((?:[^`\\]|\\.){4,})`', src, re.S)}
vals = sorted(vals)
new = [
    "런 도중 실패 급증",
    "부하 발생기 포트 고갈",
    "대상 서버(SUT) 쪽 소켓·자원 고갈 가능성이 있어요",
    "대상 서버(SUT)가 연결을 거부했어요",
    "실패가 런 도중부터 늘었어요",
    "부하 발생기 머신 자체의 문제예요",
]
hits = 0
for n in new:
    for v in vals:
        if v != n and (n in v or v in n):
            print("COLLISION:", repr(n), "<->", repr(v)); hits += 1
print(f"checked {len(new)} new strings against {len(vals)} catalog values — {hits} collisions")
PY
```

출력의 collisions가 0이 아니면 문구를 조정한다. (plan 작성 시점 실행 결과: 0.)

- [ ] **Step 5: `InsightPanel`을 배선한다**

`ui/src/components/report/InsightPanel.tsx` — `message()`의 `case "load_gen_saturated"` 뒤에:

```tsx
    case "midrun_error_onset":
      return ko.report.midrunOnset(
        String(i.onset_second ?? 0),
        n(i.count),
        i.status_class === "5xx",
      );
    case "loadgen_port_exhaustion":
      return ko.report.loadgenPortExhaustion(n(i.count));
```

`actionFor()` — `load_gen_saturated` 블록 뒤, `const genericAction = …` 앞에:

```tsx
  // E2: 두 kind 모두 run-특정 진단이라 computed:true — 조치문 토글(기본 off)과
  // 무관하게 렌더한다. 이게 없으면 새 브라우저 프로필에서 US2/US4가 실패한다.
  if (i.kind === "loadgen_port_exhaustion") {
    return { text: ko.errorOnset.loadgen, computed: true };
  }
  if (i.kind === "midrun_error_onset") {
    if (
      i.error_kind === "connection_reset" ||
      i.error_kind === "connect_timeout" ||
      i.error_kind === "timeout"
    ) {
      return { text: ko.errorOnset.sutExhaustion, computed: true };
    }
    if (i.error_kind === "connect_refused") {
      return { text: ko.errorOnset.refused, computed: true };
    }
    // 지배 kind 없음 / 과거 run(error_kinds 부재) → 일반 안내
    return { text: ko.errorOnset.generic, computed: true };
  }
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e2/ui && pnpm test InsightPanel 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: 이빨 실증 — `computed: true`를 뒤집어 RED 확인**

`loadgen`/`midrun` 분기의 `computed: true`를 `computed: false`로 임시 변경 → `pnpm test InsightPanel` → 조치문 단언 3건이 **FAIL**(토글 off라 미렌더) → 원복 → GREEN. `git diff ui/src/components/report/InsightPanel.tsx`로 원복 확인.

- [ ] **Step 8: UI 게이트 3종 (파이프 없이 종료코드 명시 캡처)**

```bash
cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e2/ui
pnpm lint;  echo "lint exit=$?"
pnpm test;  echo "test exit=$?"
pnpm build; echo "build exit=$?"
```
Expected: 세 exit 모두 0. **`| tail` 파이프 금지** — 종료코드를 마스킹한다. `pnpm test`는 인자 없이 전체 1회(targeted green ≠ full green).

- [ ] **Step 9: 커밋**

```bash
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(ui): onset·loadgen 인사이트 문구 + 원인 후보 조치문 (E2 Task 3)"
```

---

### Task 4: `e.without_url()` — reqwest 에러의 URL 노출 차단 (§B27 fold)

**Files:**
- Modify: `crates/engine/src/executor.rs` (`:296-298` 부하 경로, `:450-457` trace 경로)
- Test: `crates/engine/src/executor.rs` 인라인 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: 없음 (독립)
- Produces: 없음

**배경:** `reqwest::Error`의 최상위 `Display`는 `… for url (https://user:pass@host/?token=…)`를 렌더한다. 부하 경로(`:298`)는 현 소비자가 `is_some()` 불리언뿐이라 실질 무해하지만, **trace 경로(`:457`)는 `HttpTrace.error` → `StepTrace` → `TestRunPanel`로 실도달**해 `url: https://api/${TOKEN}/x` 류 시나리오가 transport 실패하면 resolved 시크릿이 화면에 뜬다(pre-existing, E1 무접촉). `reqwest::Error::without_url()`(0.12.28)이 정확히 이 용도다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`crates/engine/src/executor.rs`의 `mod tests` 안(`empty_env` 헬퍼 뒤)에 추가:

```rust
    /// bind 후 drop한 포트 — OS가 즉시 거절하므로 transport 실패가 결정적이다.
    fn dead_port_url() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}/secret-path")
    }

    fn step_at(url: &str) -> HttpStep {
        HttpStep {
            id: "01HX0000000000000000000042".into(),
            name: "redaction".into(),
            request: Request {
                method: HttpMethod::Get,
                url: url.to_string(),
                headers: BTreeMap::new(),
                body: None,
                disabled: DisabledRows::default(),
            },
            assert: vec![],
            extract: vec![],
            timeout_seconds: None,
            think_time: None,
        }
    }

    #[tokio::test]
    async fn send_error_string_never_carries_the_url() {
        // ADR-0050 / roadmap §B27: 최상위 reqwest Display는 URL(크레덴셜 포함
        // 가능)을 렌더한다. 두 경로 모두 without_url()로 벗겨야 한다.
        let url = dead_port_url();
        let vars = BTreeMap::new();
        let env = empty_env();
        let ctx = TemplateContext {
            vars: &vars,
            env: &env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        };
        let step = step_at(&url);
        let client = VuClient::new(crate::scenario::CookieJarMode::Off).unwrap();

        // ① 부하 경로 (executor.rs:298)
        let outcome = execute_step(&client, &step, &ctx).await.unwrap();
        let load_err = outcome.error.expect("transport 실패");
        assert!(
            !load_err.contains("secret-path") && !load_err.contains("127.0.0.1"),
            "부하 경로 에러 문자열에 URL이 남았다: {load_err}"
        );

        // ② trace 경로 (executor.rs:457) — HttpTrace.error는 TestRunPanel로 실도달한다.
        let trace = execute_step_traced(&client, &step, &ctx).await;
        let trace_err = trace.error.expect("transport 실패");
        assert!(
            !trace_err.contains("secret-path") && !trace_err.contains("127.0.0.1"),
            "trace 경로 에러 문자열에 URL이 남았다: {trace_err}"
        );
    }
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cargo test -p handicap-engine --lib executor::tests::send_error_string_never_carries_the_url 2>&1 | tail -20`
Expected: FAIL — panic 메시지에 `... for url (http://127.0.0.1:PORT/secret-path)`가 보인다. **이 실패가 곧 결함의 실증**이다.

- [ ] **Step 3: 두 사이트를 교체한다**

**부하 경로는 한 줄 치환이 아니다 — `Err` arm을 재구성해야 한다.** `reqwest::Error::without_url`은 `pub fn without_url(mut self) -> Self`로 **`e`를 소비**한다(reqwest 0.12.28 `src/error.rs:88`). struct 리터럴의 필드는 선언 순서대로 평가되므로, `error:`(`:298`)에서 `e`를 move한 뒤 `error_kind:`(`:299`)가 `&e`를 빌리면 **E0382**다. 분류를 **먼저** 바인딩해야 한다.

`crates/engine/src/executor.rs:288-301`의 `Err(e) => Ok(ExecOutcome { … })` arm 전체를 다음으로 교체한다:

```rust
        Err(e) => {
            // 분류를 먼저 바인딩한다 — `without_url()`이 `e`를 소비하므로
            // 리터럴 안에서 `&e`를 뒤에 쓰면 E0382(borrow after move)다.
            let error_kind = crate::error_kind::classify_send_error(&e);
            Ok(ExecOutcome {
                step_id: step.id.clone(),
                status: 0,
                latency,
                download: None,
                dns: None,
                connect: None,
                wait: None,
                // reqwest 최상위 Display는 URL(크레덴셜 포함 가능)을 렌더하므로
                // without_url()로 벗겨서 담는다(ADR-0050 / roadmap §B27).
                // 현재 소비자는 runner의 is_some() 불리언뿐이지만, 새 sink가
                // 붙어도 안전하도록 소스에서 차단한다.
                error: Some(e.without_url().to_string()),
                error_kind: Some(error_kind),
                extracted: BTreeMap::new(),
            })
        }
```

**분류 의미론은 불변이다** — `classify_send_error`가 `without_url()` **이전**의 `e`를 보므로 E1 거동과 100% 동일하다(그리고 그 함수는 `e.source()`부터 체인을 걸어 최상위 `Display`를 아예 쓰지 않는다).

`crates/engine/src/executor.rs:457`:

```rust
                // HttpTrace.error는 StepTrace → TestRunPanel로 실도달한다 —
                // resolved 시크릿이 든 URL이 화면에 뜨지 않도록 without_url().
                error: Some(build_error.unwrap_or_else(|| e.without_url().to_string())),
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `cargo test -p handicap-engine --lib executor::tests::send_error_string_never_carries_the_url 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: E1 분류가 회귀하지 않았는지 확인한다**

`classify_send_error`는 `e.source()`부터 체인을 걷고 최상위 `Display`/`{:?}`를 쓰지 않으므로 `without_url()`과 무관해야 한다. 기계로 확인:

Run: `cargo test -p handicap-engine 2>&1 | tail -20`
Expected: 0 failed — 특히 `tests/error_kind.rs`의 분류 통합 테스트 전부 green.

- [ ] **Step 6: 워크스페이스 게이트**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -10 && cargo nextest run 2>&1 | tail -20`
Expected: 0 warnings / 0 failed.

- [ ] **Step 7: 커밋**

```bash
git add crates/engine/src/executor.rs
git commit -m "fix(engine): reqwest 에러 문자열에서 URL 제거 (without_url, §B27 fold — E2 Task 4)"
```

---

## 최종 리뷰 · 라이브 검증 (구현 후, orchestrator 책임)

### 리뷰 게이트

1. **per-task 2단계 review** — task마다 `spec-compliance` → `code-quality` 둘 다 APPROVED. 모델 라우팅: 기본 `model: sonnet`, 단 **Task 2는 `model: opus`**(시계열 휴리스틱·경계 수식 — path-gate 대상), **Task 4도 `model: opus`**(engine/요청실행).
2. **최종 whole-branch 리뷰** — `handicap-reviewer` APPROVE. 리뷰 BASE는 첫 implementer 디스패치 직전 커밋(`HEAD~1` 금지).
3. **보안 게이트 — 필수 확정.** Task 4가 `crates/engine/src/executor.rs`(요청 실행)를 건드리므로 `finish-slice §0`의 grep이 반드시 매치한다 → `security-reviewer` APPROVE 필수. (E2가 controller+UI만이었다면 N/A였을 것 — fold 결정의 대가다.)

### 라이브 검증 (필수 — insights/report 경로를 건드림)

`/live-verify` 스택. **워커 재빌드 필수 아님**(엔진 모델 무변경) — 단 Task 4가 engine을 건드렸으므로 워크트리 자체 바이너리로 `cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로**로 실행할 것. 백엔드+UI 슬라이스이므로 `ui/dist` 빌드 필요(`just ui-build`).

| US | 절차 | 통과 신호 |
|---|---|---|
| **US2 (시간 패턴)** | t=20s부터 200 → 503으로 전환하는 responder, `duration_seconds: 60` closed-loop run | `midrun_error_onset` 발행 · `onset_second ≈ 20`(±수초) · 본문에 "5xx 동반" · 조치문 = **`ko.errorOnset.generic`**(아래 ⚠ 참조 — 503엔 SUT 점검 목록이 안 나오는 게 정답) · **토글 off 기본 상태에서 조치문이 보임**(`localStorage.clear()` 후 새로고침) · `status_temporal` **미발행** |
| **US2' (원인 후보)** | t=20s부터 커넥션을 RST로 끊는 responder(E1 라이브의 keep-alive-후-RST 변형 재사용), `duration_seconds: 60` | 분류표에 `connection_reset` 다수 · `midrun_error_onset` 발행 · 조치문 = **`ko.errorOnset.sutExhaustion`**(TIME_WAIT·backlog·FD 목록 포함) |
| **US4** | 라이브 유발 제외(머신 포트 고갈 위험) — Task 2의 `loadgen_port_exhaustion_emits_on_single_occurrence` 단위 테스트로 갈음, 근거를 build-log에 기록 | 단위 테스트 green |
| **하한 회귀** | 60s 정상 run 중 **마지막 1~2초만** 실패하게 만든 run | `midrun_error_onset` **미발행**(하한 conjunct 실동작 확인) · `status_temporal`은 정상 발행 |
| **회귀** | 에러 0 정상 run | 신규 인사이트 2종 부재 · `error_kind` 키 부재 · 기존 인사이트(`slowest_step` 등) 불변 |
| **export** | **US2' run**(kinds가 실제로 있는 쪽)의 `GET /api/runs/{id}/report-insights.csv` | 헤더 17열 · 마지막 열 `error_kind` · onset 행의 `error_kind` = `connection_reset` |

> **⚠ 두 responder는 서로 다른 것을 증명한다 — 섞지 말 것.** 503은 `req.send()`가 **`Ok(resp)`로 성공**하는 경로라 `classify_send_error`가 아예 안 불린다 → 그 run의 `error_kinds`는 **빈 배열** → `dominant_error_kind → None` → 조치문은 `ko.errorOnset.generic`이고 SUT 점검 목록은 **없는 게 정상**이다. TIME_WAIT·backlog·FD 목록과 `connection_reset` export 값을 보려면 **transport를 실제로 끊는** US2' responder가 필요하다. (spec §10의 US2 행이 이 둘을 한 행에 섞어 놨다 — 여기서 정정한다. 이걸 모르고 US2에서 SUT 목록을 찾으면 멀쩡한 구현을 FAIL로 오판한다.)

라이브 run 생성 시 주의: `POST /api/runs`는 `{"scenario_id":…,"profile":{"vus":N,"duration_seconds":60},"env":{}}`. 리포트 조회는 `GET /api/runs/{id}/report`, run-detail UI 라우트는 `/runs/{id}`.

### 디스패치 노트 (orchestrator)

- 모든 subagent prompt **첫 줄**에 `cd /Users/sgj/develop/handicap/.claude/worktrees/error-taxonomy-e2` 절대경로 명시.
- 매 brief에 spec의 `사용자 스토리 (US)` 블록(spec 파일 `:5-12`, 헤딩부터 다음 동레벨 헤딩 전까지)을 1회 추출해 첨부(ADR-0048 US 스파인).
- **Task 3은 `ui/src`를 건드리므로** brief에 "Step 1(테스트 파일 편집)을 반드시 먼저" 를 명시(tdd-guard).
- implementer의 commit·검증은 **단일 FOREGROUND 호출**(timeout 600000ms) — background+poll 금지.
- 리포트 경로는 `.superpowers/sdd/` 지정, 워크트리 루트에 `.md` 쓰기·`git add` 금지를 못박을 것.
- 이 plan의 "spec의 사실 주장 1건 — 기각" 표는 **내가 기계로 확인한 것이 아니라 fixture를 읽고 계산한 것**이다. Task 2 Step 8이 네 테스트를 실제로 돌려 확인하므로 그 출력이 최종 권위다.

REVIEW-GATE: APPROVED
