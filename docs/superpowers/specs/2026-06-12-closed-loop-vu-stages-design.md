# Closed-loop VU 곡선 (`vu_stages`) — 설계

- **날짜**: 2026-06-12
- **상태**: 설계 확정 (brainstorming 섹션별 승인 완료)
- **출처**: S-D(ADR-0032, open-loop stages) 연기 항목 "closed-loop stages(VU 곡선+retire/ramp-down)" + 부하 모드 선택기의 closed+curve disabled "곧 지원" 약속(`2026-06-05-load-model-mode-selector-design.md`)
- **ADR**: 구현 머지 시 **ADR-0037** 신규(새 실행 의미론: park-gate VU 곡선 + ramp_down 노브)

## 1. 목적 / 범위

closed-loop(VU 기반) run의 VU 수를 **다단계 piecewise-linear 곡선**(`vu_stages: [{target, duration_seconds}]`)으로 ramp-up/ramp-down 한다. S-D가 open-loop RPS 곡선만 출하해 생긴 비대칭(UI에 "곧 지원" disabled)을 해소한다.

- **IN**: 엔진 신규 격리 실행 함수(park-gate), `Profile.vu_stages`/`Profile.ramp_down` 와이어, 검증 게이트, proto 2필드, 워커 분기, UI closed+curve 활성화(에디터·미리보기·템플릿 재사용 + ramp_down 라디오 + 초보자 카피).
- **OUT(§9 연기)**: 곡선 멀티워커 샤딩, active-VU per-second 시계열, graceful grace 상한, fresh-spawn 모드, mid-request 소켓 중단.

## 2. 사용자 결정 (brainstorming 확정)

| 질문 | 결정 |
|---|---|
| ramp-down 의미론 | **per-run 노브 `ramp_down`**: `graceful`(기본, iteration 완료 후 park) \| `immediate`(child 토큰 취소 → 다음 스텝 경계 중단 후 park). 소켓 찢기는 비목표 — 진행 중 HTTP 요청 1개는 마저 끝남. |
| 재활성화 VU 정체성 | **Park & 재사용**: retire = 종료가 아니라 park. 같은 vu_id·cookie jar로 재활성화(돌아온 사용자=세션 유지, k6 ramping-vus·open-loop 슬롯풀 jar-지속 의미론과 일관). vu_id ∈ `[vu_offset, vu_offset+max_vus)` 고정. |
| 멀티워커 | **단일워커 v1**: `max(stage.target) > --worker-capacity-vus`(기본 2000)면 400(명확한 메시지). 곡선 샤딩은 후속. |

### graceful의 문서화된 주의사항 (의미론이지 버그가 아님)

- 실제 active VU는 곡선보다 최대 **1 iteration 길이**만큼 늦게 내려간다. 최악 지연 = 스텝 수 × http_timeout(+ loop 반복). iteration 길이 > stage 길이면 짧은 dip은 뭉개진다.
- 완화: retire 체크를 iteration 종료 직후·**think-time pacing 이전**에 수행 — think time이 지연에 가산되지 않는다.
- run 전체 종료(deadline)는 기존 의미론 유지(스텝 경계 즉시 중단) — graceful은 곡선 중간 ramp-down에만 적용.
- `immediate`는 지연 상한이 "진행 중 요청 1개"(최대 http_timeout)로 줄어든다. immediate로 중단된 iteration의 나머지 스텝은 실행되지 않는다(부분 iteration — 기존 deadline 의미론과 같은 부류). retire 중단은 에러/abort 메트릭에 집계되지 않는다.

## 3. 와이어 포맷 + 검증

### 3.1 Profile 신규 필드 (마이그레이션 0 — profile_json serde default 패턴)

```yaml
profile:
  vus: 0                # curve 모드에선 0 강제 (이중 지정 금지)
  duration_seconds: 0   # 총 길이 = sum(vu_stages[].duration_seconds), S-D 미러
  ramp_up_seconds: 0    # 곡선이 ramp의 일반화 — 함께 사용 금지
  vu_stages:            # 신규. 기존 Stage 타입 재사용 (target = VU 수)
    - { target: 50, duration_seconds: 60 }
    - { target: 10, duration_seconds: 120 }
  ramp_down: immediate  # 신규 optional. absent = graceful
  think_time: { min_ms: 100, max_ms: 300 }  # closed-loop이므로 허용
  think_seed: 42        # 허용
```

- `Profile.vu_stages: Option<Vec<Stage>>`, `Profile.ramp_down: Option<RampDown>`(`#[serde(rename_all = "lowercase")]` enum `Graceful | Immediate`) — 둘 다 `#[serde(default, skip_serializing_if = "Option::is_none")]` → UI Zod **`.optional()`**(absent로 직렬화, `.nullish()` 불요 — ui/CLAUDE.md skip_serializing_if 분기 준수).
- **`Some(vec![])` = absent** (S-D 미러). 판별 헬퍼 신규 `Profile::is_vu_curve() = vu_stages.as_ref().is_some_and(|s| !s.is_empty())`. **`is_open_loop()` 무변경.**
- 곡선 시작 VU = 0, 첫 stage가 `0 → target_0`을 ramp (S-D `rate_at` 컨벤션 동일). 목표치는 보간값의 `round()` 정수화.

### 3.2 검증 (`validate_run_config` — run-create·preset 저장·스케줄러 발사 공유)

분기 구조: `is_vu_curve()`를 **open-loop 분기보다 먼저** 검사 (curve 규칙이 open-loop 필드 배제를 포함하므로 순서 무관 동작이지만, 명시적으로 최상단).

`vu_stages` 비어있지 않을 때 (curve 모드):

| # | 규칙 | 400 사유 |
|---|---|---|
| ① | `target_rps.is_some()` | vu_stages와 target_rps 동시 지정 금지 |
| ② | `max_in_flight.is_some()` | open-loop 전용 노브 |
| ③ | `stages` 비어있지 않음 | RPS 곡선과 VU 곡선 동시 지정 금지 |
| ④ | `ramp_up_seconds > 0` | 곡선이 ramp의 일반화 |
| ⑤ | `duration_seconds > 0` | 총 길이 = stage 합 (S-D 미러) |
| ⑥ | `vus > 0` | 곡선과 이중 지정 금지 (open-loop의 "vus 무시"보다 의도적으로 엄격) |
| ⑦ | stage당 `duration_seconds == 0` 또는 `target > capacity` | duration ≥ 1 / 단일워커 v1 — "최대 목표 VU가 워커 용량(N)을 초과 — 멀티워커 곡선 샤딩 미지원" |
| ⑧ | 모든 stage `target == 0` | 최소 한 stage target > 0 (S-D 미러) |

`vu_stages` 없을 때:

| # | 규칙 | 400 사유 |
|---|---|---|
| ⑨ | `ramp_down.is_some()` | ramp_down은 VU 곡선 전용 노브 |

- `think_time`/`think_seed`는 **허용** — 기존 범위 검증(min≤max≤600000) 그대로 통과.
- capacity는 `--worker-capacity-vus`(AppState) — 검증 시점에 참조 가능해야 함(기존 worker_count 산출과 같은 소스).
- 기존 closed 고정·open-loop 두 모드의 검증 경로는 **무변경**.

### 3.3 판별 사이트 (S-D "직접 분기 금지" 함정 연장)

`is_open_loop()` 판별 3 사이트(create 워커 수·per_vu slot_count·unique 워커 수)에 curve 분기 추가:

- **워커 수**: `is_vu_curve() → N=1 고정` (검증 ⑦이 capacity 이내를 보장).
- **per_vu slot_count**(데이터 바인딩 row 요구치): curve = `max(stage.target)` (closed 고정의 `vus`에 대응).
- **unique row_count ≥ N**: N=1이라 기존 로직 통과.

새 판별이 필요한 코드는 `is_vu_curve()`만 사용 — `vu_stages.is_some()` 직접 분기 금지(`Some(vec![])` 오분류).

## 4. 엔진 실행 모델

### 4.1 격리 함수 (S-C 선례)

신규 `pub async fn run_scenario_vu_curve(scenario, plan, out, cancel) -> Result<()>` (`runner.rs`). 기존 `run_scenario`/`run_vu`/`run_scenario_open_loop` **무변경 = closed 고정·open-loop byte-identical 구조 보장**.

`RunPlan` 추가 필드: `vu_stages: Option<Vec<Stage>>`, `ramp_down: RampDown`(엔진 enum, `Default = Graceful`) — RunPlan struct 리터럴 전 사이트(테스트 포함) 갱신(컴파일러-driven).

### 4.2 슈퍼바이저 + park-gate

- `max_vus = max(stage.target)` (검증이 ≥1 보장).
- `tokio::sync::watch::channel::<u32>(0)`으로 "목표 active VU 수" 배포.
- **슈퍼바이저 루프**(메인 태스크 inline 또는 별도 spawn): 250ms 틱마다 `desired = round(rate_at(vu_stages, elapsed)).clamp(0, max_vus)` 계산·send. S-D `rate_at`는 stage-generic 순수 함수라 **그대로 재사용**(open-loop의 "`next` 기준 평가" 함정은 arrival 예약 문제 — wall-clock `elapsed` 기준이면 충분).
- **lazy spawn**: `desired > spawned`가 처음 될 때 인덱스 `spawned..desired` VU 태스크 spawn (`vu_id = vu_offset + i`). 곡선이 안 닿는 인덱스는 영영 안 뜬다.
- **활성화 토큰(두 모드 공통)**: VU는 활성화마다 `cancel.child_token()`을 발급해 공유 슬랩 `Mutex<Vec<Option<CancellationToken>>>`(인덱스 = VU)에 등록하고, park 진입 시 해제한다. iteration 실행·pacing은 항상 이 child 토큰을 받는다 — run-abort는 parent 전파로 자동(모드 분기 없는 단일 VU 루프). 슈퍼바이저의 desired 하강 시 인덱스 `>= desired` 토큰 취소는 **immediate 모드에서만** 수행(graceful은 watch 값만 내림).

### 4.3 VU 태스크 루프 (인덱스 `i`)

```text
VuClient 1회 생성 (cookie jar — park를 넘어 지속)
per-VU rng/iter_id 카운터 (park를 넘어 단조 지속)
loop {
    // park: desired > i 될 때까지 watch 대기.
    //       run-cancel 또는 deadline 도달 → 태스크 종료.
    // 활성화: child 토큰 발급·슬랩 등록 (두 모드 공통, §4.2)
    // 1 iteration 실행 — run_vu 본문의 의도된 복제 (§4.4)
    //   Aborted 발생 시: cancel.is_cancelled()(run-level)면 run-abort → 종료
    //                    아니면 retire-abort → 슬랩 해제 후 park 복귀 (failed 미집계)
    // gate 재확인 (think-time pacing **이전** — graceful 지연 완화):
    //   desired <= i → 슬랩 해제, park 복귀 (think time 건너뜀)
    //   desired > i  → pace(think_time) (cancel-aware, child 토큰) 후 다음 iteration
}
```

- **iteration 본문 = `run_vu` 본문의 의도된 복제** (S-C `run_arrival` 선례): dataset row select(`select_index(vu_id, iter_id, …)`), iter_vars 셋업, `execute_steps`, flow 처리, think-time pacing. 양쪽에 lockstep 주석(`execute_step`/`execute_step_traced` 선례). `run_vu`에서 추출 공유하지 않는 이유 = hot path byte-identical 구조 보장 우선(plan 단계에서 추출 가능성 재검토는 허용하되 기본은 복제).
- `iter_id`는 VU-local 단조 — park를 넘어 리셋 없이 지속. `IterSequential | Unique` 공유 `seq_counter`는 `run_scenario`와 동일 패턴. Unique 소진(`None`) → VU 깨끗한 영구 종료(기존 의미론).
- **실패 의미론 미러**: 진짜 `EngineError`(비-abort) → `warn!` + `failed`++ + VU 영구 사망(재spawn 없음). `failed >= max_vus` → `AllVusFailed`. 일부만 사망 시 partial-failure `info!`(기존 미러). 사망 VU의 인덱스 구멍은 메우지 않는다(곡선 대비 부족분은 partial-failure 로그가 신호).
- **deadline** = `plan.duration`(워커가 `sum(vu_stages[].duration_seconds)` 계산·전달, S-D 미러). deadline 도달 시 기존 의미론(스텝 경계 중단, park 중이면 즉시 종료).

### 4.4 플러셔 / 메트릭

- 플러셔는 기존 미러(500ms 틱, drain 5종, final flush, `dropped: 0`).
- **`MetricFlush` 불변식 갱신: 드레인 사이트 4→6, send-guard 3→5** (curve periodic + curve final 둘 다 guard — curve는 dropped 항상 0이라 open-loop final의 무가드 예외 불필요). engine `CLAUDE.md`의 "4 flush 사이트 + 3 send-guard" 문구를 6+5로 갱신하는 것까지 이 슬라이스 범위.
- 메트릭 파이프라인 신규 0 — per-step×ts 윈도·loop/if/group/phase 전부 기존 그대로. active-VU 시계열은 연기(§9).

## 5. 컨트롤러 · proto · 워커

- **proto** (`handicap.proto` Profile): `repeated Stage vu_stages = 12; bool ramp_down_immediate = 13;` — 기존 `Stage` 메시지 재사용, bool absent=false=graceful. **prost exhaustive**: `Profile {` struct 리터럴 전 사이트 grep(컨트롤러 dispatch·워커·proto 테스트) + S-D에서 이미 `Copy` 상실이라 추가 `.clone()` 불요.
- **컨트롤러 dispatch**: `Option<RampDown>` → `ramp_down_immediate: matches!(ramp_down, Some(Immediate))` 매핑, `vu_stages` 그대로 전달. 단일워커라 shard 4필드는 `shard_count=1, vu_offset=0, vu_count=max(stage.target)`.
- **워커** (`main.rs`): ① `run_duration_secs`에 vu_stages 합산 분기(stages 미러) ② 실행 함수 선택 — `vu_stages` 비어있지 않음 → `run_scenario_vu_curve`, `is_open_loop` 상당 → `run_scenario_open_loop`, 그 외 → `run_scenario` ③ `RunPlan.vu_stages/ramp_down` 채움(bool → 엔진 enum).
- **store/리포트/인사이트/criteria 평가**: 무변경. verdict·export·비교 경로는 `ReportJson` 무변경이라 자동 호환.

## 6. UI

### 6.1 모드 선택기 활성화 (`LoadModelFields.tsx`, `loadModel.ts`)

- closed 라디오의 eager `setRateMode("fixed")` 리셋 + 곡선 라디오 `disabled` "곧 지원" **제거**(이중 가드 해체 — 모드 선택기 spec의 약속 이행).
- stage 행 에디터·`StageCurvePreview`·부하-모양 템플릿 4종(점증/스파이크/계단/소크) **재사용** — 렌더 조건을 `rateMode === "curve"` 공통으로 일반화, 라벨만 loadModel 분기("목표 RPS" ↔ "목표 VU", 미리보기 aria/축 라벨 포함).
- closed+curve에서: `ramp_up`/`duration` 입력 숨김(open+curve 미러 — 총 길이 = stage 합), `target_rps`/`max_in_flight` 숨김(기존 open 전용 유지), think time 입력은 closed 공통이라 그대로 노출.
- **ramp_down 라디오**: closed+curve에서만 노출, 기본 graceful.

### 6.2 `loadModel.ts`

- `LoadModelState.rampDown: "graceful" | "immediate"` 추가(기본 `"graceful"`).
- `buildLoadProfile`에 closed+curve arm 신설(4번째 모드):

```ts
if (s.loadModel === "closed" && s.rateMode === "curve") {
  return {
    vus: 0,
    duration_seconds: 0,
    ramp_up_seconds: 0,
    vu_stages: s.stages.map((x) => ({
      target: Number(x.target),
      duration_seconds: Number(x.duration_seconds),
    })),
    think_time: buildThinkTime(s),
    think_seed: s.thinkSeed.trim() !== "" ? Number(s.thinkSeed) : undefined,
    ...(s.rampDown === "immediate" ? { ramp_down: "immediate" as const } : {}),
    // NO target_rps, NO max_in_flight, NO stages
  };
}
```

- `ramp_down`은 **immediate일 때만 emit**(graceful = absent = 서버 기본, byte-minimal).
- stage 행 숫자 검증을 curve 공통으로 일반화(open/closed 동일 규칙: 정수, target 0..=1,000,000, duration ≥ 1, 최소 한 target > 0 — capacity 상한은 서버 400이 권위, UI는 범위만). open+curve는 추가로 max_in_flight 요구(기존). 플래그 이름(기존 `stagesInvalid` 일반화 vs 신규 `vuStagesInvalid`)은 plan에서 확정 — 의미론은 위 규칙이 권위.
- "모드당 자기 필드만 emit" 불변식 테스트에 4번째 모드 추가 — 기존 3모드 payload **byte-identical**.

### 6.3 Zod / prefill / 표시

- `ProfileSchema.vu_stages: StageSchema.optional()`, `ramp_down: z.enum(["graceful","immediate"]).optional()` (둘 다 skip_serializing_if → absent → `.optional()`; nested `.default()` 누출 금지).
- **모드 역도출**(prefill·프리셋·"다시 실행"·ScheduleForm 공유 경로): `vu_stages` 비어있지 않음 → `("closed","curve")` + stage 행·rampDown 시드 / `stages` → `("open","curve")` / `target_rps` → `("open","fixed")` / 그 외 → `("closed","fixed")`.
- **`profileDurationSeconds`**(runPrefill.ts)에 vu_stages 합산 추가 — 누락 시 곡선 run이 Duration `0s`/Avg RPS `0`으로 표시(S-D follow-up 버그의 미러). `Pick<Profile, …>`에 `vu_stages` 추가.

### 6.4 초보자 카피 (영역 U/ADR-0035 연장 — 신규 문구 전부 `ko.ts` 경유)

- **HelpTip 2개**: "VU 곡선"(가상 사용자 수를 시간에 따라 늘렸다 줄이는 방식 — 점심 피크·이벤트 오픈처럼 사용자 수가 변하는 상황 재현) + "줄이는 방식"(두 선택지 차이 평문).
- **ramp_down 라디오 라벨은 행동 서술**: "요청을 마친 뒤 줄이기 (권장) — 안전하지만 곡선보다 약간 늦게 줄어듭니다" / "즉시 줄이기 — 곡선에 충실하지만 진행 중이던 요청 1개는 마저 끝납니다".
- **U1b 막힘 사유 패턴 재사용**: curve 모드 Run 버튼 비활성 사유를 한국어로(예: "모든 단계의 목표 VU와 길이(초)를 채워주세요", "최소 한 단계의 목표 VU는 0보다 커야 합니다").
- `ko.glossary`에 "VU 곡선" 항목 추가. HelpTip ⓘ는 heading/legend **밖** 배치(U3 accname 오염 함정).

## 7. 테스트 전략

### 7.1 엔진 (격리 함수 — 기존 스위트 무영향이 구조 보장)

- **park & 재사용**: Set-Cookie 주는 스텁 → 곡선 down-up 후 재활성화 요청에 쿠키 동반 단언(세션 지속). `${vu_id}` 에코 캡처로 id ⊆ `[0, max_vus)` 단언.
- **graceful**: 느린 스텁에서 ramp-down 구간 에러/abort 메트릭 0. **immediate**: 슬랩 토큰 취소 → 스텝 경계 중단 + `failed` 미증가(run-abort와 구별) + park 복귀 후 재활성화 가능.
- 곡선 추종은 **monotonic trend만** 단언(정확 카운트는 flake — Slice 4 ramp 테스트 함정 준수). deadline = stage 합 / `AllVusFailed` 미러 / target-0 구간 전원 park / `rate_at` 재사용은 기존 테스트가 커버.
- `MetricFlush` 드레인 6/guard 5 직접 확인(컴파일러 미검출 — engine CLAUDE.md 체크리스트 갱신 포함).

### 7.2 컨트롤러

- `validate_run_config` 단위 테스트: §3.2 규칙 ①–⑨ 각각 400 + 유효 curve 통과 + 기존 3모드 무변경.
- `is_vu_curve` predicate 테스트(`is_open_loop_predicate` 미러, `Some(vec![])`=absent 포함).
- proto round-trip + `Profile {` 리터럴 전 사이트 컴파일(컴파일러-driven).
- **e2e smoke 1개**: subprocess 워커로 짧은 곡선 run 완주 → `completed` + report 생성(`loop_e2e` 패턴).

### 7.3 UI

- `loadModel.test.ts`: 4번째 모드 emit 불변식(자기 필드만 + ramp_down immediate-only) + 기존 3모드 byte-identical + `vuStagesInvalid`류 플래그.
- `LoadModelFields.test.tsx`: closed+curve 라디오 활성(disabled 제거)·라벨 분기(VU↔RPS)·ramp_down 라디오 가시성(closed+curve만).
- RunDialog: closed+curve payload + prefill 역도출(vu_stages → closed+curve + rampDown 시드).
- `profileDurationSeconds` vu_stages 합산. `ko.ts` 카탈로그 테스트(기존 패턴).
- 게이트: `pnpm lint && pnpm test && pnpm build` + cargo workspace(fmt/clippy/test).

## 8. 라이브 검증 (S-D 갭 차단 — 머지 전 필수)

- 워크트리 자체 바이너리(`cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller` 후 **상대경로** `./target/debug/controller --db /tmp/x.db --ui-dir ui/dist`) + python `ThreadingHTTPServer` 200-responder.
- **곡선 모양 확인**: run-level `think_time` 200ms 고정 → closed-loop RPS ≈ `N(t) × 5`라 per-second 윈도에 곡선이 그대로 비침. 예: `[{target:10, duration:10}, {target:2, duration:10}]` → RPS 0→50 상승 후 ~10으로 하강. graceful vs immediate 비교 run(immediate가 하강 구간에서 더 빨리 떨어짐).
- **Playwright**: RunDialog closed+curve로 run 생성 → 리포트 렌더, 콘솔 Zod 에러 0, "다시 실행" prefill 왕복(closed+curve 역도출). 실 `/api/runs` 응답 바이트로 `ProfileSchema` throwaway `safeParse`(null-vs-absent 확인).

## 9. 연기 항목 (roadmap §B 기록)

- **곡선 멀티워커 샤딩**: stage target의 `shard_split` 분할 + 워커별 반올림 오차 설계. capacity 초과 대형 곡선의 유일한 경로.
- **active-VU per-second 시계열**: 리포트에 실제 active VU 곡선 표시(신규 메트릭 파이프라인 — drain/guard/proto/migration 비용). v1은 RPS가 간접 프록시.
- **graceful grace 상한**(k6 `gracefulRampDown`류): 초과 시 강제 중단 — v1은 무상한.
- **fresh-spawn 모드**: 재활성화를 새 vu_id·빈 jar로(신규 세션 유입 재현).
- **VU용 부하-모양 템플릿 별도 스케일**: 현재 RPS용 target 값 공유(모양은 동일, 값은 사용자 수정).
- **closed-loop 곡선 + criteria `rps_warmup_seconds` 자동 prefill**: 현재 closed 고정만 ramp 기반 prefill — 곡선은 첫 stage 길이 등 휴리스틱 후보.

## 10. 비목표

- mid-request 소켓 중단(메트릭 오염 방지를 위해 진행 중 요청은 항상 완료).
- open-loop과의 혼합 모드(`vu_stages` + `target_rps`/`stages` 동시 — 검증이 400).
- closed 고정 VU·open-loop 두 기존 모드의 어떤 행동 변화(byte-identical).
- 라이브 대시보드류 실시간 VU 표시(ADR-0009).
