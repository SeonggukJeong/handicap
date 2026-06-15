# 용량 포화 원인 귀속 + 지속 최대 RPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `load_gen_saturated` 인사이트의 `cause=capacity`를 best-available 신호(5xx + 지연상승)로 `loadgen`/`sut`로 자동 귀속하고, `recommended_workers`를 `loadgen`에만 emit(SUT-bound 오권장 제거)하며, 천장(`value`)을 "지속 가능한 최대 RPS"로 framing + ramp run에 `onset_second`(포화 도달 시점)를 표면화한다.

**Architecture:** 전부 읽기경로(read-path). 모든 신호가 기존 `derive_insights` 인자(`windows`/`status_distribution`/`summary.mean_ms`) 안에 있어 **신규 인자·엔진·proto·migration·`build_report` 시그니처 변경 0**. Task 1 = `insights.rs` 로직 + Rust 와이어(`Insight.onset_second`) + 단위 테스트(1 green 커밋). Task 2 = UI Zod + `InsightPanel` 렌더 + `ko.ts` 문구 + RTL(1 green 커밋). `dropped==0`이면 byte-identical.

**Tech Stack:** Rust(controller `insights.rs`), TypeScript/React(`InsightPanel.tsx`/`schemas.ts`/`ko.ts`), vitest/RTL.

**Spec:** `docs/superpowers/specs/2026-06-15-capacity-cause-attribution-design.md` (R-id 척추 — 각 task가 R 인용).

---

## File Structure

- **Modify** `crates/controller/src/insights.rs` — `Insight.onset_second` 필드 + `cause` doc 주석 + 신규 private `sut_stress`/`latency_rose`/`saturation_onset`/`median` 헬퍼 + `load_gen_saturated` arm 재배선 + 단위 테스트(신규 + 기존 4개 마이그레이션). (Task 1)
- **Modify** `ui/src/api/schemas.ts` — `InsightSchema`에 `onset_second` 추가. (Task 2)
- **Modify** `ui/src/components/report/InsightPanel.tsx` — `actionFor`(slots/loadgen/sut/None) + `message()`(천장 framing + onset 절). (Task 2)
- **Modify** `ui/src/i18n/ko.ts` — `saturation`의 `capacity`/`capacityWithWorkers` → `loadgen`/`loadgenWithWorkers`/`sut`. (Task 2)
- **Modify** `ui/src/components/report/__tests__/InsightPanel.test.tsx` — capacity RTL 2개 → loadgen/sut + 신규 sut/onset 테스트. (Task 2)
- **Modify** `crates/controller/src/export.rs` — **테스트 리터럴 2곳(`:512`/`:529`)에 `onset_second: None,`만** 추가(exhaustive struct 컴파일 픽스). writer·XLSX 시트·로직 무변경. (Task 1)
- **무변경(명시)**: `report.rs`(프로덕션·테스트 — `:1739`/`:1770`은 `"slots"`), `export.rs` **writer/로직/XLSX 시트**(리터럴 2줄만 fold), 엔진/워커/proto/migration. (spec R9)

---

## Task 1: 백엔드 — `insights.rs` 원인 귀속 + onset (1 green 커밋)

> **충족 R**: R1, R2, R3, R4(회귀), R5(Rust측), R6, R10(회귀), F3. **커밋 fold 이유**: 헬퍼만 추가 = clippy `dead_code`, 테스트만 = test 게이트 RED → 헬퍼+배선+테스트를 **한 green 커밋**으로(spec §8). report.rs는 손대지 않고, **export.rs는 테스트 리터럴 2줄(`onset_second: None`)만** fold(writer/로직/XLSX 시트 무변경 — Step 1, exhaustive struct 컴파일 픽스).

**Files:**
- Modify: `crates/controller/src/insights.rs`

- [ ] **Step 1: `Insight` 구조체에 `onset_second` 필드 + doc 주석 갱신**

`insights.rs`의 `Insight` 구조체 끝(현재 `recommended_workers` 필드 뒤)에 추가:

```rust
    /// 포화 도달 시점(run-relative seconds). ramp run에서만 Some(= t_peak − min_ts).
    /// flat/고정-레이트·windows 부재면 None. spec R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_second: Option<i64>,
```

같은 파일 `cause` 필드의 doc 주석(`/// 사이징 원인: "slots"(...) | "capacity"(CPU/SUT 한계). None = 판별 불가.`)을 다음으로 교체(F3):

```rust
    /// 사이징/포화 원인: "slots"(max_in_flight 부족) | "loadgen"(부하기 워커 한계,
    /// worker_count 권장) | "sut"(대상 서버 한계, 워커 증설 무익). None = 판별 불가.
```

`Insight::new`의 필드 초기화 블록 끝(`recommended_workers: None,` 뒤, `insights.rs:53`)에 `onset_second: None,` 추가.

**그리고 `export.rs`의 두 exhaustive `Insight {…}` 테스트 리터럴도 고쳐야 한다** (prost-exhaustive 트랩 — 새 필드 = `missing field` 컴파일 에러, 같은 crate라 게이트가 잡는다). `crates/controller/src/export.rs:512`와 `:529`의 `crate::insights::Insight { … recommended_workers: …, }` 두 리터럴 각각에 `onset_second: None,`을 추가(`recommended_workers` 줄 뒤). **이게 유일한 export.rs 변경 — writer/로직·XLSX 시트는 무변경**(`onset_second`는 XLSX에 미노출). `grep -rn "Insight {" crates/`로 다른 리터럴 사이트가 없음을 확인(현재 이 둘 + `Insight::new`뿐).

- [ ] **Step 2: 헬퍼 4종 추가 (`median`/`latency_rose`/`sut_stress`/`saturation_onset`)**

`derive_insights` 함수 **아래**(같은 파일, `collect_unconditional` 근처)에 private 헬퍼 + const 추가:

```rust
/// SUT-stress 휴리스틱 임계값 (spec §4.1, named const).
const TAU_5XX: f64 = 0.01; // 5xx률 1% 이상이면 SUT-bound
const TAU_LAT: f64 = 1.5; // late p95 중앙값이 early의 1.5배 이상이면 SUT-bound
const TAU_SPAN: i64 = 6; // 지연상승은 run span >= 6초일 때만 평가

/// 정렬 후 중앙값(짝수 길이는 두 중앙값 평균). 빈 슬라이스는 0.0.
fn median(vals: &[u64]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut v = vals.to_vec();
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2] as f64
    } else {
        (v[n / 2 - 1] + v[n / 2]) as f64 / 2.0
    }
}

/// 지연상승 신호(spec R2): distinct 초 L개에서 k=⌊L/3⌋초씩 early/late third로 나눠
/// "초별 최악-스텝 p95"의 중앙값을 비교. late ≥ TAU_LAT × early면 true.
/// k<1 또는 span<TAU_SPAN이면 false(짧은 run은 추세 판단 불가).
fn latency_rose(windows: &[ReportWindow]) -> bool {
    let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
    for w in windows {
        let e = by_sec.entry(w.ts_second).or_insert(0);
        *e = (*e).max(w.p95_ms);
    }
    let secs: Vec<i64> = by_sec.keys().copied().collect();
    let l = secs.len();
    let k = l / 3;
    if k < 1 || secs[l - 1] - secs[0] < TAU_SPAN {
        return false;
    }
    let early: Vec<u64> = secs[..k].iter().map(|s| by_sec[s]).collect();
    let late: Vec<u64> = secs[l - k..].iter().map(|s| by_sec[s]).collect();
    let em = median(&early);
    em > 0.0 && median(&late) >= TAU_LAT * em
}

/// SUT-stress(spec R2): 5xx률 ≥ TAU_5XX(ground-truth) OR 지연상승(약한 신호).
/// **슬롯 충분 arm 안에서만 호출**(폴백 None보다 뒤, spec CC2).
fn sut_stress(dist: &BTreeMap<String, u64>, windows: &[ReportWindow]) -> bool {
    let total = crate::report::http_response_total(dist);
    if total > 0 {
        let c5 = crate::report::status_class_count(dist, '5');
        if (c5 as f64) / (total as f64) >= TAU_5XX {
            return true;
        }
    }
    latency_rose(windows)
}

/// 포화 도달 시점(spec R6): ramp run에서만 Some(t_peak − min_ts).
/// ramp 판정 = early-third(앞 ⌊L/3⌋초) 처리량 중앙값 < 0.5×peak(단일 warmup-dip 무시).
/// L<3 또는 peak==0(windows 부재)면 None. flat이면 None.
fn saturation_onset(by_sec: &BTreeMap<i64, u64>, peak: u64) -> Option<i64> {
    let secs: Vec<i64> = by_sec.keys().copied().collect();
    let l = secs.len();
    let k = l / 3;
    if l < 3 || peak == 0 || k < 1 {
        return None;
    }
    let early: Vec<u64> = secs[..k].iter().map(|s| by_sec[s]).collect();
    if median(&early) >= 0.5 * peak as f64 {
        return None; // flat → onset 무의미
    }
    let t_peak = *secs.iter().find(|s| by_sec[s] == peak)?;
    Some(t_peak - secs[0])
}
```

- [ ] **Step 3: `load_gen_saturated` arm 재배선 (capacity → loadgen/sut + onset)**

`insights.rs`의 `if dropped > 0 { ... }` 블록에서:

(a) `ins.count = Some(dropped);` 바로 **다음 줄**에 onset 설정 추가:

```rust
        ins.onset_second = saturation_onset(&by_sec, peak);
```

(b) `match (required, max_in_flight)`의 **두 번째 arm**(현재 `(Some(_), Some(_)) => { ins.cause = Some("capacity".to_string()); ... }`) 전체를 다음으로 교체(slots arm·`_` 폴백 arm은 **무변경**):

```rust
            (Some(_), Some(_)) => {
                // 슬롯은 충분했는데 포화 → 부하기(워커) vs 대상 서버(SUT) 귀속(spec R2).
                if sut_stress(status_distribution, windows) {
                    // 대상 서버 한계로 보임 → 워커 증설 무익 → recommended_workers 미설정.
                    ins.cause = Some("sut".to_string());
                } else {
                    // 부하기(워커) 한계로 보임 → worker_count 권장(기존 수식 verbatim, parity).
                    ins.cause = Some("loadgen".to_string());
                    let wc = worker_count_current.max(1);
                    if peak > 0 {
                        if let Some(t) = target_rps {
                            let per_worker = peak as f64 / wc as f64;
                            let m = ((t as f64) / per_worker).ceil();
                            if m > wc as f64 {
                                ins.recommended_workers = Some(m);
                            }
                        }
                    }
                }
            }
```

> **CC1 주의**: loadgen 블록의 `per_worker`/`m`/`> wc`는 기존 `capacity` arm에서 **그대로 옮긴 것** — `ceil(target×wc/peak)`로 다시 쓰지 말 것(float 결합순 ±1 드리프트로 `WorkerSizingHelper` parity·아래 `saturated_loadgen_recommends_more_workers`의 `Some(3.0)`가 깨진다).

- [ ] **Step 4: 기존 4개 `capacity` 단위 테스트 마이그레이션 (→ loadgen)**

`insights.rs` `#[cfg(test)] mod tests`에서 아래 4개를 수정. 모두 5xx·지연상승 신호가 없어 `loadgen`으로 라우팅된다:

1. `saturated_capacity_when_slots_sufficient` → 함수명 `saturated_loadgen_when_slots_sufficient`로, 단언 교체:
   ```rust
   assert_eq!(ins.cause.as_deref(), Some("loadgen"));
   assert_eq!(ins.recommended, None);
   assert_eq!(ins.recommended_workers, None); // peak=0(rps fallback) 가드
   ```
2. `saturated_capacity_recommends_more_workers` → 함수명 `saturated_loadgen_recommends_more_workers`로, `Some("capacity")` → `Some("loadgen")`(`recommended_workers == Some(3.0)` 줄은 그대로).
3. `saturated_peak_zero_omits_worker_rec` → `Some("capacity")` → `Some("loadgen")`(나머지 그대로, `recommended_workers == None`).
4. `saturated_m_le_current_omits_worker_rec` → `Some("capacity")` → `Some("loadgen")`(나머지 그대로, `recommended_workers == None`).

- [ ] **Step 5: 신규 단위 테스트 추가 (R1·R2·R6)**

`mod tests` 끝에 테스트 헬퍼 + 6개 테스트 추가. (먼저 `win_p95` 헬퍼 — 기존 `win_count`/`win` 옆에):

```rust
    fn win_p95(ts: i64, p95: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "a".to_string(),
            count: 1,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: p95,
            p99_ms: p95,
        }
    }

    #[test]
    fn saturated_sut_via_5xx() {
        // 슬롯 충분(required=ceil(1000*0.05)=50 ≤ 2000) + 5xx 10% → sut, worker rec 없음.
        let mut s = summary();
        s.mean_ms = 50;
        let dist = dist(&[("200", 900), ("500", 100)]);
        let got = derive_insights(&s, &[], &[], &dist, None, "", 7, Some(2000), Some(1000), 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn saturated_sut_via_latency_rise() {
        // 5xx 없음 + p95가 early 10 → late 100 (1.5배↑, span 8≥6) → sut, worker rec 없음.
        let mut s = summary();
        s.mean_ms = 50;
        let mut windows = vec![];
        for ts in 0..9 {
            windows.push(win_p95(ts, if ts >= 6 { 100 } else { 10 }));
        }
        let got =
            derive_insights(&s, &[], &windows, &BTreeMap::new(), None, "", 7, Some(2000), Some(1000), 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn onset_present_on_ramp() {
        // 처리량 10→90 증가(ramp). peak=90, early-third median 20 < 45 → ramp.
        // t_peak = ts8, min_ts=0 → onset 8.
        let mut windows = vec![];
        for ts in 0..9i64 {
            windows.push(win_count(ts, "a", ((ts + 1) * 10) as u64));
        }
        let got =
            derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "", 5, None, None, 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, Some(8));
    }

    #[test]
    fn onset_omitted_on_flat() {
        // 전 구간 처리량 100(flat) → early median 100 ≥ 50 → onset None.
        let mut windows = vec![];
        for ts in 0..9i64 {
            windows.push(win_count(ts, "a", 100));
        }
        let got =
            derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "", 5, None, None, 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, None);
    }

    #[test]
    fn onset_omitted_on_warmup_dip() {
        // L=9, 첫 초만 10·나머지 100. early-third(ts0,1,2)=[10,100,100] median 100 ≥ 50
        // → not ramp → None. (L<9면 early-third가 dip만 잡혀 오판 — fixture L≥9 필수.)
        let mut windows = vec![win_count(0, "a", 10)];
        for ts in 1..9i64 {
            windows.push(win_count(ts, "a", 100));
        }
        let got =
            derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "", 5, None, None, 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, None);
    }

    #[test]
    fn sut_stress_only_inside_slots_sufficient_arm() {
        // mean=0(폴백 arm)이면 5xx가 있어도 cause None — sut_stress는 슬롯충분 arm 밖에서 미평가(CC2).
        let s = summary(); // mean_ms = 0 → required None → 폴백
        let dist = dist(&[("500", 1000)]);
        let got = derive_insights(&s, &[], &[], &dist, None, "", 7, Some(100), Some(1000), 1);
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
    }
```

- [ ] **Step 6: RED 확인 → GREEN 확인 (로컬, 커밋 전)**

먼저 워커 워밍(cold-build flake 회피) 후 controller 테스트:

```
cargo build -p handicap-worker && cargo build -p handicap-controller --tests
cargo nextest run -p handicap-controller insights 2>&1 | tail -30
```
Expected: 신규/마이그레이션 테스트 포함 전부 PASS. (헬퍼+배선+테스트를 한꺼번에 작성했으므로 개별 RED 단계는 로컬에서 함수 stub 시점에 확인 — 최종은 GREEN.)

- [ ] **Step 7: clippy + commit (단일 FOREGROUND 호출, 폴링 금지)**

```
cargo clippy -p handicap-controller --all-targets -- -D warnings 2>&1 | tail -15
git add crates/controller/src/insights.rs crates/controller/src/export.rs
git commit -m "feat(insights): load_gen_saturated cause를 loadgen/sut로 귀속 + onset_second

slots 충분한데도 포화한 open-loop run을 5xx률(≥1%)·지연상승(late/early p95
≥1.5배)로 부하기(워커) vs 대상 서버(SUT)로 자동 귀속. recommended_workers는
loadgen에만 emit(SUT-bound 오권장 제거). ramp run엔 onset_second(포화 도달 초)
표면화. 전부 읽기경로 — derive_insights 신규 인자·엔진·proto·migration 0.

spec docs/superpowers/specs/2026-06-15-capacity-cause-attribution-design.md
충족 R1·R2·R3·R4·R5(Rust)·R6·R10·F3

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```
Expected: clippy 0 warnings, 커밋 landed(`git log -1`로 확인). pre-commit이 전체 워크스페이스 게이트(수 분) 실행.

---

## Task 2: UI — Zod + `InsightPanel` 렌더 + `ko.ts` (1 green 커밋)

> **충족 R**: R5(UI Zod측), R8. wire seam(R5) — `onset_second`는 Rust `skip_serializing_if`라 absent → Zod `.optional()`(`.nullish()` 아님, ui/CLAUDE.md). `cause` 값 변경은 string이라 무파장.

**Files:**
- Modify: `ui/src/api/schemas.ts`
- Modify: `ui/src/i18n/ko.ts`
- Modify: `ui/src/components/report/InsightPanel.tsx`
- Test: `ui/src/components/report/__tests__/InsightPanel.test.tsx`

- [ ] **Step 1: `InsightSchema`에 `onset_second` 추가**

`ui/src/api/schemas.ts`의 `InsightSchema`에서 `recommended_workers: z.number().optional(),` 다음 줄에 추가:

```ts
  onset_second: z.number().int().optional(),
```

- [ ] **Step 2: `ko.ts` `saturation` 문구 교체 (capacity → loadgen/sut)**

`ui/src/i18n/ko.ts`의 `saturation: { ... }` 블록 전체를 교체(`slots`는 유지, `capacity`/`capacityWithWorkers` 제거, `loadgen`/`loadgenWithWorkers`/`sut` 추가):

```ts
  // 사이징 권장(load_gen_saturated cause 분기). 조사 병기((으)로 등, ADR-0035).
  saturation: {
    slots: (rec: string) =>
      `동시 실행 수(max_in_flight)가 목표에 비해 작아요 — 최소 ~${rec}(으)로 올려 다시 실행하세요. ` +
      `(에러·지연이 함께 높으면 대상 서버가 한계라 슬롯만 늘려선 처리량이 안 늘 수 있어요.)`,
    loadgen:
      `동시 실행 수(max_in_flight)는 충분했어요 — 부하 생성기(워커)가 한계로 보여요. ` +
      `worker_count를 늘리면 더 높은 RPS를 낼 수 있어요. ` +
      `(단 에러·지연이 함께 높아지면 대상 서버 한계일 수 있어요.)`,
    loadgenWithWorkers: (m: number) =>
      `동시 실행 수(max_in_flight)는 충분했어요 — 부하 생성기(워커)가 한계로 보여요. ` +
      `worker_count를 ~${m}개로 올려 다시 실행하세요. ` +
      `(단 에러·지연이 함께 높아지면 대상 서버 한계라 워커를 늘려도 무익할 수 있어요.)`,
    sut:
      `동시 실행 수(max_in_flight)는 충분했어요 — 대상 서버(SUT)가 한계로 보여요(에러·지연 상승). ` +
      `워커·슬롯을 늘려도 지속 RPS는 안 올라요. 서버 용량·설정을 점검하세요.`,
  },
```

- [ ] **Step 3: `InsightPanel.tsx` `actionFor` + `message()` 갱신**

`actionFor`의 `load_gen_saturated` 분기를 교체(`"capacity"` 분기 제거):

```tsx
  if (i.kind === "load_gen_saturated") {
    if (i.cause === "slots") return ko.saturation.slots(n(i.recommended));
    if (i.cause === "loadgen") {
      return i.recommended_workers != null
        ? ko.saturation.loadgenWithWorkers(Math.round(i.recommended_workers))
        : ko.saturation.loadgen;
    }
    if (i.cause === "sut") return ko.saturation.sut;
    return ko.insightActions.load_gen_saturated; // 폴백(A9 일반, cause None)
  }
```

`message()`의 `load_gen_saturated` case를 교체(천장 framing + onset 절; "초당 최대 N건" 부분문자열은 유지해 기존 헤드라인 테스트 보존):

```tsx
    case "load_gen_saturated": {
      const head =
        `목표한 부하를 다 걸지 못했어요 — 초당 최대 ${n(i.value)}건까지만 보냈어요` +
        `(= 이 구성의 지속 가능한 최대 RPS). 보내려다 못 보낸 요청이 ${n(i.count)}건 있어요`;
      return i.onset_second != null ? `${head} (약 ${i.onset_second}초 지점부터 포화)` : head;
    }
```

- [ ] **Step 4: RTL 테스트 마이그레이션 + 신규 (capacity 2개 → loadgen/sut + onset)**

`InsightPanel.test.tsx`에서:

(a) `"load_gen_saturated capacity — 올려도 안 늘어요 행동 줄 (worker 추천 없음)"` 테스트(현재 `cause: "capacity"`)를 교체:

```tsx
  it("load_gen_saturated loadgen — worker_count 늘리라는 행동 줄 (추천 수 없음)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 9000, count: 12, cause: "loadgen" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/worker_count를 늘리면 더 높은 RPS/)).toBeInTheDocument();
  });
```

(b) `"load_gen_saturated capacity — recommended_workers면 worker_count 추천 행동 줄"` 테스트의 `cause: "capacity"` → `cause: "loadgen"`(나머지 그대로, `/worker_count를 ~3개로/` 단언 유지). 제목도 `capacity` → `loadgen`.

(c) 신규 sut + onset 테스트 추가:

```tsx
  it("load_gen_saturated sut — 대상 서버 한계 행동 줄 (worker 추천 없음)", () => {
    const insights: Insight[] = [
      { kind: "load_gen_saturated", severity: "warning", value: 800, count: 90, cause: "sut" },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/대상 서버\(SUT\)가 한계로 보여요/)).toBeInTheDocument();
    expect(screen.getByText(/지속 RPS는 안 올라요/)).toBeInTheDocument();
    expect(screen.queryByText(/worker_count를/)).toBeNull();
  });

  it("load_gen_saturated onset_second면 포화 시점 절을 헤드라인에 렌더", () => {
    const insights: Insight[] = [
      {
        kind: "load_gen_saturated",
        severity: "warning",
        value: 7500,
        count: 320,
        cause: "loadgen",
        onset_second: 12,
      },
    ];
    render(<InsightPanel insights={insights} meta={meta} />);
    expect(screen.getByText(/약 12초 지점부터 포화/)).toBeInTheDocument();
  });
```

> **유지(무변경)**: `"load_gen_saturated 헤드라인과 다음 행동을 렌더한다"`(cause 없음 → None 폴백 → `/대상 서버의 한계, 아니면 테스트 도구/`, 헤드라인 `/초당 최대 7,500건.*못 보낸 요청이 320건/`)와 `"load_gen_saturated slots ..."`는 그대로 GREEN.

- [ ] **Step 5: lint + test + build (UI 게이트)**

```
cd /Users/sgj/develop/handicap/.claude/worktrees/a9-capacity-insights/ui
pnpm lint 2>&1 | tail -10
pnpm test InsightPanel 2>&1 | tail -20
pnpm build 2>&1 | tail -15
```
Expected: lint 0 warnings, InsightPanel 테스트 전부 PASS, `tsc -b` + vite build 성공. (`pnpm test`는 단일 파일 필터 — `--` 붙이지 말 것, ui/CLAUDE.md.)

- [ ] **Step 6: 전체 UI 테스트 + commit**

```
cd /Users/sgj/develop/handicap/.claude/worktrees/a9-capacity-insights/ui && pnpm test 2>&1 | tail -15
cd /Users/sgj/develop/handicap/.claude/worktrees/a9-capacity-insights
git add ui/src/api/schemas.ts ui/src/i18n/ko.ts ui/src/components/report/InsightPanel.tsx ui/src/components/report/__tests__/InsightPanel.test.tsx
git commit -m "feat(ui): load_gen_saturated loadgen/sut 행동 줄 + onset 시점 렌더

InsightPanel actionFor가 cause loadgen(worker_count 권장)·sut(서버 한계, 워커
무익)·slots(기존)·None(폴백)을 분기. message()는 천장 framing + onset_second 절.
InsightSchema에 onset_second.optional() 추가(skip_serializing_if라 absent).

spec 충족 R5(UI)·R8

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git log -1 --oneline
```
Expected: 전체 스위트 GREEN(다른 파일 회귀 없음, ui/CLAUDE.md "targeted green ≠ full green"), 커밋 landed.

---

## Task 3: 최종 리뷰 + 라이브 검증 (커밋 아님 — 슬라이스 파이프라인 4·5단계)

> 구현 task 아님. spec §6/§8.

- [ ] **Step 1: `handicap-reviewer` 최종 리뷰**

`handicap-reviewer` 에이전트로 전체 diff 리뷰(wire 1:1: `Insight` serde ↔ UI Zod, cause 값집합·onset 필드; deferral; byte-identical when dropped==0). APPROVE까지.

- [ ] **Step 2: `/live-verify` 라이브 검증 (report-parse 경로 변경 — 필수)**

`/live-verify` 스택(워크트리 자체 바이너리 + latency-configurable responder + 격리 DB):
- **sut 재현**: 부하 중 5xx를 내는(또는 지연 상승) responder + 슬롯 충분(`max_in_flight` 크게) open-loop 포화 run → 리포트 인사이트 `cause=sut`, worker rec 없음, 실브라우저 "대상 서버(SUT)가 한계" 행동 줄.
- **loadgen**: 결정론 재현이 어려우면(컨트롤러 CLAUDE.md capacity 재현난) unit 락인으로 갈음 — 라이브는 sut + 파싱만 강제.
- **파싱(S-D 갭)**: 실 `/report` JSON 바이트를 `ReportSchema.safeParse`(`onset_second` 필드 + 새 cause 값 통과 확인). 콘솔 Zod 0.

- [ ] **Step 3: `/finish-slice`** — build-log·roadmap·CLAUDE 상태줄·메모리 기록 → ff-merge → `ExitWorktree`.

---

## 무변경 / 불변식 (spec §5 재확인)

- 엔진·워커·proto·migration·`build_report` 시그니처 무변경(신규 인자 0).
- `report.rs` **프로덕션·테스트 무변경** — `cause=="slots"`만 단언(F2). `export.rs`는 **테스트 리터럴 2줄(`:512`/`:529`)에 `onset_second: None`만** fold(exhaustive struct 컴파일 픽스), writer/로직/XLSX 시트 무변경.
- `dropped==0` → `load_gen_saturated` 미emit → 리포트 byte-identical(R7).
- `slots` cause(R4)·폴백 None(R10) 동작 무변경. `value`/`count`/`recommended` 수식 무변경.
- CSV·비교 export 무변경. XLSX `cause` 열은 writer passthrough로 새 문자열 자동 반영, `onset_second` 열 미추가.

<!-- REVIEW-GATE: APPROVED -->
