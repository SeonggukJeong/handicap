# open-loop misconfig 경고 — create-time 구조 경고 (A9 정밀화 스코프)

- **날짜**: 2026-06-25
- **상태**: 설계 초안
- **출처**: roadmap §A9 연기 항목 "open-loop misconfig 경고" (사용자 선택, 2026-06-25). **왜 지금**: 초보 사용자가 *합법이지만 효과 없거나 낭비인* open-loop 설정을 만들 때 run을 낭비하기 전에 create-time에서 알려주는 footgun 방지가 빠져 있다.
- **연관**: ADR-0031(open-loop·`dropped`·`max_in_flight`), ADR-0038(open-loop 멀티워커 fan-out·worker_count), ADR-0035(ko.ts copy), `sizing.ts`(SlotSizingHelper·`peakStageTarget`), `insights.rs`(`load_gen_saturated` 사후 거울상), `LoadModelFields.tsx`.
- **ADR**: 신규 불필요(additive UI·기존 ADR-0031/0038 범위 내 표시 경고).

---

## 1. 문제와 목표

`validate_run_config`(`crates/controller/src/api/runs.rs:204~`)는 open-loop의 **하드 충돌**(vus+target_rps·worker_count on closed-loop·ramp_up+open-loop·max_in_flight 누락·고정 worker_count>target_rps[`runs.rs:372-380`, cmp 375] 등)을 이미 400으로 거부한다. 하지만 **합법이지만 의심스러운** 두 설정은 조용히 통과한다: ① open-loop 곡선에서 `worker_count`가 최고 stage 목표보다 커서 일부 워커가 0-share로 유휴(fan-out 낭비), ② `max_in_flight`가 너무 커서 슬롯이 절대 고갈되지 않아 무의미(초보가 "슬롯=부하 세기"로 오해). 둘 다 결정적으로 판정 가능한데 아무 신호가 없다.

ADR-0038은 "워커당 RPS 천장은 페이로드/TLS/응답크기에 좌우돼 고정 상수로 못 박는다"고 못박았으므로 *임계값 기반 포화 예측*은 범위 밖이다 — 이 슬라이스는 **임계값·측정 없이 프로필(+시나리오)만으로 결정적으로 참인 구조 경고**만 다룬다.

- **목표**: 위 두 구조 경고를 RunDialog create-time에 비차단 advisory로 표시(+ ①에 1-클릭 수정). false-positive 0.
- **비목표(연기)**: §7. drop-위험 넛지(지연 측정 필요)·사후 insight·ScheduleForm 표면·fan-out/pool 모드 ②·기타 측정 기반 경고.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance | seam? |
|---|---|---|---|
| R1 | MUST: open-loop **곡선**(stages)에서 `worker_count` **W** > `peak`(=`peakStageTarget(stages)`)이면 "(W−peak)개 워커가 0-share로 유휴" advisory를 표시한다. | `openLoopChecks.test.ts` idle-workers unit + `LoadModelFields` RTL | |
| R2 | MUST: open-loop(고정·곡선)에서 **`worker_count`가 미설정/1(단일 워커)이고 pool 모드가 아니며(R13)** `max_in_flight ≥ ceil(R × T)`(R=유효 rate, T=반복-시간 상한)이면 "슬롯이 절대 고갈 불가 = max_in_flight 무의미" advisory를 표시한다. fan-out(W>1)·pool 모드는 §7 연기. | unit + RTL | |
| R3 | MUST(불변식·false-positive 0): `T`는 시나리오 트리(중첩 컨테이너 재귀 포함)의 **상한**(과대추정) — http leaf=`(step.timeout_seconds ?? httpTimeoutSeconds)`+per-step `think_time.max_ms`, 순차=합, `loop{repeat,do}`=`repeat × bound(do)`, `if`=`max(then, …elif.then, else)`, `parallel`=`max(branch.steps)`. 단일 워커에서 실제 in-flight ≤ R×T이므로 inert 경고는 멀티스텝에서도 거짓 양성 0. | unit (single/seq/loop·×repeat/if/parallel/think + **nested loop-in-if·if-in-loop** + 과대추정 가드) | |
| R4 | MUST(fail-safe): 시나리오 부재·파싱 불가·미지 스텝·`T==0`(http leaf 0)이면 R2 경고를 **생략**한다(무경고). | unit (null/unparseable/no-http → 빈 결과) | |
| R5 | MUST: 두 경고는 비차단 advisory(`role="status"`) — Run 버튼 비활성·제출 차단을 하지 않는다(설정은 합법). | RTL (경고 있어도 submit 가능) | |
| R6 | MUST(byte-identical): `ui/`-only. run 제출 페이로드·`schemas.ts`·controller·proto·migration·engine·worker **0-diff**. `ScheduleForm.tsx` **0-diff**(새 optional prop 미전달). | `git diff --name-only`=ui/(+docs)만; payload RTL 불변 단언; ScheduleForm 미수정 | |
| R7 | MUST: 두 경고는 open-loop에서만 — ①은 **곡선 한정**(`rateMode==="curve"` 가드), ②는 **고정+곡선**. closed-loop·closed+curve에서는 둘 다 미렌더. | RTL `it.each` (closed/closed+curve 미렌더·①은 고정 미렌더) | |
| R8 | MUST: 표면 = **RunDialog 전용**, 게이트 분리 — ① = open+curve + `setWorkerCount`/`workerCount` prop 존재 + `poolMode !== true`(R13); ② = open + `sizingScenario != null` + `httpTimeout != null` + `worker_count ≤ 1` + `poolMode !== true`(R13). ScheduleForm·prop 부재 시 미렌더. | RTL `it.each` 락인(사이징 헬퍼 게이트 패턴) | |
| R9 | MUST: 모든 신규 문구(본문·`aria-label`·버튼)는 `ko.ts` 경유(ADR-0035). | grep 잔존 영어 0 / 코드리뷰 | |
| R10 | SHOULD(무료 추가): ① 경고에 1-클릭 "적용" 버튼 — `setWorkerCount(String(peak))`. | RTL (클릭→`setWorkerCount(peak)`) | |
| R11 | MUST(parity·단일 소스): ①의 `peak`와 ②의 곡선 유효 rate는 기존 `sizing.ts::peakStageTarget`(string-draft `{target:string}[]` 입력)를 재사용한다(독립 `max` 계산 금지). 고정 rate 유효성은 `sizing.ts`의 `targetRpsValid`를 **export해 재사용**(G2 — 현재 private). | 코드 — `peakStageTarget`·`targetRpsValid` 재사용 | |
| R12 | MUST: ②의 leaf fallback `httpTimeoutSeconds`는 `LoadModelFields`에 **신규 optional prop `httpTimeout?: number`**(RunDialog의 `http_timeout` state에서 배선)로 받는다. ScheduleForm은 미전달→② 미발생→ScheduleForm 0-diff(R6). | RTL (httpTimeout 부재 시 ② 미렌더) | |
| R13 | MUST(false-positive 0): 두 경고는 컨트롤러 **pool 모드**에서 미발생한다 — pool은 `worker_count`를 무시하고 dispatch-시점에 유휴 워커 전체로 분산(per-worker 슬롯·rate 정수 분할·0-slot 워커 drop 가능)해 ①(worker_count 기반)·②(per-worker 분할 미지) 둘 다 create-time 결정 불가. `poolMode`는 RunDialog `pool.data?.pool_mode`에서 신규 optional prop으로 배선; `poolMode === true`면 둘 다 suppress(로딩-중 `undefined`는 비-pool 가정으로 표시 — pool 배포에서 sub-second 잔류 가능, advisory라 허용). | RTL (poolMode=true → 두 경고 미렌더) | |

- **seam 없음**: 모든 요구가 `ui/` 내부 순수 로직·표시이고 와이어 계약(UI Zod ↔ serde / proto / migration / CSV·XLSX)을 건드리지 않는다(R6). 따라서 `seam ✅` 행이 없다 — 이게 이 슬라이스의 핵심 안전 속성.

---

## 3. 핵심 통찰 (설계 근거)

1. **하드 충돌은 이미 400 — 남은 건 *합법이지만 의심스러운* 설정뿐.** `validate_run_config`(`runs.rs:204~`)가 open-loop 모순을 전부 거부하므로, 새 경고는 거부가 아니라 advisory여야 한다(R5). 400으로 만들면 프리셋/스케줄 저장이 깨지고(정상 실행되는 설정), "경고" 의도와도 모순.
2. **ADR-0038이 임계값 포화 예측을 봉쇄 → 결정적 구조 사실만 사용.** 워커당 RPS 천장이 비-상수라, "target_rps가 너무 높다/슬롯이 너무 작다"류는 *측정*(prior-run 지연)이 필요해 결정적이지 않다(그건 SlotSizingHelper/`load_gen_saturated`가 이미 커버). R1/R2는 측정 없이 프로필(+시나리오)만으로 참/거짓이 갈린다.
3. **R3(상한 fold)이 R2의 false-positive를 구조적으로 0으로 만든다.** open-loop 슬롯은 *한 반복(전체 시나리오)*을 점유한다(`runner.rs:1265` `set.spawn(async move {…})` → `run_arrival`[`runner.rs:1358`] → `execute_steps(&scenario.steps, …)`[`runner.rs:430`]; retry 없음, deadline 절단[`runner.rs:445`]). 동시 in-flight 최대치 = `R × (반복 월-타임)`. 반복 월-타임을 **과대추정**(모든 요청이 타임아웃 풀로 `executor.rs:37-38/151-152`, think는 `max_ms` 클램프 `pacing.rs`, loop는 `repeat` 풀로, parallel은 한 슬롯서 동시→분기 max)하면 `R×T`가 실제 최대 in-flight의 상한 → `max_in_flight ≥ ceil(R×T)`면 진짜로 drop 불가. 과대추정은 경고를 *덜* 띄우는 방향이라 거짓 양성이 불가능(거짓 음성=놓침만 가능, 안전).
4. **②를 단일 워커(`worker_count ≤ 1`) + 비-pool로 스코프해 false-positive 0을 엄밀히 보장(R13).** 비-풀 fan-out은 rate(`shard_split`/`proportional_split_min1`)와 슬롯을 워커별 정수로 쪼개고(`coordinator.rs` `reduce_pool_profile` open-loop arm `coordinator.rs:1142-1156`), **pool 모드는 `worker_count`를 무시하고 dispatch 시점에 유휴 워커 전체로 분산**(`reserve_idle_pool_capacity` `coordinator.rs:614-657` → `assignment_for`)한다 — 정수 반올림/floor 때문에 per-worker `M_i/R_i`가 집계 비율과 어긋날 수 있어(예: `R=4,T=0.5,M=ceil(2)=2`인데 idle 4워커면 `shard_split(2,4)=[1,1,0,0]`→0-slot 워커가 자기 share를 drop) 집계 검사 `max_in_flight ≥ ceil(R×T)`만으로 per-worker drop 불가를 *엄밀히* 증명할 수 없다. 그래서 ②는 **`worker_count`가 미설정/1이고 pool 모드가 아닐 때만** 발화 — 비-pool 단일 워커면 분할이 없어 per-worker == 집계라 R3의 상한 논거가 그대로 성립한다. pool 모드에선 worker_count가 무시되므로 **①도** 무의미/오도(설정한 worker_count가 유휴 워커를 만들지 않음) → R13이 두 경고를 pool에서 함께 suppress. 이게 초보 footgun(기본 비-pool 단일 워커 run에서 max_in_flight 오해)의 지배적 케이스다. fan-out(W>1)·pool ②/①는 §7 연기.
5. **①은 곡선 한정**(R7): 고정 모드는 `worker_count > target_rps`가 이미 400(`runs.rs:372-380`)이라 유휴 워커가 발생 불가. 곡선은 0-share를 엔진이 흡수해 합법(B2'' ③ "0-share 워커 floor") → 거기서만 경고. ①은 구조적 카운트(W 워커, 정수 peak rate → W−peak개가 0-share)라 분할 반올림과 무관하게 fan-out에서도 엄밀.
6. **기존 게이트·헬퍼 재사용**(R8/R11): RunDialog 전용 렌더는 사이징 헬퍼의 `&& sizingScenarioId !== undefined` 게이트 패턴(ui/CLAUDE.md, 4회 검증됨)을 그대로. peak 도출은 `peakStageTarget`(이미 `load_gen_saturated` 곡선 유효목표[`insights.rs:229`]와 lockstep) 단일 소스(string-draft 입력).

---

## 4. 변경 상세

### 4.1 `ui/src/components/openLoopChecks.ts` (신규 순수 모듈) — 충족 R: R1, R2, R3, R4, R11
- `iterationTimeUpperBoundSeconds(steps: Step[], httpTimeoutSec: number): number` — 시나리오 트리 fold(R3), **중첩 컨테이너 재귀**(`loop.do`가 `if`를, `if.then`이 `loop`을 가질 수 있음 — model.ts 1-레벨 상호 중첩). http leaf=`(timeout_seconds ?? httpTimeoutSec)` + `(think_time?.max_ms ?? 0)/1000`; 순차=합; `loop`=`repeat × bound(do)`; `if`=`max(then, …elif.then, else)`; `parallel`=`max(branch.steps …)`. 미지 변형·http leaf 0이면 `0` 반환(→ R4에서 무경고).
- `openLoopWarnings(input): OpenLoopWarning[]` — 순수. 입력은 **string-draft 형태**(컴포넌트 state·`peakStageTarget`와 일치, F3):
  ```ts
  type OpenLoopInput = {
    loadModel: "closed" | "open"; rateMode: "fixed" | "curve";
    targetRps: string; maxInFlight: string;
    stages: { target: string; duration_seconds: string }[];
    workerCount?: string;          // string draft, 미설정/"" → 1
    httpTimeoutSeconds?: number;   // RunDialog http_timeout; undefined → ② skip
    scenario: Scenario | null;     // typed model; null → ② skip
    poolMode?: boolean;            // RunDialog pool.data?.pool_mode; true → 둘 다 skip (R13)
  };
  ```
  - open-loop(`loadModel==="open"`) 아니거나 **`poolMode === true`(R13)면 `[]`**.
  - `peak = peakStageTarget(stages)`(number|null), `W = Number(workerCount || "1")`.
  - **①**: `rateMode==="curve"` && `workerCount`/`setWorkerCount` 경로 && `peak != null` && `W > peak` → `{kind:"idle_workers", workers:W, peak, idle:W-peak}`.
  - **②**: `R = rateMode==="curve" ? peak : (targetRpsValid(Number(targetRps)) ? Number(targetRps) : null)`(F4 — `??` 금지; `targetRpsValid`는 G2로 `sizing.ts`서 export하고 **`number` 인자**를 받으므로 `Number(targetRps)` 변환 후 호출 — N1). 게이트: open && `scenario != null` && `httpTimeoutSeconds != null` && `W <= 1` && `R != null && R > 0`. `T = iterationTimeUpperBoundSeconds(scenario.steps, httpTimeoutSeconds)`; `T <= 0`이면 skip(R4). `M = Number(maxInFlight)`(유효 시); `M >= Math.ceil(R*T)` → `{kind:"inert_slots", maxInFlight:M, threshold:Math.ceil(R*T)}`.
- `OpenLoopWarning` discriminated union(`idle_workers | inert_slots`) + 수치 필드. leak-free 입력(`loadModel.ts`/`sizing.ts` 패턴).
- **`sizing.ts::targetRpsValid` export**(G2): 현재 private `function targetRpsValid`(`sizing.ts:18`)를 `export`로(trivial ui-only, R11 단일 소스 유지). 신규 module이 import.

### 4.2 `ui/src/components/LoadModelFields.tsx` — 충족 R: R1, R2, R5, R7, R8, R10, R12, R13
- **신규 optional prop 2개**: `httpTimeout?: number`(R12) + `poolMode?: boolean`(R13) — 둘 다 RunDialog가 전달; ScheduleForm은 미전달.
- open-loop arm에서 `openLoopWarnings({…})` 호출, 게이트 분리(R8): ① = `rateMode==="curve"` + `setWorkerCount`/`workerCount` 존재 + `poolMode !== true`; ② = `sizingScenario != null` + `httpTimeout != null` + `W <= 1` + `poolMode !== true`. 결과를 `role="status"` amber 힌트로 렌더(비차단 — R5).
  - ① 힌트는 **곡선 모드의** worker_count 접이식 disclosure 안(`rateMode==="curve"` 가드 — FR3: disclosure는 고정/곡선 공유라 가드 필수). ② 힌트는 max_in_flight 필드 옆.
  - ① 힌트에 "적용" 버튼 → `setWorkerCount(String(peak))`(R10).
- closed/closed+curve arm 미렌더(R7). `httpTimeout`/`poolMode` 외 신규 prop 0(`sizingScenario`/`sizingScenarioId`는 이미 존재).

### 4.3 `ui/src/components/RunDialog.tsx` — 충족 R: R12, R13
- `<LoadModelFields … httpTimeout={httpTimeout} poolMode={pool.data?.pool_mode}/>` 배선(이미 있는 `httpTimeout` state `RunDialog.tsx:100` + pool preview용 `pool` 쿼리 `RunDialog.tsx:543`). 그 외 무변경(제출 경로·over-capacity preview 등 0-diff).

### 4.4 `ui/src/i18n/ko.ts` — 충족 R: R9
- 신규 네임스페이스(예) `ko.openLoopCheck.idleWorkers(idle, peak)` / `ko.openLoopCheck.inertSlots` / 적용 버튼 라벨 / aria-label. ADR-0035.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·워커·proto·controller·migration·`schemas.ts`·CSV/XLSX export 0-diff**(R6). run 생성/조회/리포트 와이어 byte-identical.
- run 제출 페이로드 byte-identical — 경고는 표시-only, `buildProfile`/제출 경로 무접촉.
- **`ScheduleForm.tsx` 0-diff**(R6/R12) — 새 optional `httpTimeout`·sizing prop 미전달이라 두 경고 모두 미발생(표면 RunDialog 전용 — R8).
- 편집 파일은 `openLoopChecks.ts`(신규)·`LoadModelFields.tsx`·`RunDialog.tsx`(prop 2줄: httpTimeout·poolMode)·`sizing.ts`(`targetRpsValid` export 1줄 — G2)·`ko.ts` + 테스트뿐. RunDialog 제출/프리셋/409 가드·기존 사이징 헬퍼(`peakStageTarget`/`targetRpsValid` 로직 무변경, 가시성만 export)·capacity over-hint 무변경(독립 advisory).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1 | `openLoopChecks.test.ts`: 곡선 W>peak→경고(idle=W−peak)·W≤peak→없음·고정→없음 + `LoadModelFields` RTL | |
| R2 | unit: W≤1 && `M ≥ ceil(R×T)`→경고·미만→없음 (고정 R=target_rps·곡선 R=peak)·**W>1→없음** + RTL | |
| R3 | unit: T fold를 single/seq/loop(×repeat)/if(분기 max)/parallel(분기 max)/think + **nested(loop-in-if·if-in-loop)** 포함으로 검증 + 멀티스텝 과대추정 false-positive 0 가드 | |
| R4 | unit: scenario=null·파싱불가·http leaf 0(T=0) → R2 경고 없음 | |
| R5 | RTL: 경고 표시 상태에서도 Run 버튼 활성·submit 정상 | |
| R6 | `git diff --name-only`=ui/(+docs)만; RTL로 제출 payload 불변 단언; ScheduleForm 미수정 | |
| R7 | RTL `it.each`: closed·closed+curve 미렌더·①은 고정 미렌더 | |
| R8 | RTL `it.each`: `sizingScenario`/`httpTimeout`/worker_count prop 부재·W>1 시 해당 경고 미렌더(ScheduleForm 대리) | |
| R9 | grep 잔존 영어 0 / 코드리뷰 | |
| R10 | RTL: ① "적용" 클릭 → `setWorkerCount("<peak>")` 호출 | |
| R11 | 코드: `peakStageTarget` 재사용(독립 max 없음) | |
| R12 | RTL: `httpTimeout` prop 부재 시 ② 미렌더(ScheduleForm 시나리오) | |
| R13 | unit: `poolMode:true`→`openLoopWarnings` `[]`(① 곡선 W>peak·② inert 둘 다 충족 입력서도) + RTL: `poolMode={true}` → 두 경고 미렌더 | |

- **라이브 검증: WAIVED**(spec 근거). `schemas.ts` 0-diff·run-create/report-parse·엔진 경로 무관이라 S-D 갭(서버 `null`↔Zod)이 **구조적으로 부재**. 경고는 순수 클라 advisory(표시-only)라 RTL이 결정적으로 커버. (최종 리뷰가 동의하면 build-log에 waive 근거 기록.)

---

## 7. 의도적 연기 (roadmap §A9에 누적)

- **② under fan-out(`worker_count > 1`), 그리고 두 경고 모두 pool 모드**: 정수 분할(`shard_split`/`proportional_split_min1`)·dispatch-시점 pool 구성 때문에 per-worker drop-불가를 집계 검사로 엄밀히 증명 못 함(insight 4·G1). 비-pool 단일 워커로 스코프해 false-positive 0 보장(R2/R13); pool 모드는 worker_count가 무시돼 ①(idle-worker 카운트)·②(per-worker 분할 미지) 둘 다 create-time 결정 불가라 suppress. fan-out/pool inert·idle 검사는 별도 슬라이스(per-worker 분할 증명 또는 margin·pool 구성 fetch 필요).
- **drop-위험 넛지**(max_in_flight가 target_rps에 비해 작아 drop 위험): 지연 *측정* 필요(결정적 아님) → SlotSizingHelper(사전)·`load_gen_saturated`(사후)가 이미 담당.
- **사후 insight 버전**(achieved_rps≪target_rps인데 dropped==0 등): create-time이 아니라 측정 데이터 기반 → 별도 슬라이스.
- **ScheduleForm 표면**: 사이징 헬퍼와 동일하게 RunDialog 전용으로 시작. 필요 시 scenario/httpTimeout/게이트 prop을 ScheduleForm에도 전달하는 후속.
- **②의 "적용"(max_in_flight 자동 하향)**: 높은 max_in_flight는 무해하고 사용자가 의도적으로 유지할 수 있어 단일 정답이 없음 → ②는 교육용 메시지-only.
- **기타 결정적 구조 경고**: 전수 검토 결과 max_in_flight=1 직렬화·단일워커 고RPS·redundant-with-fixed 곡선은 측정/임계값 필요하거나 노이즈라 제외.

---

## 8. 구현 순서 (plan 입력)

이 슬라이스는 `ui/`-only(cargo 게이트 무관)라 분할 제약이 작다. TDD 순서(ui/CLAUDE.md tdd-guard: **테스트 파일 먼저** pending RED diff). **R3 fold는 신규 로직**(이전 사이징 슬라이스가 "multi-step 슬롯-홀드"를 연기해 옴 — roadmap §B2'' §B9)이라 단위 테스트 매트릭스를 충분히(중첩 컨테이너 포함) 잡을 것.

1. **순수 모듈 + 단위 테스트**(R1–R4, R11, R13): `sizing.ts`에 `targetRpsValid` export(G2) → `__tests__/openLoopChecks.test.ts`(RED, 중첩 포함 매트릭스 + `poolMode:true`→`[]`) → `openLoopChecks.ts`. green 커밋.
2. **ko.ts 키 + LoadModelFields/RunDialog 배선 + RTL**(R1, R2, R5, R7, R8, R9, R10, R12, R13): `LoadModelFields.test.tsx`에 케이스 추가(RED) → `ko.ts` 키 → `LoadModelFields.tsx`(httpTimeout·poolMode prop·렌더·적용 버튼) + `RunDialog.tsx`(prop 2줄). green 커밋.
3. (필요 시) 게이트 락인 `it.each`(R7/R8) 보강. `pnpm lint && pnpm test && pnpm build` 전체 green 확인 후 finish.
