# 닫힌 루프 생성 시점 VU 사이징 헬퍼 설계

- **날짜**: 2026-06-14
- **상태**: 설계 — 사용자 brainstorming 합의 완료, spec-plan-reviewer 검토 대기
- **출처**: roadmap §A9 의도적 연기 2건 — "closed-loop `vus` 권장"(A9 `dropped` 트리거로는 발생 불가) + "create-time RunDialog 사이징 힌트". A9(완료)는 open-loop run이 *끝난 뒤* "슬롯이 ~N개 필요했다"를 말해줬다. 이 슬라이스는 그 **거울상** — closed-loop run을 *돌리기 전에* "VU를 ~N개로 잡으세요"를 RunDialog에서 미리 답한다.
- **연관 ADR**: ADR-0028(A4c/A9 insights·사이징 패턴 — 단, 이건 리포트가 아니라 RunDialog), ADR-0031(open-loop·`dropped`·단일워커), ADR-0035(한국어·`ko.ts`·초보자 친화), ADR-0026(test-run = ephemeral — 이 헬퍼가 재사용), ADR-0016(VU = tokio task per VU). `docs/dev/capacity-planning.md`(§3 Little's Law 수동 절차 = 이 슬라이스가 closed-loop 쪽으로 자동화).
- **ADR 신규 불필요**: 새 아키텍처 결정 없음. 순수 UI 슬라이스 — 엔진·워커·proto·migration·controller 무변경, run 생성 페이로드 byte-identical. 기존 엔드포인트(`/scenarios/{id}/runs`, `/report`, `/test-runs`, `/scenarios/{id}`)와 기존 훅(`useScenarioRuns`/`useRunReport`/`useTestRun`/`useScenario`)만 재사용.

---

## 1. 문제와 목표

RunDialog의 닫힌 루프 **균등 VU** 모드는 *VU 개수 + 지속시간*을 입력받는다. 그런데 초보 QA는 **"원하는 RPS를 내려면 VU를 몇 개로 잡아야 하나"**를 모른다. VU와 RPS의 관계(`RPS ≈ VU × (요청수/반복) / 반복지연`)를 손으로 풀어야 하고, 이건 `capacity-planning.md §3`의 Little's Law를 사람이 적용하는 절차다.

**목표**: 닫힌 루프 균등 VU 섹션에 작은 사이징 헬퍼를 둔다 —
1. 사용자가 **목표 RPS**를 입력하면,
2. 1회 반복의 **처리량(VU당 RPS)** 을 (가능하면) 실측에서 끌어와,
3. **권장 VU 개수**를 제시하고, "적용" 시 VU 입력칸을 채운다.

전부 초보자가 해석 가능한 평이한 한국어로, 그리고 **권장값이 하한(최소 출발점)임을 정직하게 명시**한다.

**비목표(연기)**: §10. 요약 — VU 곡선 모드 사이징, 열린 루프 create-time 슬롯 힌트, open-loop misconfig 경고, 측정값 영속화, "현재 VU N개 ≈ Y RPS" 역방향 라이브 리드아웃.

---

## 2. 핵심 통찰 (설계의 근거)

1. **이건 리포트 인사이트(A9)가 아니라 create-time UI다.** A9의 `dropped > 0` 트리거는 closed-loop에선 절대 발생하지 않아(`dropped`는 open-loop 전용) closed-loop 사이징을 못 한다. closed-loop는 "포화" 신호 자체가 없으므로, 사후가 아니라 **사전 계획 표면**(RunDialog)에서 사용자 입력(목표 RPS) + 실측 처리량으로 역산해야 한다.

2. **처리량 출처는 계층화 — 실측이 항상 추정보다 낫다.** 같은 시나리오의 **최근 종료 run**이 있으면 그 run이 이미 "VU N개 → M RPS"를 측정해 줬다. 이게 가장 신뢰할 수 있는 처리량 근거다(부하 시 실제 지연·요청수·think time가 전부 반영됨). 최근 run이 없을 때만 **test-run 1회**(무부하 단발)나 **사용자 추정치**로 떨어진다.

3. **최근 run 경로는 Little's Law가 선형 스케일로 약분된다.** closed-loop에서 `priorRPS = priorVUs × R / T`(R=반복당 요청수, T=반복지연). 목표를 만족하는 `targetVUs`는 `targetRPS = targetVUs × R / T`. 두 식을 나누면 **R·T가 소거**되어 `targetVUs = priorVUs × (targetRPS / priorRPS)`. 즉 "VU 50개로 200 RPS였으니 400 RPS면 100개" — 지연·요청수를 따로 알 필요 없이 **이전 run 비례**만 하면 된다. (정확하려면 prior run이 *closed-loop*여야 한다 — open-loop prior run은 `profile.vus == 0`이라 자연히 제외된다, §5.1.)

4. **test-run trace는 처리량을 직접 준다.** 기존 `POST /api/test-runs`가 반환하는 `ScenarioTrace`에 **`total_ms`(전체 1회 패스 wall-clock)** 와 스텝별 `latency_ms`가 이미 있다(`crates/engine/src/trace.rs:47,87`, UI `ScenarioTraceSchema` schemas.ts:442,466). 1회 패스의 요청 수 `R`은 trace의 *응답이 있는 스텝 수*로 센다. → `rpsPerVu = R / (total_ms/1000)`. **재구현 0** — `useTestRun` 훅·`ScenarioTraceSchema`·엔드포인트가 전부 C-2(영역 C)에서 이미 만들어져 있다.

5. **test-run은 무부하 단발이라 baseline — 권장값은 하한이다.** test-run은 부하 없이 1회만 돈다. 실제 부하에선 지연이 오르고 처리량이 떨어지므로, test-run 기반 권장 VU는 *과소* 추정될 수 있다(실제론 더 필요). 그래서 권장값은 항상 "**최소 ~N개부터**"로 제시하고, 측정 버튼 근처에 한계를 평이하게 박는다(§7.4). 최근 run 기반(통찰 3)은 실제 부하에서 나온 값이라 훨씬 현실적이다 — 같은 floor 정신이되 톤만 다르다(A9 spec §2 항목 3의 floor 프레이밍과 동류).

6. **저장하지 않는다 — test-run은 ephemeral 유지(ADR-0026).** 측정 지연을 시나리오나 별도 테이블에 영속화하면 (a) 새 백엔드/migration이 필요하고 (b) 시나리오·SUT가 바뀌면 stale이 된다. 헬퍼가 필요할 때마다 인라인으로 test-run을 호출(`useTestRun`)하면 항상 최신이고 백엔드 변경이 0이다. 목표 RPS·추정 지연 입력칸도 **임시 state**(다이얼로그를 닫으면 사라짐) — run 생성 페이로드(VU+duration)는 그대로다.

---

## 3. 범위

**In (v1)**:
- 닫힌 루프 **균등 VU**(`loadModel === "closed" && rateMode === "fixed"`) 모드에서만 헬퍼 렌더.
- **RunDialog에서만** 노출(아래 §3.1 — `LoadModelFields`는 `ScheduleForm`과 공유 컴포넌트라 무조건 렌더 금지).
- 목표 RPS → 권장 VU 역산, "적용" 버튼으로 VU 입력칸 채움.
- 처리량 출처 3계층: 최근 종료 closed-loop run → test-run 측정 → 사용자 추정 지연.

**Out (연기 → §10)**:
- **VU 곡선 모드**(`rateMode === "curve"`, vu_stages): 단계마다 목표가 달라 "단일 VU 권장"이 부적합. 헬퍼 미표시.
- **열린 루프**: target_rps가 이미 1차 입력이라 역산 방향이 다르다. create-time 슬롯 힌트("이 max_in_flight는 ~Y RPS에서 막힘")는 별도 슬라이스(roadmap §A9 연기).
- **스케줄 편집기(`ScheduleForm`)의 사이징 헬퍼** — `ScheduleForm`도 `scenarioId`/`parsedScenario`/`setVus`가 있어 의미는 있으나 env-resolve 배선·테스트 표면이 늘어 v1은 RunDialog 한정. §3.1 참조.
- "현재 VU N개 ≈ Y RPS" 역방향 라이브 리드아웃(사용자 결정: VU를 직접 만지면 보이는 값이라 표출 가치 약함 → 연기).

**3.1 공유 컴포넌트 `LoadModelFields` 처리 (필수 결정)**
`LoadModelFields`는 `RunDialog.tsx:487`과 `ScheduleForm.tsx:299` **둘 다** 마운트한다(다른 소비자 없음). 헬퍼를 closed+fixed arm에 무조건 렌더하면 스케줄 편집기에도 새어, `ScheduleForm`이 안 넘기는 `onApply` 등에서 깨지거나 untested 표면이 생긴다.
- **결정**: 헬퍼용 신규 prop(`scenarioId`/`scenario`/`resolvedEnv`/`onApply`)을 `LoadModelFields`에 **전부 optional**로 추가하고, 헬퍼는 **`onApply`(또는 `scenarioId`)가 주어졌을 때만** 렌더한다. RunDialog는 전달, `ScheduleForm`은 미전달 → 스케줄 편집기엔 헬퍼 부재.
- **락인 테스트**: `LoadModelFields.test.tsx`(prop 없으면 헬퍼 미렌더) + 가능하면 `ScheduleForm`이 닫힌+고정에서 헬퍼를 안 그리는지 단언.

---

## 4. 입력과 출처

**4.1 목표 RPS (사용자 입력, 임시)**
- 닫힌+고정 섹션 안의 임시 "목표 RPS" 입력칸. **프로필에 저장 안 됨** — VU 권장 계산 전용. 전송 페이로드는 기존대로 `vus`+`duration_seconds`만.
- 이 시나리오의 **최근 종료 closed-loop run이 달성한 RPS로 프리필**(수정 가능). run이 없으면 빈 칸으로 시작.

**4.2 처리량 = VU당 RPS(`rpsPerVu`) — 계층화 출처**
| 우선 | 출처 | rpsPerVu | 신뢰도 |
|---|---|---|---|
| 1 | 최근 종료 closed-loop run | `priorReport.summary.rps / priorRun.profile.vus` | 높음(실부하 실측) |
| 2 | test-run 1회 측정 | `R / (trace.total_ms/1000)`, R = trace의 응답 있는 스텝 수 | 중간(무부하 baseline → 하한) |
| 3 | 사용자 추정 지연 | `R / (estMs/1000)`, R = `flattenHttpSteps(scenario.steps).length`(정적 카운트) | 낮음(garbage-in) |

- 위 표의 "우선"은 **신뢰도 순위**(어느 출처가 더 믿을 만한가)지 *런타임 타이브레이크*가 아니다. **런타임 출처 선택 precedence**는: `prior`(1번, 최근 run 있으면 항상 채택 — 2·3번 UI 미노출) > **수동 추정 estMs 입력 시(3번 = 명시적 override)** > **측정(2번 = 편의 기본값)** > 없음. 즉 1번이 없을 때, 측정값이 있어도 사용자가 estMs를 직접 타이핑하면 그 수동값이 이긴다(명시 override가 편의 측정값보다 우선).
- 2번 test-run 버튼: 기존 `useTestRun`을 RunDialog가 가진 **선택 환경으로 resolve된 env**(submit과 동일 `resolveEnv`)와 `useScenario(scenarioId).data?.yaml`(API `Scenario`의 YAML 필드명은 `yaml` — run 객체의 `scenario_yaml`과 혼동 금지)을 test-run 요청의 `scenario_yaml`로 넘겨 호출. 결과는 **별도 `measured` basis**(요청수 `R`=trace 응답 스텝 수, 반복지연 `T`=`total_ms`)로 보관하고 "측정됨: 요청 R개 · Tms"로 **텍스트 표시**한다 — **estMs 입력칸을 덮어쓰지 않는다**(측정 R을 정확히 보존하려고 정적-R estMs 경로와 분리; §5.2 measured 경로의 reqPerIter=trace R 정확성 유지). estMs는 사용자가 직접 쓰는 수동 override 전용.
- **truncated 가드**: test-run `max_requests` 기본 50(`test_runs.rs:10`)이라 멀티스텝·loop 시나리오는 1회 패스를 다 못 돌고 잘릴 수 있다(`trace.truncated === true`). 잘린 trace의 `total_ms`·요청수는 *부분* 패스라 처리량이 왜곡된다 → **`trace.truncated`면 측정 경로를 거부**(measured basis 미생성)하고 "시나리오가 길어 측정이 잘렸어요 — 1회 반복 지연을 직접 입력하세요" 폴백 문구 + 3번(추정) 경로로 떨어진다.
- 3번 추정 지연: 사용자가 "1회 반복 예상 지연(ms)"을 직접 타이핑. 기본값 비움(힌트 문구만).

---

## 5. 권장 계산 (순수 함수)

신규 모듈(예: `ui/src/components/sizing.ts`)에 순수 함수로 분리해 단위 테스트한다. RunDialog/LoadModelFields는 이 함수를 호출만 한다(`loadModel.ts`의 `buildLoadProfile`/`loadModelErrors`와 같은 분리 철학).

**5.1 최근 run 앵커 도출** `usePriorClosedRunAnchor(scenarioId): { vus, rps } | null`
- `useScenarioRuns(scenarioId)`로 run 목록 → **`completed` 상태 + `profile.vus > 0`** run 중 `created_at` 최신 1건 선택.
  - **`vus > 0` 필터가 정확히 closed+fixed prior만 남기는 근거**: open-loop run(`target_rps`/`stages`)뿐 아니라 **closed+curve(vu_stages) run도 `profile.vus == 0`**을 저장한다(`loadModel.ts:54` build, `api/runs.rs:215` validate가 vu_stages면 `vus==0` 강제). 따라서 `vus > 0` 한 조건이 open-loop **과** VU-곡선을 **둘 다** 제외해, 단일-VU 권장의 앵커로 적합한 균등-VU run만 남긴다(`is_open_loop` 류 별도 검사 불필요). `failed`/`aborted` 종료 run은 RPS가 불안정해 `completed`만.
- **리포트 fetch는 무조건 호출되는 훅**: `useRunReport(latest?.id, terminal)`를 (id가 `undefined`일 수 있는 채로) 항상 호출한다(React 훅 규칙 — 조건부 호출 금지). `enabled: terminal && Boolean(id)`(hooks.ts:172)가 id 없을 때 쿼리를 비활성화. `terminal`은 후보가 `completed`라 `true` 상수. → `summary.rps`.
- 가드: `vus > 0 && rps > 0` 둘 다일 때만 `{ vus, rps }` 반환, 아니면 `null`. (run 목록·리포트 캐시는 `ScenarioRunsPage`와 React Query dedup.)

**5.2 권장식** `recommendVus(input): SizingResult | null`
```
입력: targetRps:number, 그리고 처리량 출처 중 하나
  - prior:   { kind:"prior",  priorVus, priorRps }
  - measured:{ kind:"measured", reqPerIter, iterMs }   // test-run
  - estimate:{ kind:"estimate", reqPerIter, iterMs }   // 사용자 추정
유효성: targetRps 정수 ≥ 1 (loadModelErrors 컨벤션과 동일 범위 1..=1_000_000)

rpsPerVu =
  prior    → priorRps / priorVus
  measured/estimate → reqPerIter / (iterMs / 1000)

가드: rpsPerVu > 0 이 아니면(0/NaN/Inf) → null (계산 불가, §7 폴백 문구)
recommendedVus = max(1, ceil(targetRps / rpsPerVu))
반환: { recommendedVus, rpsPerVu, basis: kind }   // reqPerIter/iterMs는 컴포넌트가 별도 보관, 결과에 불필요
```
- measured 경로의 `reqPerIter`는 `trace.steps.filter(s => s.response !== null).length`(응답 있는 스텝 수, `StepTrace.response`는 `.nullable()` schemas.ts:457). `iterMs = trace.total_ms`. **단 `trace.truncated`면 측정 거부**(§4.2 가드 — 부분 패스라 왜곡).
- `reqPerIter == 0`(요청 없는 시나리오) 또는 `iterMs == 0`(localhost sub-ms test-run — Slice 5 함정과 동류) → `rpsPerVu` 가드에 걸려 `null` → 헬퍼는 "측정값이 0이라 계산 불가, 직접 지연을 입력하세요" 폴백.
- **알려진 한계(v1 수용)**:
  - 최근 run 경로는 prior run의 부하 수준에서의 처리량을 그대로 비례시킨다. 목표가 prior보다 훨씬 크면 SUT 지연이 비선형으로 올라 실제 필요 VU가 더 많을 수 있다 → 여전히 하한.
  - **measured 경로는 `R`(요청 수)만 정확하고, *처리율(rate)* 은 무부하 baseline이다** — test-run은 부하 0 + think time 미적용(`apply_think_time` 기본 false, `test_runs.rs:28`)이라 `total_ms`가 실제 closed-loop run보다 빠르다(이중 낙관). 그래서 measured rpsPerVu는 *상한*(=권장 VU는 *하한*). 절대 "정확한 권장값"이라 표현하지 말 것 — "최소 출발점"(§7.4).
  - 추정 경로의 `reqPerIter` 정적 카운트(`flattenHttpSteps`)는 **loop·conditional을 정확히 반영 못 한다**(loop body는 1회만 셈 model.ts:263, 조건 분기는 양쪽 다 셈). measured 경로는 trace의 *실제* 실행 요청 수라 R이 정확. 둘 다 권장값은 하한.
  - **권장값 상한 없음**: `targetRps`가 매우 크고 `rpsPerVu`가 작으면 권장 VU가 워커 용량(`worker_capacity_vus`, 기본 2000 — 초과 시 서버가 run 생성을 400)을 넘을 수 있다. 깨지진 않지만(제안일 뿐, VU 입력칸 max 없음), 권장값이 비현실적으로 크면 "이 값은 워커 용량을 넘을 수 있어요" 안내를 곁들인다(§7.4, 비차단).

---

## 6. 데이터 흐름

```
ScenarioRunsPage (이미 useScenarioRuns 보유)
  └─ <RunDialog scenarioId scenario initial …>
       state: vus/setVus, loadModel, rateMode, selectedEnvId, envEntries …
       resolveEnv(baseVars, envEntries)  ← test-run env로 전달
       └─ <LoadModelFields …>  (closed+fixed arm)
            └─ <VuSizingHelper                       ← 신규 컴포넌트
                 scenarioId                           (prior-run/test-run fetch용)
                 scenario                             (reqPerIter 정적 카운트용)
                 resolvedEnv                          (test-run env)
                 onApply={(n) => setVus(n)} />        (적용 → VU 입력칸)
                 ├─ usePriorClosedRunAnchor(scenarioId)   → 프리필 + 1번 경로
                 ├─ useScenario(scenarioId)               → test-run용 scenario_yaml
                 ├─ useTestRun()                          → 2번 경로(측정)
                 └─ recommendVus(...)  (순수)             → 권장 VU
```
- 헬퍼는 **자족 유닛**: 자기 데이터(prior run/report/scenario yaml)를 기존 훅으로 직접 fetch(React Query dedup). RunDialog는 `scenarioId`/`scenario`/`resolvedEnv`/`onApply`만 내려준다(prop drill 최소, EnvironmentPicker가 base를 부모서 받는 패턴과 동형). `vus` 값 자체는 헬퍼에 안 넘긴다(역방향 리드아웃 연기 → 불필요).

---

## 7. UX·동작

**7.1 위치·노출**: `LoadModelFields`의 closed+fixed 분기에서 VU 입력칸 바로 아래. 다른 3모드(open±curve, closed+curve)에선 미렌더(`loadModelErrors`처럼 모드 분기). 선택적 보조 UI이므로 기존 RunDialog 레이아웃·필수 동선 클릭수 불변.

**7.2 프리필·재계산**:
- 최근 closed-loop run 앵커가 있으면 목표 RPS 칸을 그 run의 달성 RPS로 프리필(수정 가능) + 즉시 권장값 표시(목표==이전 RPS면 권장==이전 VU, 사용자가 목표를 올리면 비로소 의미 발생).
- 사용자가 목표 RPS를 바꾸면 권장값 즉시 재계산(`recommendVus` 순수 호출, 디바운스 불요 — 로컬 산술).
- **비동기 1회 시드 메커니즘(명시 — reseed-by-key는 sub-field에 부적용)**: 앵커는 *두 단계 비동기 fetch*(run 목록 → 리포트)라 마운트 후 늦게 도착한다. RunDialog의 reseed-by-key(=컴포넌트 remount)는 컴포넌트 단위라 헬퍼 내부 입력칸 하나에는 못 쓴다. 대신:
  - `targetRps` 입력은 **빈 문자열로 초기화**(`useState("")`), 사용자 편집 여부를 `touchedRef = useRef(false)`로 추적(onChange에서 `touchedRef.current = true`).
  - `useEffect([anchor])`: 앵커 쿼리가 success로 전이하고(`anchor != null`) **`touchedRef.current === false`(사용자가 아직 안 건드림)** 일 때만 `setTargetRps(String(anchor.rps))`를 **1회** 실행(추가 ref `seededRef`로 중복 시드 차단). 사용자가 먼저 입력했으면 시드 스킵 → 입력 덮어쓰기 race 봉쇄(ui/CLAUDE.md "effect로 reseed하면 사용자 편집 덮어쓰기 race" 함정의 정확한 회피형).
  - 락인 테스트: (a) 앵커 늦게 도착 + 사용자 무입력 → 시드됨, (b) 사용자가 먼저 타이핑 후 앵커 도착 → 사용자 값 보존(시드 스킵).

**7.3 적용**: 권장값은 **제안만**. "적용" 버튼을 눌러야 `onApply(recommendedVus)` → `setVus`로 VU 입력칸을 채운다(조용한 덮어쓰기 없음). 목표 RPS·추정 지연 칸은 임시(닫으면 소멸).

**7.4 한계 문구(초보자 친화, `ko.ts` 카탈로그 — ADR-0035)**:
- test-run 측정 버튼 근처(요청하신 핵심): *"방금 측정은 부하 없는 1회 실행이라 실제보다 빠릅니다. 부하가 걸리면 더 느려질 수 있어, 이 권장값은 **최소 출발점**입니다."*
- 최근 run 기반: *"지난 실행(VU {priorVus}개 → {priorRps} RPS) 기준 추정이에요."*
- 권장값 자체: *"권장 VU 최소 ~{n}개부터"* (floor 톤).
- 계산 표시(투명성): *"1회 반복: 요청 {R}개 · {ms}ms → VU당 약 {rpsPerVu} RPS"*.
- 변수 치환 명사 뒤 조사는 ko.ts 컨벤션대로 `(으)로`/`(은)는` 병기형(ui/CLAUDE.md "사이징 권장" 함정 — `~500로` 비문 회피).

**7.5 접근성·일관성**: 입력칸은 라벨 연결, 버튼은 `<button type="button">`(폼 submit 방지). HelpTip 사용 시 `<legend>`/`<h3>` *안*에 넣지 않음(accname 오염 — ui/CLAUDE.md U1a/U3 함정). 선택적 섹션이면 ui-optional-sections-collapsible 선호를 따라 disclosure 고려(단 헬퍼는 모드-조건부라 항상 접힘일 필요는 없음 — 디자인 시 판단, 기본 노출이 자연스러움).

---

## 8. 건드리는 곳 (UI-only)

**신규**:
- `ui/src/components/sizing.ts` — `recommendVus`(순수) + 타입. 단위 테스트 대상.
- `ui/src/components/VuSizingHelper.tsx` — 프레젠테이션 + 자족 fetch(위 훅들) + `recommendVus` 호출.
- `usePriorClosedRunAnchor(scenarioId)` — `hooks.ts`(기존 `useScenarioRuns`+`useRunReport` 조합) 또는 헬퍼 내부 조합. 위치는 plan에서.
- `ko.ts` 신규 문구 네임스페이스(예: `ko.sizing.*`).

**수정**:
- `ui/src/components/LoadModelFields.tsx` — `Props` 타입에 **optional 4종 추가**: `sizingScenarioId?: string`·`sizingScenario?: Scenario | null`(**model `Scenario`** = `../scenario/model`, `steps` 보유 — `flattenHttpSteps`용; API `../api/schemas`의 `Scenario`(yaml만) 아님. RunDialog가 이미 model `Scenario`를 import·보유 RunDialog.tsx:13)·`sizingEnv?: Record<string,string>`·`onApplyVus?: (n: number) => void`. closed+fixed 분기에서 **`onApplyVus`가 주어졌을 때만** `<VuSizingHelper>` 렌더(§3.1 — 공유 컴포넌트 가드). 기존 prop·다른 모드 렌더 무변경.
- `ui/src/components/RunDialog.tsx` — `LoadModelFields` 호출부에 위 4 prop 전달(`scenarioId`·`scenario`·`resolveEnv(baseVars, envEntries)` 결과·`setVus`). 페이로드 빌드(`buildLoadProfile`)·검증(`loadModelErrors`)·제출 경로는 **무변경**.
- `ui/src/components/ScheduleForm.tsx` — **무변경**(4 prop 미전달 → 스케줄 편집기엔 헬퍼 부재, §3.1). 회귀 방지 단언만 추가 가능.

**재사용(무변경)**: `useTestRun`/`ScenarioTraceSchema`/`api.createTestRun`(C-2), `useScenarioRuns`/`useRunReport`/`useScenario`, `ReportSummarySchema.rps`, `flattenHttpSteps`(scenario/model.ts), `resolveEnv`(B-2).

**무변경(명시)**: 엔진·워커·proto·controller·migration·Zod 와이어 스키마·run 생성 페이로드. → 이 슬라이스 머지 diff는 **`ui/` 한정**.

---

## 9. 테스트 전략

- **순수 함수**(`sizing.test.ts`): `recommendVus` — 3 basis × 경계(targetRps 1/최대, rpsPerVu 0·NaN·Inf 가드 → null, ceil/min(1), reqPerIter 0, iterMs 0). prior 선형 스케일(50→200, target 400 → 100) 정확값 락인.
- **컴포넌트**(`VuSizingHelper.test.tsx`): 앵커 있음 → 프리필+권장 표시 / 앵커 없음 → 추정·측정 UI 노출 / "적용" → `onApply` 호출 / test-run 버튼 → `useTestRun` 호출 후 측정 텍스트("요청 R개 · Tms") + 권장값 렌더(estMs 칸 미변경, mock) / truncated → 측정 거부 문구 / 한계 문구 렌더(조사 병기 정규식 — `\(으\)로` escape) / 폴백(계산 불가) 문구. React Query/Zustand mock은 기존 RunDialog 테스트 패턴.
- **모드 분기**(LoadModelFields.test.tsx): closed+fixed에서만 헬퍼 렌더, 나머지 3모드 미렌더 락인(`loadModel.ts` 불변식 테스트 정신).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(`tsc -b` Zod-default 누출·discriminated union 함정). 머지 전 인자 없는 전체 `pnpm test` 1회(S-D 함정).
- **라이브(Playwright)**: closed+fixed RunDialog에서 (a) 최근 run 있는 시나리오 → 목표 RPS 프리필·올림 → 권장 VU 변화·적용→VU칸 반영, (b) run 없는 시나리오 → test-run 측정 버튼→권장값+한계 문구, (c) run 생성이 기존대로 동작(페이로드 무변경)·콘솔 Zod 0. React controlled input은 native setter(ui 루트 CLAUDE.md), click과 단언은 별도 evaluate.

---

## 10. 의도적 연기 (roadmap §A9에 누적)

- **VU 곡선(vu_stages) 모드 사이징** — 단계별 피크 VU 권장. 단일 VU 모델이 안 맞아 별도.
- **열린 루프 create-time 슬롯 힌트** — "이 max_in_flight는 ~Y RPS에서 막힘"(지연 가정 필요). roadmap §A9 기존 연기 항목과 동일.
- **open-loop misconfig 경고**(큰 vus + target_rps 동시 → N>1 워커 복제 사고) — create-time 경고가 자연스럽지만 별도.
- **측정값 영속화** — §2 항목 6대로 v1은 ephemeral. 시나리오별 "마지막 측정 처리량" 저장은 새 백엔드 필요 → 별도.
- **역방향 라이브 리드아웃**("현재 VU N개 ≈ Y RPS") — 사용자 결정으로 연기.
- **스케줄 편집기(`ScheduleForm`) 사이징 헬퍼** — `LoadModelFields` 공유라 optional prop만 안 넘기면 부재(§3.1). 스케줄에도 의미는 있어 후속에서 `ScheduleForm`이 env-resolve·`onApplyVus`를 배선하면 자연 확장.
- **reqPerIter 제어흐름 정밀화** — loop 반복수·조건 확률을 반영한 정확 요청수(현재 test-run 실측이 흡수, 정적 카운트는 근사).
