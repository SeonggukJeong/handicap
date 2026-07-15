# graceful ramp-down 상한 (§B9 QoL) — 은퇴 VU lingering 시간 캡

> 출처: `docs/roadmap.md §B9`("graceful grace 상한 — k6 gracefulRampDown류: retire 후 iteration 완료를 기다리는 최대 시간 초과 시 강제 중단, v1은 무상한"). 사용자 선택(2026-07-16 §B9 QoL 3후보 중).
> ADR 불필요 — ADR-0037(closed-loop VU 곡선·park-gate·`vu_stages`·`ramp_down`)의 그 spec §9 연기 항목 구현이라 결정 범위 내(§11 근거).

## 1. 문제 (§B9 배경)

closed-loop VU 곡선(ADR-0037)의 **graceful ramp-down**(기본값)은 stage가 desired VU 수를 낮출 때 은퇴 대상 VU의 activation 토큰을 취소하지 **않는다** — 그건 `immediate` 모드만 한다(`runner.rs:861` `if immediate { ... cancel ... }`). graceful VU는 iteration/스텝 경계의 `desired <= index` 게이트에서만 park하는데, **현재 in-flight iteration은 끝까지 실행된다**(`execute_steps`가 graceful에선 취소 안 된 `act`를 받아 모든 스텝을 완주). 그래서 iteration이 긴 시나리오(스텝 다수·큰 think time·느린 SUT)에선 t=60s에 은퇴 요청된 VU가 iteration이 끝날 때까지 — 최악은 run deadline까지 — active로 남아 `actual` VU 수를 `desired` 위로 끌고 간다. **retire 요청 대비 무상한 lingering**이고, active-VU 시계열에서 감축 곡선을 actual이 overshoot하는 형태로 나타난다.

**해결:** retire 요청 후 최대 lingering 시간(=상한)을 opt-in으로 둔다. 초과하면 supervisor가 그 VU의 토큰을 취소(immediate 모드와 동일 경로) → 다음 스텝 경계에서 park(진행 중 HTTP 1건은 마저 끝남, mid-request 소켓 중단은 비목표 — `runner.rs:37` 불변식).

## 2. User journey

QA가 soak/spike 곡선(예: 50 VU 유지 → 0으로 감축)을 돌린다. 시나리오 iteration이 길어(로그인+장바구니+결제, think time 포함 ~40s) 감축 구간에서 active-VU actual이 desired를 한참 웃돈다(감축이 늘어짐). QA가 RunDialog(상세 모드·닫힌 루프·곡선·graceful)에서 "느슨한 감축 상한"에 `10`(초)을 넣고 재실행 → 은퇴 VU가 최대 10초만 현재 iteration을 마저 돌고 중단, actual이 desired로 빠르게 수렴. 비우면(기존) 무제한.

## 3. 설계 원칙

1. **Opt-in·byte-identical (사용자 결정 2026-07-16).** 새 노브를 비우면 `None`=무상한=현재 거동. proto 부재·profile_json skip-when-none·UI 조건부 spread 모두 기존 run과 byte-identical. 이 코드베이스의 모든 페이싱 노브(think toggle·stages·worker_count) 선례. 기본 30s(k6식) 자동 적용은 기존 곡선 run의 부하 모양을 silently 바꿔 마이그레이션/재실행 비교성을 깨므로 기각.
2. **graceful 전용.** immediate는 이미 즉시 취소라 상한 무의미. fixed closed / open-loop엔 애초에 미노출(`vu_stages` 전용, `ramp_down`과 동일 게이트).
3. **기존 취소 메커니즘 재사용.** immediate 모드가 이미 쓰는 "토큰 취소 → 스텝 경계 abort → park" 경로를 시간-게이트해서 재사용. 새 중단 경로를 만들지 않는다.
4. **관측은 기존 차트로.** 상한 발동 효과(actual→desired 수렴)는 이미 있는 active-VU 시계열에 그대로 보인다. 새 카운터/와이어 없음(§9 연기).

## 4. Goals / Non-goals

### Goals
- 곡선+graceful run에 opt-in `graceful_ramp_down_seconds`(초, 최소 1) 상한.
- 상한 초과 은퇴 VU를 supervisor가 취소 → 스텝 경계 park.
- 엔진/proto/controller/UI 배선 + byte-identical 불변식(미설정 시).
- RunDialog + ScheduleForm 양쪽 배선 + 프리필.

### Non-goals
- **gracefulStop(종료-시점 상한)** — run deadline은 이미 하드 스텝-경계 중단이라 "느슨한 종료 lingering"이 존재하지 않는다. 이 슬라이스는 stage 간 ramp-down overshoot만.
- **중단 iteration 카운터/리포트 표기** — v1은 active-VU 차트로 충분. 놓치면 안 되는 상황이 생기면 후속 옵션(§9). 사용자 결정 2026-07-16.
- **per-stage 상한** — k6도 전역 단일 값. 단일 노브.
- **immediate/open-loop/fixed-closed 적용** — graceful 곡선 전용.
- **mid-request 소켓 중단** — 진행 중 HTTP 1건은 마저 끝남(`runner.rs:37` 기존 불변식 유지).

## 5. 엔진 (`crates/engine`)

### 5.1 RunPlan 필드
`RunPlan`에 `graceful_ramp_down: Option<Duration>` 추가(`http_timeout: Duration` 선례 — proto는 seconds, RunPlan은 Duration). `None`=무상한.
**컴파일러-강제 리터럴 fan-out:** `RunPlan`은 `Default` 미파생이라 **모든 `RunPlan { .. }` 리터럴**(엔진/워커 테스트 ~38곳)에 `graceful_ramp_down: None`을 넣어야 컴파일된다. 전부 컴파일러가 잡으므로 correctness 위험 0이나 plan의 작업량에 포함(§14). `grep -rn "RunPlan {" crates/`로 전수.

### 5.2 supervisor 상한 로직 (`run_scenario_vu_curve`)
plan 필드 추출부(`runner.rs:727-731`의 `immediate`/`think_time` 옆)에 `let graceful_ramp_down = plan.graceful_ramp_down;` 추가.
supervisor 루프 **밖**에 supervisor-소유(공유 없음, Mutex 불요) 벡터 선언:
```rust
let mut retire_since: Vec<Option<Instant>> = vec![None; max_vus as usize];
```
기존 `if immediate { ... }` 블록(`runner.rs:861-869`)을 다음으로 확장(immediate 우선 — cap이 immediate에 섞여도 무해):
```rust
if immediate {
    // 기존: over-desired 전부 idempotent 취소
} else if let Some(cap) = graceful_ramp_down {
    retire_expired(&slab, &mut retire_since, desired, spawned, cap, now);
}
```
`now`는 tick 상단에서 이미 계산된 `Instant::now()` 재사용.

### 5.3 추출 헬퍼 (테스트 가능)
```rust
/// graceful ramp-down 상한: retire 요청(index >= desired) 후 cap을 넘겨 여전히
/// active(slab Some)인 VU의 토큰을 취소한다. 취소된 VU는 스텝 경계에서 park
/// (immediate 모드와 동일 경로). retire_since는 supervisor-소유 per-index 타이머.
fn retire_expired(
    slab: &std::sync::Mutex<Vec<Option<CancellationToken>>>,
    retire_since: &mut [Option<Instant>],
    desired: u32,
    spawned: u32,
    cap: Duration,
    now: Instant,
) {
    let g = slab.lock().expect("slab mutex");
    for index in (desired as usize)..(spawned as usize) {
        if g[index].is_some() {
            match retire_since[index] {
                None => retire_since[index] = Some(now),
                Some(t0) if now.duration_since(t0) >= cap => {
                    if let Some(tok) = &g[index] {
                        tok.cancel();
                    }
                }
                _ => {}
            }
        } else {
            retire_since[index] = None; // 자발 park·미활성 → 타이머 리셋
        }
    }
    // index < desired(활성-desired)는 retire 대상 아님 → 리셋
    for index in 0..(desired as usize).min(retire_since.len()) {
        retire_since[index] = None;
    }
}
```
불변식·엣지(설계 근거):
- **재활성화 레이스 없음:** `index >= desired && slab Some` ⟹ 원래 lingering 활성화 그대로(재활성은 `desired > index`를 요구하므로 이 분기에서 불가). 취소 안전.
- `spawned >= desired`(lazy-spawn 루프 후) 항상 → `(desired..spawned)` 유효.
- **`failed` 오염 없음:** 취소 → `execute_steps`가 스텝 경계에서 `Ok(StepFlow::Aborted)`(runner.rs:452·509·519·645·667) → `run_vu_curve:1089` `Aborted => break`(failed++ 안 함). `AllVusFailed`는 spawned 기준이라 무영향.
- **park, not kill:** `act`는 run-level `cancel`의 child. `act`만 취소되면 slot clear 후 park head 복귀(run 미취소), desired 재상승 시 새 child token으로 재활성.
- **정밀도:** supervisor 250ms tick → cap ±1 tick. 최소 1s 상한에 충분.
- **취소는 idempotent**(이미 취소된 토큰 재취소 무해) — cap 넘긴 뒤 매 tick 재취소해도 안전(immediate와 동일 정신).

### 5.4 무변경
`run_vu_curve`(VU 본체)·park-gate·think pacing·`immediate` 경로·open-loop·fixed-closed 전부 무변경. cap `None`이면 supervisor 새 블록 skip → **byte-identical**.

## 6. proto (`crates/proto`)
`Profile`에 additive:
```proto
optional uint32 graceful_ramp_down_seconds = 14;  // VU-curve graceful ramp-down 상한(초); 부재 = 무상한
```
부재 = 무상한 = byte-identical wire. `Profile`은 Copy 상실 상태 유지(기존 dispatch `.clone()`).

## 7. controller (`crates/controller`)

### 7.1 store `Profile` 필드
```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub graceful_ramp_down_seconds: Option<u32>,
```
`skip_serializing_if`로 None이면 profile_json에서 생략 → 기존 프로필 byte-identical. migration 0.

### 7.2 검증 (`api/runs.rs::validate_run_config`)
`ramp_down` vu-curve-only 가드(runs.rs:209-213) 옆에 추가:
- `graceful_ramp_down_seconds.is_some()` 인데 `!is_vu_curve()` → 400 `"graceful_ramp_down_seconds는 vu_stages(VU 곡선) 전용입니다"`.
- `graceful_ramp_down_seconds.is_some()` 인데 `ramp_down == Some(Immediate)` → 400 `"graceful_ramp_down_seconds는 graceful ramp-down에서만 유효합니다"`.
- `graceful_ramp_down_seconds == Some(0)` → 400 `"graceful_ramp_down_seconds는 1 이상이어야 합니다"`(0=immediate와 중복·무의미).

(UI spread-gate가 위 위반 조합을 애초에 못 보내지만, 직접 API·손-페이로드 방어로 명시 거부.)

### 7.3 dispatch 매핑
`api/runs.rs`의 proto `Profile` 조립부(`ramp_down_immediate` 매핑 = runs.rs:743 옆)에 `graceful_ramp_down_seconds: profile.graceful_ramp_down_seconds` 추가.

### 7.4 report/무변경 + 리터럴 fan-out
store `Profile`도 `Default` 미파생이라 **모든 `Profile { .. }` 리터럴**(`api/runs.rs` 테스트 fixture ~40곳·`store/{runs,presets,schedules}.rs`·`schedule/runner.rs`·`grpc/coordinator.rs`·`report.rs:952`[그 `Profile` 리터럴은 952에서 시작, `:967`은 `vu_stages: None` 줄])에 `graceful_ramp_down_seconds: None` 추가해야 컴파일. 전부 컴파일러-강제(위험 0)·`grep -rn "Profile {" crates/controller/`로 전수(§14 작업량). 리포트 출력·집계 무변경.

## 8. worker (`crates/worker`)
proto→RunPlan 매핑(`lib.rs:289` `ramp_down` 옆):
```rust
graceful_ramp_down: profile
    .graceful_ramp_down_seconds
    .map(|s| Duration::from_secs(u64::from(s))),
```
`u64::from`은 `http_timeout` 매핑(`lib.rs:244`)과 동일 관용구(`as u64` 대신 — lossless·clippy `cast_lossless` 회피). proto 부재→`None`→무상한.

## 9. UI (`ui/`)

### 9.1 Zod (`api/schemas.ts`)
`ProfileSchema`에 `graceful_ramp_down_seconds: z.number().int().positive().optional()` — 서버 `skip_serializing_if`라 부재만 옴(`.nullish()` 아님, ui/CLAUDE.md "Zod 3종 분기" — apply_scenario_think_time과 동일 skip-when-none→`.optional()`).

### 9.2 상태·빌더 (`components/loadModel.ts`)
- `LoadModelState`에 `gracefulCap: string` 추가(string-draft — `thinkSeed` 선례, 빈칸→undefined로 NaN 차단).
- `LoadProfileFields`의 `Partial<Pick<Profile, ...>>`에 `graceful_ramp_down_seconds` 추가.
- `buildLoadProfile`의 **closed+curve arm만** 조건부 spread(ramp_down spread 옆, `loadModel.ts:66`):
  ```ts
  ...(s.rampDown === "graceful" && s.gracefulCap.trim() !== ""
    ? { graceful_ramp_down_seconds: Number(s.gracefulCap) }
    : {}),
  ```
  (immediate거나 빈칸이면 키 부재 — `field:undefined`는 byte-identical 깨짐, ui/CLAUDE.md 조건부-spread 규칙.)
- `LoadModelErrors`에 `gracefulCapInvalid: boolean`(값 있고 `<1`이거나 비수치) 추가·`canSubmit` 게이트.
- **`loadModel.ts` 불변식 테스트**: 타 3모드(closed+fixed·open±curve) profile에 `not.toHaveProperty("graceful_ramp_down_seconds")` 가드(vu_stages/ramp_down 선례).

### 9.3 입력 필드 (`components/LoadModelFields.tsx`)
ramp_down `role="radiogroup"`(`LoadModelFields.tsx:498-529`)이 **닫힌 직후**(`:529` 이후), `rampDown === "graceful"` 게이트로만 렌더(라디오 두 개 *사이*가 아님):
- `<Input>` numeric(디자인시스템 프리미티브), `value={gracefulCap}` / `onChange`로 string setter, `min=1`, placeholder=무제한 힌트.
- label + HelpTip(`<label>` **밖** 형제 `<span>` — U3 accname 오염 방지). HelpTip 본문 = `ko.glossary.gracefulCap`.
- props `gracefulCap: string` / `setGracefulCap: (v: string) => void` 추가(rampDown/setRampDown 선례). `simpleMode`에선 rampDown째로 숨김(기존 게이트라 자동).

### 9.4 부모 배선 (RunDialog + ScheduleForm 둘 다)
- `gracefulCap` state 소유 + `LoadModelFields`에 전달 + `loadState`에 포함.
- **프리필 (silent divergence 방지 — think-ux Should-fix 클래스, [[load-divergence-explain-confirm]]):** `prof.graceful_ramp_down_seconds`로 초기화. 시드 사이트 = **RunDialog 2곳**(`useState` init[`RunDialog.tsx:96` rampDown 짝] — **retry는 `initial` prop + reseed-by-key remount로 이 init에 포함**, 별도 세 번째 사이트 아님·`loadPreset`[`:295` 짝]) + **ScheduleForm init**(`ScheduleForm.tsx:82` 짝). `useState(() => initial?.profile.graceful_ramp_down_seconds != null ? String(initial.profile.graceful_ramp_down_seconds) : "")` + `loadPreset` 재시드.
- **RunDialog `detailedAppliedCount`**(`RunDialog.tsx:369` 시작, 기존 ramp_down 항 = `:375`) 항 추가: `(loadModel === "closed" && rateMode === "curve" && rampDown === "graceful" && gracefulCap.trim() !== "" ? 1 : 0)` — 간단모드 "N개 상세 설정 숨김" 힌트 정확도. 기존 `:375` 항(`rampDown !== "graceful"`)과 상호배타라 이중계수 없음.

### 9.5 ko 카탈로그 (`i18n/ko.ts`, ADR-0035)
- `ko.loadModel.gracefulCapLabel`(예: "느슨한 감축 상한(초)"), placeholder.
- `ko.glossary.gracefulCap`(HelpTip 본문): "감축(ramp-down) 중 은퇴한 VU가 현재 반복을 마칠 때까지 기다리는 최대 시간(초). 비우면 무제한. 초과 시 다음 스텝 경계에서 중단합니다." (전체 run 길이 상한으로 오해 방지.)

## 10. 데이터/와이어 변경 요약 (불변식)

| 레이어 | 변경 | byte-identical 조건 |
|---|---|---|
| engine RunPlan | `graceful_ramp_down: Option<Duration>` | `None` → supervisor 새 블록 skip |
| engine supervisor | `retire_expired` 헬퍼 + graceful 분기 | cap `None` → 미호출 |
| proto Profile | `optional uint32 …=14` | 부재 → wire 동일 |
| store Profile | `Option<u32>` + skip_serializing_if | None → profile_json 생략 |
| controller validate | 3 거부 규칙 | 미설정 payload 무영향 |
| worker map | `.map(Duration::from_secs)` | 부재 → None |
| UI Zod/build/UI | `.optional()` + 조건부 spread + 입력 | 미설정 → payload 키 부재 |
| migration | **0** | profile_json serde |

## 11. ADR 불필요 근거
ADR-0037(closed-loop VU 곡선)이 park-gate·`vu_stages`·`ramp_down`(graceful/immediate)을 이미 결정했고, 그 spec §9가 "graceful grace 상한"을 연기 항목으로 명시했다. 본 슬라이스는 그 결정의 **구현**이지 새 아키텍처 결정이 아니다(think-time-defaults·open-loop-think-time-ux가 ADR-0033/0031 범위 내로 ADR 생략한 선례와 동형). build-log·roadmap 갱신만.

## 12. 테스트

### 12.1 엔진 (Rust)
- **`retire_expired` 단위 (헬퍼 직접 — 결정적 주 증명, 클록 불요):** slab을 알려진 `CancellationToken`들로 구성 + `retire_since` 상태 주입 + **합성 `Instant` 직접 전달**(`now = base; base + cap` — `tokio::time::pause` 아님, `std::Instant` 산술) → (a) 첫 호출은 over-desired active index에 타이머만 세팅(취소 0), (b) `now`에 `+cap` 이상 진전된 Instant를 넘긴 재호출은 그 토큰만 취소(`tok.is_cancelled()` 단언), (c) `index < desired`·slab None은 타이머 리셋(취소 안 함), (d) 취소 후 재-desire(index<desired) 시 리셋 확인. **이 테스트가 cap 로직의 결정적 증명** — 클록/런타임 불필요.
- **곡선 통합 (실 wall-clock — `tokio::time::pause` 금지):** supervisor는 `std::time::Instant`(`runner.rs:4,722,800`)로 도는데 `tokio::time::pause`는 tokio 가상 클록만 진전시켜 `std::Instant::now()`를 안 움직인다 → cap이 영영 안 뜨고 std deadline도 안 닿아 **run이 hang**. 그래서 기존 `crates/engine/tests/vu_curve.rs`처럼 **plain `#[tokio::test]`(start_paused 아님) + 짧은 실 stage duration + 실 responder `set_delay`**로: ramp-down 곡선(예: `[{2,2s},{0,4s}]`) + iteration을 cap보다 길게(responder delay > cap 또는 스텝 다수). cap=1s면 은퇴 후 ~1s 내 actual이 desired로 수렴, cap `None`이면 overshoot 지속(무상한 회귀 없음). `vu_curve.rs`의 `set_delay`/`sleep` 패턴 그대로 차용.
- **`failed` 불오염:** 상한 취소된 VU가 `failed` count·`AllVusFailed`에 안 들어감 단언(위 통합 또는 별도 케이스).

### 12.2 UI
- Zod round-trip(`.optional()`·서버 부재).
- `buildLoadProfile` 조건부 spread: graceful+값→키 존재, immediate/빈칸/타 모드→키 부재(`not.toHaveProperty`).
- 프리필: `initial.profile.graceful_ramp_down_seconds` → 입력값 시드(RunDialog `useState` init[retry payload 포함]·loadPreset / ScheduleForm init — §9.4 시드 사이트와 일치).
- `detailedAppliedCount` 정확-카운트(cap-set 시 +1) + teeth(값 지우면 -1).
- `gracefulCapInvalid`가 `<1`·비수치에서 Run 버튼 disable.
- **tdd-guard 순서:** plan은 각 UI task에서 **테스트 파일 편집을 src보다 먼저**(pending RED diff — ui/CLAUDE.md tdd-guard 함정).

### 12.3 게이트
`cargo fmt/clippy/nextest/doctest` + `cd ui && pnpm lint && pnpm test && pnpm build`(전체 스위트 1회 — targeted-green≠full-green).

## 13. 라이브 검증 (필수 — 엔진/run-create 경로 변경)
`/live-verify`: 워크트리-자체 `cargo build -p handicap-worker --bin worker && -p handicap-controller --bin controller` + 느린 responder(iteration을 cap보다 길게). ramp-down 곡선 run 2회:
- **cap 無**(무제한): 감축 후 active-VU actual이 desired를 한참 웃돎(overshoot).
- **cap 有**(예: 1s): actual이 desired로 ~cap 내 수렴.
`GET /api/runs/{id}` 리포트의 `active_vu_series`(또는 `active_vu_by_worker`) desired/actual 비교로 상한 효과 실증. + 검증 3거부(vu-curve-only·graceful-only·≥1) 400 확인. UI: RunDialog에서 곡선+graceful+cap run 1회 생성→리포트까지(Zod 콘솔 에러 0).

## 14. 스코프·연기·구현 순서
- **연기:** 중단 iteration 카운터(§4 Non-goals·§9)·gracefulStop·per-stage 상한. → roadmap §B9 갱신.
- **구현 순서(plan에서 task 분할):** ① 엔진(RunPlan 필드[+ 모든 `RunPlan {}` 리터럴 `None`, grep 전수 §5.1]+`retire_expired`+supervisor 분기+`retire_expired` 단위·곡선 통합·`failed` 테스트) → ② proto+worker 매핑 → ③ controller(store 필드[+ 모든 store `Profile {}` 리터럴 `None`, grep 전수 §7.4]+검증 3규칙+dispatch+report) → ④ UI(Zod→테스트→loadModel 빌더/에러→LoadModelFields 입력→RunDialog/ScheduleForm 배선/프리필/count→ko; **각 UI task는 테스트 파일 편집을 src보다 먼저** — tdd-guard). 각 task 독립 green 커밋. path-gate: 엔진 동시성 diff라 code-quality 리뷰 Opus + finish-slice §0 security grep이 지배(엔진 `runner.rs` 매치 가능성 — 예측 말고 grep 실행).

## 15. 열린 질문 (없음)
브레인스토밍에서 기본값(opt-in 무상한)·관측(카운터 연기)·검증(3거부)·범위(gracefulStop 제외) 모두 확정.
