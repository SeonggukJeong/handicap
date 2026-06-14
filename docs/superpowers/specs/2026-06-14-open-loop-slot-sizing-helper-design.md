# 열린 루프 생성 시점 슬롯(max_in_flight) 사이징 힌트 설계

- **날짜**: 2026-06-14
- **상태**: 설계 — 사용자 brainstorming 합의 완료, spec-plan-reviewer 검토 대기
- **출처**: roadmap §A9 의도적 연기 — "열린 루프 create-time 슬롯 힌트"(닫힌 루프 사이징 헬퍼 spec §10 + capacity-sizing spec 연기 목록). A9(완료)는 open-loop run이 *끝난 뒤* `dropped>0`이면 `load_gen_saturated` 인사이트로 "슬롯이 ~N개 필요했다(`required = ceil(target_rps × p50)`)"를 말해준다. 이 슬라이스는 그 **사전 거울상** — open-loop run을 *돌리기 전에* RunDialog에서 "max_in_flight를 ~N개로 잡으세요"를 미리 답한다.
- **자매 슬라이스**: `2026-06-14-closed-loop-sizing-helper-design.md`(닫힌 루프 VU 헬퍼). 이 spec은 그 패턴을 **열린 루프·슬롯·지연(latency) 방향**으로 미러링한다(닫힌 쪽은 처리량 방향). 두 헬퍼는 `sizing.ts`/`ko` 카탈로그/`LoadModelFields` optional-prop 게이팅을 공유한다.
- **연관 ADR**: ADR-0028(A4c/A9 insights·`derive_insights`·`load_gen_saturated` 사이징 — 단, 이건 리포트가 아니라 RunDialog), ADR-0031(open-loop·`target_rps`·`max_in_flight`·`dropped`·단일워커 v1), ADR-0035(한국어·`ko.ts`·초보자 친화), ADR-0026(test-run = ephemeral — 이 헬퍼가 재사용), ADR-0016(VU = tokio task per VU). `docs/dev/capacity-planning.md`(§3 Little's Law 수동 절차 = 이 슬라이스가 open-loop 쪽으로 자동화).
- **ADR 신규 불필요**: 새 아키텍처 결정 없음. 순수 UI 슬라이스 — 엔진·워커·proto·migration·controller 무변경, run 생성 페이로드 byte-identical. 기존 엔드포인트(`/scenarios/{id}/runs`, `/report`, `/test-runs`, `/scenarios/{id}`)와 기존 훅(`useScenarioRuns`/`useRunReport`/`useTestRun`/`useScenario`)만 재사용.

---

## 1. 문제와 목표

RunDialog의 **열린 루프 고정**(`loadModel === "open" && rateMode === "fixed"`) 모드는 *목표 RPS(`target_rps`) + 동시 요청 상한(`max_in_flight`)* 을 입력받는다. 그런데 초보 QA는 **"이 목표 RPS를 내려면 max_in_flight를 몇으로 잡아야 하나"**를 모른다. 너무 낮게 잡으면 슬롯이 모자라 멀쩡한 요청이 drop되고(=`dropped>0`), 리포트의 `load_gen_saturated`가 뜨면서 마치 SUT가 포화된 것처럼 보인다 — open-loop 사용자가 가장 자주 밟는 함정이다. 이걸 손으로 풀려면 `capacity-planning.md §3`의 Little's Law(`동시성 = 도착률 × 지연`)를 사람이 적용해야 한다.

**목표**: 열린 루프 고정 섹션에 작은 사이징 힌트를 둔다 —
1. 폼에 **이미 입력된 목표 RPS**(`targetRps`)를 읽어,
2. 1회 요청의 **지연(latency)** 을 (가능하면) 실측에서 끌어와,
3. **권장 max_in_flight**를 제시하고, "적용" 시 max_in_flight 입력칸을 채운다.

전부 초보자가 해석 가능한 평이한 한국어로, 그리고 **권장값이 하한(최소 출발점)임을 정직하게 명시**한다.

**비목표(연기)**: §10. 요약 — open+curve(stages) 모드 슬롯 힌트, open-loop misconfig 경고, 측정값 영속화, 역방향 라이브 리드아웃("이 max_in_flight ≈ 최대 Y RPS"), 스케줄 편집기 헬퍼, 다중-스텝 슬롯-홀드 정밀화.

---

## 2. 핵심 통찰 (설계의 근거)

1. **이건 사후 인사이트(A9)가 아니라 사전 create-time UI다.** A9의 `load_gen_saturated`는 run이 *끝나야* `dropped>0`을 보고 슬롯 부족을 알려준다. 하지만 슬롯을 너무 낮게 잡은 run은 *이미 drop이 발생한 뒤*다 — 시간·SUT 부하를 낭비하고서야 안다. 사전 RunDialog에서 같은 수식을 미리 적용하면 그 낭비를 없앤다.

2. **수식·지연 프록시를 post-hoc 인사이트와 일치시킨다 — 단, 불변식은 prior-run 경로 한정.** `load_gen_saturated`는 `required = ceil(target_rps × p50_ms/1000)`(지연 프록시 = `summary.p50_ms`)로 권장 슬롯을 계산한다(`crates/controller/src/insights.rs:222-227`). 이 헬퍼도 **정확히 같은 식 + 같은 프록시**를 쓴다. 그런데 사후 `required`는 *그 run이 실제로 낸* p50으로 계산되므로, 미래 run에 대한 "사전 == 사후" 동치는 어느 출처를 쓰든 *예측*일 수밖에 없다.
   - **prior-run 경로**(§4.2 1번, 지연 = 이전 open-loop run의 `summary.p50_ms`): 새 run이 이전과 비슷하게 거동하면 사전 권장값이 사후 `required`와 **일치**한다 — 이게 이 헬퍼의 신뢰 근거(사용자가 사전에 본 숫자 ≈ 사후 인사이트).
   - **measured/estimate 경로**(§4.2 2·3번, 지연 = 무부하 `total_ms/R` 또는 추정 ms): 부하 하 p50보다 작은 입력이라 **하한 추정**이지 사후값 보장이 아니다. UI 문구로 "최소 출발점"임을 명시(§7.4).
   - 따라서 "불변식"은 **수식·프록시가 동일**하다는 의미(어느 경로든 `recommendSlots`가 insight와 같은 산술을 수행)와, **prior-run 경로에서 대표성 있는 앵커일 때 사후값과 수렴**한다는 의미로 한정한다 — measured/estimate에 무조건 갖다 붙이지 않는다.

3. **지연 프록시 = 요청당 p50(insight와 동일).** insight가 `summary.p50_ms`(요청당 중앙값 지연)를 `L`로 쓰므로 이 헬퍼도 그대로 따른다. **단일-스텝 open-loop 시나리오**(가장 흔한 도착률 테스트 — 한 엔드포인트를 N rps로 때림)에선 슬롯-홀드 시간 = 요청 지연이라 정확하다. 다중-스텝에선 슬롯이 1회 반복 전체(`total_ms`) 동안 잡히므로 요청당 p50은 *과소* 추정이다 — 이건 post-hoc 인사이트와 **공유하는** v1 근사(§5.2 한계). 양쪽이 같은 프록시를 쓰므로 §2 항목 2의 "수식·프록시 일치"는 유지된다(정밀화는 §10 — 백엔드 동반).

4. **목표 RPS는 폼에 이미 있다 — 자체 입력칸 없음.** 닫힌 루프 헬퍼는 closed+fixed에 RPS 필드가 없어 자체 목표-RPS 입력칸을 둬야 했다(`VuSizingHelper.tsx:94`). 하지만 open+fixed는 `targetRps`가 1차 입력이다(`LoadModelFields.tsx:447`). 그래서 이 헬퍼는 그 값을 **읽기만** 하고 중복 입력칸을 만들지 않는다 — 닫힌 헬퍼보다 단순하다.

5. **지연 출처는 계층화 — 실측이 항상 추정보다 낫다.** 같은 시나리오의 **최근 종료 open-loop run**이 있으면 그 run의 `summary.p50_ms`가 이미 *실제 부하 하에서* 측정된 지연이다(가장 신뢰할 수 있는 근거 — 부하 하 지연이 곧 슬롯 사이징에 필요한 값). 없을 때만 **사용자 추정 지연**이나 **test-run 1회**(무부하 단발)로 떨어진다.

6. **저장하지 않는다 — test-run은 ephemeral 유지(ADR-0026).** 측정 지연을 영속화하면 (a) 새 백엔드/migration이 필요하고 (b) 시나리오·SUT가 바뀌면 stale이 된다. 헬퍼가 필요할 때마다 인라인으로 test-run을 호출(`useTestRun`)하면 항상 최신이고 백엔드 변경이 0이다. 추정 지연 입력칸도 **임시 state**(다이얼로그를 닫으면 사라짐) — run 생성 페이로드(`target_rps`+`max_in_flight`+`duration`)는 그대로다.

---

## 3. 범위

**In (v1)**:
- 열린 루프 **고정**(`loadModel === "open" && rateMode === "fixed"`) 모드에서만 힌트 렌더.
- **RunDialog에서만** 노출(§3.1 — `LoadModelFields`는 `ScheduleForm`과 공유 컴포넌트라 무조건 렌더 금지).
- 폼의 기존 `targetRps` → 권장 max_in_flight 산출, "적용" 버튼으로 max_in_flight 입력칸 채움.
- 지연 출처 3계층: 최근 종료 open-loop run p50 → 사용자 추정 지연 → test-run 측정.
- 권장값이 하드 상한(10,000)을 넘으면 비차단 경고(§7.4 — post-hoc `capacity` cause와 의미 연결).

**Out (연기 → §10)**:
- **open+curve(stages) 모드**: 단계마다 목표 RPS가 달라 "단일 슬롯 수 권장"은 피크 stage 기준으로만 의미 있다. v1 미표시(피크 기준 확장은 §10).
- **닫힌 루프**: 자매 슬라이스가 처리(VU 방향). 이 헬퍼는 open만.
- **open-loop misconfig 경고**(큰 `vus` + `target_rps` 동시 지정): UI는 open 모드에서 `vus` 필드를 아예 안 그리므로(§4.1) UI로는 도달 불가 — API-only 우려라 별도(§10).
- **역방향 라이브 리드아웃**("이 max_in_flight ≈ 최대 Y RPS") — 별도(§10).
- **스케줄 편집기(`ScheduleForm`)의 슬롯 헬퍼** — §3.1대로 optional prop 미전달로 부재.

**3.1 공유 컴포넌트 `LoadModelFields` 처리 (필수 결정)**
`LoadModelFields`는 `RunDialog.tsx`와 `ScheduleForm.tsx` **둘 다** 마운트한다(다른 소비자 없음). 힌트를 open+fixed arm에 무조건 렌더하면 스케줄 편집기에도 새어, `ScheduleForm`이 안 넘기는 prop에서 깨지거나 untested 표면이 생긴다.
- **결정**: 닫힌 헬퍼가 쓰는 **기존 게이팅을 그대로 재사용·확장**한다. `LoadModelFields`는 이미 `sizingScenarioId`/`sizingScenario`/`sizingEnv`/`onApplyVus`(전부 optional)를 받고 `onApplyVus`가 있을 때만 닫힌 헬퍼를 렌더한다(`LoadModelFields.tsx:397`). 여기에 **`onApplyMaxInFlight?: (n:number)=>void` 한 개를 추가**하고, open+fixed arm에서 **`onApplyMaxInFlight`가 주어졌을 때만** `<SlotSizingHelper>`를 렌더한다. RunDialog는 두 콜백(`onApplyVus`+`onApplyMaxInFlight`)을 모두 전달, `ScheduleForm`은 둘 다 미전달 → 스케줄 편집기엔 두 헬퍼 모두 부재.
- **공유 fetch prop 재사용**: `sizingScenarioId`/`sizingScenario`/`sizingEnv`는 닫힌 헬퍼가 이미 받는 그 prop을 슬롯 헬퍼도 함께 쓴다(중복 prop 추가 없음). 슬롯 헬퍼가 추가로 필요한 건 `onApplyMaxInFlight` 하나뿐.
- **락인 테스트**: `LoadModelFields.test.tsx`(open+fixed + `onApplyMaxInFlight` → 헬퍼 렌더 / prop 없으면 미렌더 / open+curve·closed 모드 미렌더).

---

## 4. 입력과 출처

**4.1 목표 RPS (폼의 기존 입력 — 읽기만)**
- open+fixed 섹션의 기존 `targetRps` 문자열 state(`LoadModelFields.tsx:23,452`). 헬퍼는 이걸 prop으로 받아 읽는다. **자체 입력칸·프리필 없음**(닫힌 헬퍼와의 핵심 차이 — §2 항목 4). 전송 페이로드는 기존대로.
- open 모드엔 `vus` 입력칸이 없다(`LoadModelFields.tsx:407-483`는 max_in_flight + target_rps/duration 또는 stages만 그림) → "큰 vus + target_rps" misconfig는 UI로 도달 불가(§3 Out).

**4.2 지연 = 요청당 latency(`latencyMs`) — 계층화 출처**
| 우선 | 출처 | latencyMs | 신뢰도 |
|---|---|---|---|
| 1 | 최근 종료 open-loop run | `priorReport.summary.p50_ms`(요청당 p50, 실부하) | 높음 |
| 2 | 사용자 추정 지연 | 사용자가 타이핑한 "예상 평균 응답시간(ms)" | 낮음(garbage-in) |
| 3 | test-run 1회 측정 | `trace.total_ms / R`(요청당 평균), R = trace의 응답 있는 스텝 수 | 중간(무부하 baseline → 하한) |

- **런타임 출처 선택 precedence**(닫힌 헬퍼 `VuSizingHelper.tsx:71-77`와 동형): `prior`(1번, 최근 open-loop run 있으면 항상 채택 — 2·3번 UI 미노출) > **수동 추정 estMs 입력 시(2번 = 명시적 override)** > **측정(3번 = 편의 기본값)** > 없음. 즉 앵커가 없을 때, 측정값이 있어도 사용자가 estMs를 직접 타이핑하면 그 수동값이 이긴다.
- **신뢰도 표(1>3>2) vs precedence(prior>estimate>measured)가 다른 이유**: 신뢰도는 "어느 출처가 더 정확한가"(실측>측정>garbage)지만, 런타임 precedence는 닫힌 헬퍼와 같은 UX 규칙 — **사용자가 굳이 추정치를 타이핑했으면 그 명시 의도를 무부하 편의 측정보다 존중**한다. 두 표가 충돌처럼 보이지만 역할이 다르다.
- **3번 test-run 버튼**: 기존 `useTestRun`을 RunDialog가 가진 **선택 환경으로 resolve된 env**(`sizingEnv`, submit과 동일 `resolveEnv`)와 `useScenario(scenarioId).data?.yaml`(API `Scenario`의 YAML 필드명은 `yaml` — run 객체의 `scenario_yaml`과 혼동 금지)을 `scenario_yaml`로 넘겨 호출. 결과의 요청당 지연 = `total_ms / R`(R = 응답 있는 스텝 수)로 보관하고 "측정됨: 요청 R개 · 평균 Lms"로 텍스트 표시.
- **truncated 가드**: test-run `max_requests` 기본 50(`test_runs.rs`)이라 멀티스텝·loop 시나리오는 잘릴 수 있다(`trace.truncated === true`). 잘린 trace의 `total_ms`·요청수는 *부분* 패스라 지연이 왜곡된다 → **`trace.truncated`면 측정 경로를 거부**하고 "시나리오가 길어 측정이 잘렸어요 — 예상 응답시간을 직접 입력하세요" 폴백 + 2번(추정) 경로.

---

## 5. 권장 계산 (순수 함수)

기존 `ui/src/components/sizing.ts`(닫힌 헬퍼의 `recommendVus`/`pickLatestClosedRun`이 사는 곳)에 슬롯용 순수 함수를 **나란히 추가**한다. 컴포넌트는 호출만 한다(`loadModel.ts`의 분리 철학).

**5.1 최근 open-loop run 앵커 도출** `usePriorOpenRunAnchor(scenarioId): { p50Ms } | null`
- `useScenarioRuns(scenarioId)`로 run 목록 → **`completed` 상태 + open-loop** run 중 `created_at` 최신 1건 선택(`pickLatestOpenRun` 순수 함수).
  - **open-loop 판별 = `is_open_loop` 양성 식**: `r.profile.target_rps != null || (r.profile.stages != null && r.profile.stages.length > 0)` — 컨트롤러 `Profile::is_open_loop()`(`crates/controller/src/store/runs.rs:149-151` = `target_rps.is_some() || !stages.is_empty()`)와 1:1. **`max_in_flight != null`을 판별자로 쓰면 안 됨**(spec-plan-reviewer must-fix): closed+fixed 분기(`api/runs.rs:319`)는 stray `max_in_flight`를 거부하지 않고 `Profile`은 `max_in_flight`를 `skip_serializing_if` 없이 직렬화(`store/runs.rs:131-132`)하므로, curl/preset으로 만든 closed 런이 `max_in_flight`를 달고 persist될 수 있다(UI `buildLoadProfile` closed arm은 안 보내지만 `loadModel.ts`, 비-UI 경로는 가능). 양성 식은 closed+fixed(`vus>0`)·VU곡선(`vu_stages`, `target_rps`/`stages` 부재)을 모두 제외해 도착률-부하 지연을 가진 open-loop(open+fixed·open+curve)만 남긴다 — 닫힌 헬퍼의 `vus>0` **양성** 필터(`sizing.ts:43`)와 대칭(둘 다 "있어야 할 것"으로 판별, "없어야 할 것"의 부재로 판별하지 않음). `failed`/`aborted`는 지연이 불안정해 `completed`만.
  - open+curve prior도 앵커로 유효: stages 런의 `summary.p50_ms`도 부하 하 요청당 p50 집계라 대표 지연으로 쓸 수 있다(피크 stage 권장은 §10, 앵커 *지연* 사용은 무관).
- **리포트 fetch는 무조건 호출되는 훅**: `useRunReport(latest?.id, terminal)`를 (id가 `undefined`일 수 있는 채로) 항상 호출(React 훅 규칙). `enabled: terminal && Boolean(id)`(hooks.ts)가 id 없을 때 비활성화. `terminal`은 후보가 `completed`라 `true` 상수. → `summary.p50_ms`.
- 가드: `p50_ms > 0`일 때만 `{ p50Ms }` 반환, 아니면 `null`(localhost sub-ms run은 p50=0이라 앵커 무효 → 추정·측정 UI 노출, §2 항목 3). 닫힌 헬퍼의 `usePriorClosedRunAnchor`가 `useMemo`로 반환을 안정화하는 패턴(`VuSizingHelper.tsx:18-29`)을 그대로 미러.

**5.2 권장식** `recommendSlots(targetRps, latencyMs): SlotSizingResult | null`
```
입력: targetRps:number, latencyMs:number
유효성:
  - targetRps 정수 1..=1_000_000 (loadModelErrors/ insights와 동일 범위)
  - latencyMs 유한 & > 0  (아니면 null = 계산 불가, §7 폴백)
recommendedSlots = max(1, ceil(targetRps × latencyMs / 1000))   // = insights.rs:224 required
반환: { recommendedSlots }   // 순수 함수는 수식+가드만. basis·latencyMs는 컴포넌트가 보관(문구·계산표시용) — 닫힌 헬퍼의 `SizingResult.basis`가 미사용인 것과 동형(소비처가 src 존재 여부로 분기).
```
- 컴포넌트가 단일 `latencyMs`를 출처에서 도출해 `recommendSlots(targetRps, latencyMs)`에 넘긴다. 출처별 `latencyMs`:
  - prior: `summary.p50_ms`(정수, 요청당 p50).
  - estimate: 사용자 타이핑 ms(직접 = 요청당 지연, **R 불요**).
  - measured: `trace.total_ms / R`(R=`trace.steps.filter(s=>s.response!==null).length`, trace에서 직접). **`trace.truncated`면 measured 미생성**(§4.2 가드). `R==0`(요청 없는 시나리오)·`total_ms==0` → measured 미생성.
- **`scenario`(정적 step 트리) prop은 불요**: estimate는 직접 지연 입력, measured R은 trace에서 옴 — 닫힌 헬퍼가 `flattenHttpSteps`로 정적 R을 셌던 것(throughput 계산용)과 달리 슬롯 헬퍼는 정적 카운트가 필요 없다.
- **알려진 한계(v1 수용, post-hoc 인사이트와 공유)**:
  - **다중-스텝 과소추정**: 슬롯은 1회 반복 전체(`total_ms`) 동안 잡히는데 요청당 p50을 `L`로 쓰면 멀티스텝에서 필요 슬롯을 *과소* 추정한다. post-hoc `load_gen_saturated`도 같은 `summary.p50_ms` 프록시를 쓰므로(insights.rs:222) **양쪽이 같은 근사** — 불변식 유지, 단일-스텝은 정확. 정밀화(반복-홀드 시간 기반)는 §10.
  - **measured는 무부하 baseline**: test-run은 부하 0 + think time 미적용(`apply_think_time` 기본 false)이라 `total_ms`가 실제 부하보다 빠르다 → 지연 과소 → 권장 슬롯 *하한*. 절대 "정확한 권장값"이라 표현하지 말 것 — "최소 출발점"(§7.4).
  - **prior 부하 수준 의존**: prior run의 도착률에서 측정된 지연을 그대로 쓴다. 목표가 prior보다 훨씬 크면 SUT 지연이 비선형으로 올라 실제 필요 슬롯이 더 많을 수 있다 → 여전히 하한.
  - **권장값 상한**: `recommendedSlots > 10000`(validate_run_config의 하드 max 검사 `api/runs.rs:253` `m == 0 || m > 10_000`; UI Zod `schemas.ts:87` `.max(10_000)`)이면 적용해도 검증이 400으로 막는다. 깨지진 않지만(제안일 뿐) "단일 워커 슬롯 상한 초과 — 목표 RPS 하향 또는 워커 증설 필요" 비차단 경고를 곁들인다(§7.4, post-hoc `capacity` cause와 의미 연결).

---

## 6. 데이터 흐름

```
ScenarioRunsPage (이미 useScenarioRuns 보유)
  └─ <RunDialog scenarioId scenario initial …>
       state: targetRps/setTargetRps, maxInFlight/setMaxInFlight, loadModel, rateMode, env …
       resolveEnv(baseVars, envEntries)  ← 닫힌 헬퍼와 공유, test-run env로 전달
       └─ <LoadModelFields …>  (open+fixed arm)
            └─ <SlotSizingHelper                      ← 신규 컴포넌트 (scenario prop 없음, §5.2)
                 scenarioId                            (prior-run/test-run fetch용 = sizingScenarioId)
                 env                                   (test-run env = sizingEnv)
                 targetRps                             (폼의 기존 문자열, 읽기)
                 onApply={(n) => setMaxInFlight(String(n))} />  (적용 → max_in_flight 입력칸)
                 ├─ usePriorOpenRunAnchor(scenarioId)     → 1번 경로(p50)
                 ├─ useScenario(scenarioId)               → test-run용 scenario_yaml
                 ├─ useTestRun()                          → 3번 경로(측정)
                 └─ recommendSlots(targetRps, latencyMs)  (순수) → 권장 슬롯
```
- 헬퍼는 **자족 유닛**: 자기 데이터(prior run/report/scenario yaml)를 기존 훅으로 직접 fetch(React Query dedup). `LoadModelFields`는 이미 가진 `sizingScenarioId`/`sizingScenario`/`sizingEnv`와 새 `targetRps`·`onApplyMaxInFlight`만 내려준다.
- 닫힌 헬퍼(`VuSizingHelper`)와 슬롯 헬퍼(`SlotSizingHelper`)는 **서로 다른 모드 arm**에 렌더돼 동시에 뜨지 않는다(closed+fixed vs open+fixed) — 상호 간섭 없음.

---

## 7. UX·동작

**7.1 위치·노출**: `LoadModelFields`의 open+fixed 분기에서 target_rps/duration 그리드(+error) 바로 아래. 다른 3모드(closed±fixed/curve, open+curve)에선 미렌더. 선택적 보조 UI이므로 기존 RunDialog 레이아웃·필수 동선 클릭수 불변.

**7.2 재계산**:
- 폼의 `targetRps`가 채워지고 지연 출처가 있으면 즉시 권장값 표시(`recommendSlots` 순수 호출, 디바운스 불요 — 로컬 산술).
- 사용자가 `targetRps`를 바꾸면(폼 입력) 권장값 즉시 재계산. **이 헬퍼는 자체 입력 state가 (추정 지연 칸 외엔) 없어** 닫힌 헬퍼의 "비동기 1회 시드 race" 가드(`touchedRef`/`seededRef`)가 **불필요**하다 — `targetRps`는 폼이 소유하고, 앵커는 입력칸을 시드하지 않고 계산에만 쓰인다. (추정 지연 `estMs`는 사용자만 쓰는 단순 입력이라 시드 없음.)

**7.3 적용**: 권장값은 **제안만**. "적용" 버튼을 눌러야 `onApply(recommendedSlots)` → `setMaxInFlight(String(n))`로 max_in_flight 입력칸을 채운다(조용한 덮어쓰기 없음). 추정 지연 칸은 임시(닫으면 소멸).

**7.4 한계·안내 문구(초보자 친화, `ko.ts` 카탈로그 — ADR-0035)**:
- **문구 레지스터 = 캐주얼 `-요`** (시드 `ko.sizing` 카탈로그와 통일, `ko.ts:330-347` — 닫힌 헬퍼와 한 톤). 아래 예문/구현(plan `ko.slotSizing`)은 모두 `-요`체이며, plan의 `ko.slotSizing` 문자열이 권위(테스트가 그 문자열에 키잉).
- 권장값: *"max_in_flight를 최소 ~{n}(으)로 설정하세요"* (floor 톤). 슬롯을 낮게 잡으면 요청이 drop된다는 한 줄 안내 동반(open 모드 max_in_flight 필드의 기존 설명문과 톤 일치, `LoadModelFields.tsx:427`).
- prior 기반: *"지난 실행의 응답시간(p50 {p50}ms) 기준 추정이에요."*
- 측정 버튼 근처: *"방금 측정은 부하 없는 1회 실행이라 실제보다 빨라요. 부하가 걸리면 더 느려져 슬롯이 더 필요할 수 있어, 이 권장값은 **최소 출발점**이에요."*
- 계산 표시(투명성): *"목표 {targetRps} RPS × 지연 {L}ms ≈ 동시 {n}슬롯"*.
- 상한 초과 경고: *"권장값이 단일 워커 슬롯 상한(10,000)을 넘어요 — 목표 RPS를 낮추거나 워커를 늘려야 합니다."* (비차단; post-hoc `capacity` cause와 같은 의미.)
- 변수 치환 명사 뒤 조사는 ko.ts 컨벤션대로 `(으)로`/`(은)는` 병기형(ui/CLAUDE.md "사이징 권장" 함정 — `~500으로` 비문 회피).

**7.5 접근성·일관성**: 입력칸은 라벨 연결, 버튼은 `<button type="button">`(폼 submit 방지). HelpTip은 `<legend>`/heading *안*에 넣지 않음(accname 오염 — ui/CLAUDE.md U1a/U3 함정). 닫힌 헬퍼(`VuSizingHelper.tsx:88`)의 컨테이너 스타일(`mt-3 rounded border border-slate-200 bg-slate-50 p-3`)·HelpTip 배치를 그대로 미러해 두 헬퍼가 시각적으로 일관.

---

## 8. 건드리는 곳 (UI-only)

**신규**:
- `ui/src/components/sizing.ts`에 **추가**(기존 파일): `recommendSlots(targetRps, latencyMs)`(순수) + `pickLatestOpenRun(runs)`(순수) + 타입(`SlotSizingResult`). 단위 테스트 대상.
- `ui/src/components/SlotSizingHelper.tsx` — 프레젠테이션 + 자족 fetch(`usePriorOpenRunAnchor` co-located, `useScenario`/`useTestRun`) + `recommendSlots` 호출. `VuSizingHelper.tsx` 구조를 미러.
- `ko.ts` 신규 문구 네임스페이스(예: `ko.slotSizing.*`).

**수정**:
- `ui/src/components/LoadModelFields.tsx` — `Props`에 **`onApplyMaxInFlight?: (n:number)=>void` 1개 추가**(기존 `sizingScenarioId`/`sizingEnv`/`onApplyVus`는 재사용; `sizingScenario`는 닫힌 헬퍼 전용이라 슬롯 헬퍼엔 미전달). open+fixed 분기(`LoadModelFields.tsx:439-478`)의 target_rps/duration 그리드 아래에서 **`onApplyMaxInFlight && sizingScenarioId !== undefined`일 때만** `<SlotSizingHelper scenarioId env targetRps onApply>` 렌더(`targetRps` 폼 값 전달). 기존 닫힌 헬퍼 렌더·다른 모드 무변경.
- `ui/src/components/RunDialog.tsx` — `LoadModelFields` 호출부에 `onApplyMaxInFlight={(n)=>setMaxInFlight(String(n))}` 추가(나머지 sizing prop은 이미 전달 중). 페이로드 빌드(`buildLoadProfile`)·검증(`loadModelErrors`)·제출 경로 **무변경**.
- `ui/src/components/ScheduleForm.tsx` — **무변경**(`onApplyMaxInFlight` 미전달 → 스케줄 편집기엔 슬롯 헬퍼 부재, §3.1).

**재사용(무변경)**: `useTestRun`/`ScenarioTraceSchema`(C-2), `useScenarioRuns`/`useRunReport`/`useScenario`, `ReportSummarySchema.p50_ms`, `resolveEnv`(B-2). (`flattenHttpSteps`는 슬롯 헬퍼에선 미사용 — §5.2.)

**무변경(명시)**: 엔진·워커·proto·controller·migration·Zod 와이어 스키마·run 생성 페이로드. → 이 슬라이스 머지 diff는 **`ui/` 한정**.

---

## 9. 테스트 전략

- **순수 함수**(`sizing.test.ts`에 추가): `recommendSlots` — 경계(targetRps 1/최대/0/비정수 → null, latencyMs 0·음수·NaN·Inf → null, ceil/min(1)). 단일-스텝 정확값 락인(예: 1000 RPS × 50ms = 50슬롯; 200 RPS × 250ms = 50슬롯). insight 수식 동치 락인(같은 `(targetRps, p50)` 입력 → `recommendSlots`가 `insights.rs:224` `required`와 동일 산술). `pickLatestOpenRun` — **`is_open_loop` 양성 필터**(`target_rps != null || stages?.length`) + `completed`, `created_at` 최신, closed+fixed(stray `max_in_flight` 단 케이스 포함)·VU곡선(`vu_stages`)·비-completed 제외, 없으면 null.
- **컴포넌트**(`SlotSizingHelper.test.tsx`): 앵커 있음(p50 mock) → 권장 슬롯 표시 / 앵커 없음 → 추정·측정 UI 노출 / "적용" → `onApply(n)` 호출 / test-run 버튼 → `useTestRun` 호출 후 측정 텍스트 + 권장값 / truncated → 측정 거부 문구 + 추정 폴백 / 상한 초과(targetRps 큼) → 경고 문구 / 한계·계산 문구 렌더(조사 병기 정규식 — `\(으\)로` escape) / 폴백(계산 불가) 문구. React Query/Zustand mock은 기존 `VuSizingHelper.test.tsx` 패턴.
- **모드 분기**(`LoadModelFields.test.tsx`에 추가): open+fixed + `onApplyMaxInFlight` → 슬롯 헬퍼 렌더 / `onApplyMaxInFlight` 없으면 미렌더 / open+curve·closed 모드 미렌더 / 기존 닫힌 헬퍼 케이스 회귀 없음.
- **게이트**: `pnpm lint && pnpm test && pnpm build`(`tsc -b` Zod-default 누출·discriminated union 함정). 머지 전 인자 없는 전체 `pnpm test` 1회(S-D 함정).
- **라이브(Playwright + `/live-verify`)**: open+fixed RunDialog에서 (a) 최근 open-loop run 있는 시나리오 → p50 기반 권장 슬롯·`targetRps` 바꾸면 재계산·적용→max_in_flight칸 반영. **앵커 prior run은 반드시 ≥50ms 지연 responder(`/live-verify`의 지연 노브)로 만들 것** — localhost sub-ms run은 `p50_ms==0`이라 앵커가 null 반환(§5.1 가드)이라 prior-run 경로 대신 test-run 경로를 조용히 검증하게 된다(engine CLAUDE.md localhost sub-ms 함정). (b) run 없는 시나리오 → test-run 측정 버튼→권장값+한계 문구, (c) **권장 슬롯으로 실제 open-loop run 생성 → `dropped==0` 확인**(create-time 권장이 사후 포화를 막았는지 = 헬퍼의 핵심 가치 라이브 증명), (d) 일부러 권장보다 낮은 max_in_flight로 run → `load_gen_saturated`가 뜨고 그 `required`가 **같은 수식(`ceil(target×p50/1000)`)으로** 계산됨을 확인(헬퍼와 동일 산술 — 정확한 값 동치가 아니라 *수식 일치*; 새 run의 실제 p50이 앵커와 달라 값은 ±변동 가능). prior-run 앵커가 있으면 그 앵커의 권장값과 사후 `required`가 근접함도 같이 관찰. 콘솔 Zod 0. React controlled input은 native setter(ui 루트 CLAUDE.md), click과 단언은 별도 evaluate.

---

## 10. 의도적 연기 (roadmap §A9에 누적)

- **open+curve(stages) 모드 슬롯 힌트** — 피크 stage 목표(`max(stage.target)`) 기준 권장. 단일 목표가 아니라 v1 미표시.
- **open-loop misconfig 경고**(큰 `vus` + `target_rps` 동시) — UI 미도달(open 모드 vus 필드 없음), API-only 우려라 별도.
- **다중-스텝 슬롯-홀드 정밀화** — 요청당 p50 대신 1회 반복 홀드 시간(`total_ms`) 기반 정확 슬롯. post-hoc 인사이트도 함께 정밀화해야 불변식 유지 → 백엔드 동반 슬라이스.
- **측정값 영속화** — §2 항목 6대로 v1은 ephemeral. 시나리오별 "마지막 측정 지연" 저장은 새 백엔드 필요 → 별도.
- **역방향 라이브 리드아웃**("이 max_in_flight ≈ 최대 Y RPS") — 슬롯을 직접 만지면 보이는 값이라 표출 가치 약함 → 연기.
- **스케줄 편집기(`ScheduleForm`) 슬롯 헬퍼** — `onApplyMaxInFlight` 미전달로 부재(§3.1). 후속에서 env-resolve·콜백 배선하면 자연 확장.
- **XLSX/CSV에 recommended/cause 열**(capacity-sizing spec 연기와 동일) — export 표면은 별도.
