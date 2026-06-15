# 열린 루프 워커 수(worker_count) create-time 사이징 헬퍼 설계

- **날짜**: 2026-06-15
- **상태**: 설계 — 사용자 brainstorming 합의 완료(2026-06-15, 하이브리드 3-tier + HelpTip), spec-plan-reviewer 검토 대기
- **출처**: roadmap §B2'' / §A9 의도적 연기 — ADR-0038 §8 "create-time worker_count 사이징 헬퍼(prior-run 천장 → 권장 N을 RunDialog에서 미리; A9 사이징 헬퍼 4종 패턴 — v1은 사후 인사이트 `recommended_workers`로 갈음)". 방금 머지된 멀티워커 open-loop fan-out(ADR-0038)의 자연스러운 후속.
- **자매/선행 슬라이스**: A9 사이징 헬퍼 4종 — `2026-06-14-closed-loop-sizing-helper-design.md`(닫힌 VU 헬퍼, `recommendVus`/`pickLatestClosedRun`), `2026-06-14-open-loop-slot-sizing-helper-design.md`(open+fixed 슬롯, `recommendSlots`/`pickLatestOpenRun`/`SlotSizingHelper`), `2026-06-15-open-curve-slot-sizing-hint-design.md`(open+curve 슬롯, `peakStageTarget`). 이 슬라이스는 그 4종의 **컴포넌트 골격**(자족 헬퍼 + `sizing.ts` 순수 함수 + `LoadModelFields` optional-prop 게이팅 + `ko` 카탈로그 + 앵커 훅)을 그대로 재사용하되, **워커 차원이라 근본적으로 다른 한 가지** — 워커당 RPS 천장은 *포화(saturation) 시에만 관측*된다 — 를 하이브리드 3-tier로 다룬다.
- **연관 ADR**: ADR-0038(open-loop 멀티워커 fan-out·명시 `worker_count`·하드캡 64·사후 `recommended_workers`), ADR-0031(open-loop·`target_rps`/`stages`/`max_in_flight`/`dropped`·단일워커 v1), ADR-0027(계획된 fan-out·워커당 천장은 고정 상수 아님), ADR-0028(A4c/A9 insights `load_gen_saturated`), ADR-0035(한국어·`ko.ts`·초보자 친화). `docs/dev/capacity-planning.md`(§4 단일워커 함정·"단정 말고 측정").
- **ADR 신규 불필요**: 새 아키텍처 결정 없음. 순수 UI 슬라이스 — 엔진·워커·proto·migration·controller 무변경, run 생성 페이로드 byte-identical. 기존 엔드포인트(`GET /scenarios/{id}/runs`, `GET /runs/{id}/report`)·훅(`useScenarioRuns`/`useRunReport`)만 재사용.

---

## 1. 문제와 목표

RunDialog의 **열린 루프**(`loadModel === "open"`, 고정·곡선 둘 다)에는 ADR-0038로 **수평 확장 노브 `worker_count`**(접이식 고급 필드, disclosure 가드 `LoadModelFields.tsx:464`)가 생겼다. 단일 워커가 목표 도착률을 못 내면(`dropped > 0`) 워커를 늘려야 하는데, 초보 QA는 **"이 목표를 내려면 워커를 몇 대로 잡아야 하나"**를 모른다. 너무 낮게 잡으면 부하 생성기가 포화돼 멀쩡한 요청이 drop되고, 사후 `load_gen_saturated`(cause=capacity)가 `recommended_workers`로 권장 N을 알려준다 — 하지만 그건 **이미 한 번 over-run한 뒤**다.

이 슬라이스는 그 사후 권장을 **run을 돌리기 전(create-time)** RunDialog 폼 안에서, worker_count 입력칸 옆에 미리 답한다.

**근본 제약(설계의 핵심):** 다른 3종 헬퍼(VU·슬롯)는 *아무* 종료 run에서도 동작한다 — rps-per-VU·요청당 지연은 부하 수준과 무관한(rate-independent) 계수라서다. 그러나 **워커당 RPS 천장은 워커를 한계까지 밀었을 때(포화)만 관측된다.** ADR-0027/0038이 "워커당 RPS 천장은 지연·페이로드·대상 서버 종속이라 고정 상수가 아니다"를 명시하며 자동 N-유도를 기각한 바로 그 이유다. 비포화 prior run(워커 4대로 400 RPS, 드롭 0)은 "각 워커가 ≥100 RPS는 낸다"만 알려줄 뿐 천장이 100인지 5000인지는 모른다.

**목표(사용자 합의 — 하이브리드 3-tier, 2026-06-15):** 초보자가 *근거가 약해도* 안전하게 쓸 수 있도록 —
1. **근거가 있으면 항상 권장값을 제시**한다(포화 run = 강한 근거 = 정확 / 비포화 run = 약한 근거 = 보수적 상한).
2. **왜 정하기 어려운지를 평이하게 설명**한다(HelpTip — 천장이 포화 시에만 관측되는 이유).
3. **근거가 약하거나 없을 때도 다음 행동을 명확히** 한다(보수적 권장 + "포화시켜 측정" 안내 / 근거 없으면 "1대로 시작 → 드롭 보이면 리포트 권장값 따라 증설").

**비목표(연기):** §10. 요약 — prefer-latest-*포화*-run 앵커, per-stage 워커 분해, ScheduleForm 헬퍼, closed-loop worker override, 측정값 영속화.

---

## 2. 핵심 통찰 (설계의 근거)

1. **권장식 `N = ceil(target × prior_wc / peak)`는 포화 여부와 무관하게 *엔진 drop 측면에서 항상 안전*하다.** 각 워커에 배정되는 부하 `target/N = target/ceil(target×wc/peak) ≤ peak/wc` = 그 워커가 *이미 증명한* per-worker 속도 이하다(per-worker 부하는 워커끼리 독립이라 N을 줄여도 각 워커는 자기 몫만 생성). 즉 어떤 target·어떤 prior run에서도 "각 워커에게 증명된 속도 이하만 요구" → drop이 안 난다. **포화만이 그 값을 *최소(tight)*로 만든다**(`peak/wc` = 실제 천장). 비포화면 `peak/wc < 천장`이라 N은 안전하지만 *필요 이상*일 수 있다. → 하이브리드의 수학적 근거: 한 수식, 포화 여부로 *confidence 라벨만* 갈린다. **단, "안전(drop 없음)"은 엔진 실행 측면이고, *발사 검증(`validate_run_config`) 수용*은 별개다** — N이 폼의 `max_in_flight`·하드캡 64를 넘으면 400으로 거부되므로 UI가 cross-field 경고로 막는다(§7.3).

2. **사후 인사이트와 1:1 parity.** 사후 `load_gen_saturated`(cause=capacity)의 워커 추천(`crates/controller/src/insights.rs:246-253`)은 `peak = max(초별 step count 합)`(`insights.rs:214-222`, `by_sec`), `wc = worker_count_current`, `M = ceil(target / (peak/wc))`, `M > wc`일 때만 emit이다. 이 헬퍼의 `peakThroughput`이 `insights.rs:214-222`의 `by_sec`와 **같은 수식**(초별 count 합의 최대)이고 `recommendWorkers`가 `insights.rs:250` `((t)/(peak/wc)).ceil()`와 **같은 산술**이므로, 슬롯 헬퍼가 가진 "사전 권장 == 사후 인사이트" 불변식이 워커 차원에서도 성립한다(prior-run 경로 한정 값동치 — 미래 run의 실제 peak에 의존).

3. **앵커는 prior run 리포트의 *count 기반* `peak` — 슬롯/VU 헬퍼보다 더 견고하다.** 슬롯 헬퍼 앵커(`usePriorOpenRunAnchor`, `SlotSizingHelper.tsx:16-25`)는 `summary.p50_ms`(지연 기반)를 쓰는데 **localhost sub-ms run이면 `p50_ms==0`이라 앵커가 null**(engine CLAUDE.md). 이 헬퍼의 `peak`은 *요청 수* 기반(`report.windows[].count` 초별 합)이라 요청이 한 번이라도 났으면 `peak>0` → **localhost 빠른 run에서도 앵커가 산다.** `pickLatestOpenRun`(`sizing.ts:69-79`)으로 최근 종료 open-loop run을 고르고 `useRunReport`(슬롯 헬퍼가 쓰는 그 fetch)로 그 run의 `windows`(→peak)·`dropped`(tier 선택자)를, 리스트 Run에서 `profile.worker_count ?? 1`(→prior_wc)을 읽는다.

4. **target 도출은 슬롯 헬퍼와 동일.** worker_count는 open(고정·곡선) 전용이고 부하 목표는 **고정 = 폼 `target_rps`**, **곡선 = `peakStageTarget(stages)`**(`sizing.ts:86`, max_in_flight가 run 전체 단일값이듯 worker_count도 단일값 → 피크 단계 기준). 슬롯 헬퍼와 같은 source라 `LoadModelFields`가 이미 도출해 둔 값을 그대로 넘긴다(고정=`targetRps`, 곡선=`peakStr`). 곡선 문구 변형은 `peakBased` 플래그(슬롯 헬퍼 패턴).

5. **게이팅은 구조적으로 RunDialog open에만.** worker_count 입력 자체가 `LoadModelFields`에서 **`setWorkerCount` prop이 있을 때만 렌더**(RunDialog 전용, ScheduleForm 미전달 → 부재; `LoadModelFields.tsx:461` 주석). 슬롯 헬퍼와 동일하게 헬퍼는 **`onApplyWorkerCount && sizingScenarioId !== undefined`일 때만** 렌더하고, worker_count 접이식 disclosure(`workerOpen`, `LoadModelFields.tsx:89`)가 펼쳐졌을 때 그 안에 둔다 → ScheduleForm·closed·접힘 상태 모두 구조적 미렌더.

---

## 3. 범위

**In (이 슬라이스)**:
- 열린 루프(고정·곡선) `worker_count` 접이식 disclosure 안, 입력칸 바로 아래에 **워커 수 사이징 헬퍼** 렌더.
- **RunDialog에서만** 노출(§3.1 — `LoadModelFields`는 `ScheduleForm`과 공유).
- prior open-loop run 리포트에서 `peak`(초별 count 합 최대)·`dropped`(포화 여부)·prior_wc 도출 → 하이브리드 3-tier 권장.
- 권장 N = `ceil(target × prior_wc / peak)`, floor 1. "적용" 버튼으로 worker_count 입력칸 채움(상한 64 클램프).
- 곡선이면 target = stages 피크, 문구 변형(`peakBased`).
- "왜 정하기 어려운지" HelpTip + tier별 confidence 문구(`ko.ts`).

**Out (연기 → §10)**:
- **prefer-latest-*포화*-run 앵커** — v1은 최근 open-loop run 하나를 쓰고 그 run의 `dropped`로 tier를 라벨. 더 오래된 포화 run이 있어도 안 찾는다(freshness 우선).
- **test-run 측정 / 수동 추정 tier** — 무부하 단발 요청은 per-worker 천장을 못 드러내고, "워커당 RPS 천장을 추정"은 초보자가 못 하는 바로 그것 → 의도적 제외(슬롯/VU 헬퍼의 3계층과 다름, prior-run-only).
- **per-stage 워커 분해**, **ScheduleForm 슬롯/워커 헬퍼**, **closed-loop worker override**, **측정값 영속화**, **XLSX/CSV 열**.

**3.1 공유 컴포넌트 `LoadModelFields` 처리 (슬롯 헬퍼 게이팅 재사용)**
`LoadModelFields`는 `RunDialog.tsx`·`ScheduleForm.tsx` 둘 다 마운트한다. 슬롯 헬퍼가 확립한 게이팅을 그대로 따른다: **신규 optional prop `onApplyWorkerCount?: (n: number) => void` 1개 추가**. RunDialog는 `onApplyWorkerCount={(n)=>setWorkerCount(String(n))}` 전달, ScheduleForm 미전달 → 헬퍼 부재. 게이트는 슬롯 헬퍼가 이미 받는 `sizingScenarioId`(`!== undefined`)를 재사용한다(신규 게이트 prop 0). **워커 헬퍼 자신은 `sizingScenarioId`만 소비**(env 없음 — 측정 경로 부재).

---

## 4. 입력과 출처

**4.1 부하 목표 (폼에서 도출 — 읽기만)**
- 고정(open+fixed): `LoadModelFields`가 이미 슬롯 헬퍼에 넘기는 `targetRps`(폼 목표 RPS 문자열) 그대로.
- 곡선(open+curve): `peakStr = peakStageTarget(stages)`(슬롯 헬퍼와 동일 도출, 없으면 `""`). `peakBased=true`로 문구 변형.
- 헬퍼 내부는 `Number(targetRps)`로 파싱, `recommendWorkers` 무효 가드(`targetRpsValid`)가 부분 입력·범위 밖을 null로.
- **자체 입력칸 없음** — 전송 페이로드(`worker_count`+나머지)는 그대로.

**4.2 앵커 = 최근 종료 open-loop run 리포트 (무변경 fetch 재사용)**
| 항목 | 출처 | 비고 |
|---|---|---|
| `peak` (워커 N대 합산 초별 천장) | `report.windows`를 `ts_second`로 그룹, `Σcount`의 최대 | `insights.rs:214-222` `by_sec`와 1:1. count 기반 → `peak>0`이면 앵커 유효(localhost도 OK) |
| `dropped` (포화 여부) | `report.dropped` | `>0` → 강한 근거 tier, `==0` → 약한 근거 tier |
| `prior_wc` | 리스트 Run `profile.worker_count ?? 1` | 리포트 아님(리스트 Run에 이미 있음) |

- `pickLatestOpenRun`(`sizing.ts:69-79`)으로 run 선택 → `useRunReport(latest.id)`로 리포트 fetch(슬롯 헬퍼 `usePriorOpenRunAnchor`와 동일 fetch). prior run이 없으면 앵커 null → "근거 없음" tier(§7.4-C).
- 앵커 가드: `peak>0`(요청 0건 run 방지). `prior_wc>=1`(`?? 1` 폴백이라 항상 충족).

---

## 5. 권장 계산 (순수 함수)

`ui/src/components/sizing.ts`에 **순수 함수 2개 추가**. 기존 `targetRpsValid`/`recommendSlots`/`pickLatestOpenRun`/`peakStageTarget` 무변경.

**5.1 `peakThroughput(windows: { ts_second: number; count: number }[]): number`**
```
초별 합: by_sec[ts] += count   (insights.rs:214-216 by_sec와 동형)
반환: by_sec 비면 0, 아니면 max(by_sec.values())
```
- `report.windows`(`ReportWindowSchema`, `ts_second`+`count`, schemas.ts:220-231)를 받아 초별 throughput 천장. A3b가 워커별 윈도를 `(ts,step)`로 머지·count SUM해 둬서(`report.windows`는 머지 후, `report.rs:434-491` + 계약 테스트 `build_report_merges_worker_windows`) `Σcount`/초 = N워커 합산 초별 throughput → `peak` = 그 최대. `report.rs:616-621`의 stages-peak와는 무관(이건 *관측* throughput, 그건 *설정* 목표).
- **빈 배열→0 분기는 앵커의 `peak>0` 가드(§4.2) 뒤라 실제 도달 불가** — `insights.rs:218-222`는 빈 윈도에서 `summary.rps.round()` 폴백을 쓰지만, 이 헬퍼는 `peak>0`이 아니면 앵커 자체가 null이라 그 분기로 안 간다(무해한 분기 — 테스트 주석으로 명시).

**5.2 `recommendWorkers(target: number, priorPeak: number, priorWorkerCount: number): { recommendedWorkers: number } | null`**
```
무효(null): !targetRpsValid(target)  OR  !Number.isFinite(priorPeak) OR priorPeak <= 0
            OR !Number.isInteger(priorWorkerCount) OR priorWorkerCount < 1
유효: recommendedWorkers = max(1, ceil(target × priorWorkerCount / priorPeak))
```
- `targetRpsValid`(기존, 정수 1..=1,000,000) 재사용 → 슬롯/VU 헬퍼와 동일 목표 범위. `recommendWorkers`는 구조 타입만 받아 React/컴포넌트 의존 없음(`loadModel.ts` 순수 분리 철학).
- 결과 == `insights.rs:250` `((t as f64) / (peak/wc)).ceil()`. **상한/cross-field 클램프·경고는 함수가 아니라 컴포넌트가** 처리(슬롯 헬퍼가 raw `recommendedSlots`를 내고 `MAX_IN_FLIGHT_CAP` 경고만 띄우는 패턴) — raw N을 그대로 반환해 ">64"·"> max_in_flight" 경고/클램프를 UI 레이어에서(§7.3).
- **`m > wc` 발사 가드는 의도적으로 없다**: `insights.rs:251`은 *현재* worker_count와 비교해 `m > wc`일 때만 emit하지만(사후 = 기존 설정 대비 증설 제안), create-time엔 비교할 "현재"가 없으므로(처음부터 N을 고르는 중) 그 가드를 두지 않는다 — parity를 맞추려고 `m>wc`를 "복원"하면 안 됨.
- **알려진 한계(v1 수용)**:
  - ① 비포화 prior면 `peak/wc < 천장` → N 과대(엔진 drop 측면 안전하나 낭비) — confidence 문구가 "보수적 상한"으로 명시.
  - ② prior run scenario가 현재와 다르면(payload 변경 등) per-worker 천장이 어긋남 — "최근 run" 휴리스틱의 일반 한계(슬롯/VU 헬퍼 공유).
  - ③ 단일 prior 한 점 외삽 — multi-point fit은 비목표.
  - ④ **발사 검증 cross-field 제약**(`crates/controller/src/api/runs.rs:341-360`, `worker_count=w>1`일 때): **`max_in_flight >= w`**(고정·곡선 공통, runs.rs:346-349) + **고정모드 `target_rps >= w`**(runs.rs:353-359, 곡선 면제). drop 안전과 별개로 N이 이를 어기면 400 거부 → 컴포넌트가 cross-field 경고로 막는다(§7.3). `max_in_flight >= N`은 *현실적*(사용자가 max_in_flight를 작게 잡았거나 슬롯 헬퍼가 작게 권장한 경우 + 높은 target → 큰 N), `target_rps >= N`은 *퇴화적*(`N > target` ⟺ `peak < prior_wc` = run이 피크 초에도 워커당 <1 rps만 냄 — 거의 안 일어남)이라 v1은 max_in_flight 경고를 주 가드로, target_rps는 같은 경고문에 흡수.

---

## 6. 데이터 흐름

```
RunDialog (workerCount/setWorkerCount, loadModel, rateMode, targetRps/stages, env …)
  └─ <LoadModelFields …
        onApplyWorkerCount={(n)=>setWorkerCount(String(n))}    ← 신규 optional prop (RunDialog만)
        sizingScenarioId sizingEnv>                            ← 슬롯 헬퍼가 쓰는 그 prop 재사용
       (open 브랜치의 worker_count 접이식 disclosure `{workerOpen && …}` 안 —
        이 disclosure는 rateMode 분기 *이전*의 단일 공유 블록, LoadModelFields.tsx:464)
         <input worker_count … />                              ← 기존 입력(무변경)
         {onApplyWorkerCount && sizingScenarioId!==undefined && (
           <WorkerSizingHelper                                  ← 신규 자족 컴포넌트
             scenarioId={sizingScenarioId}
             targetRps={rateMode==="curve" ? peakStr : targetRps}
             peakBased={rateMode==="curve"}
             maxInFlight={maxInFlight}                          ← cross-field 경고용(§7.3)
             onApply={onApplyWorkerCount} /> )}
       (env prop 없음 — 측정 경로가 없어 슬롯 헬퍼와 달리 생략, YAGNI)
```
- `WorkerSizingHelper`는 자족 유닛: 자체 훅 `usePriorOpenRunWorkerAnchor`(co-located, 슬롯 헬퍼 `usePriorOpenRunAnchor` 미러)가 `pickLatestOpenRun` + `useRunReport`로 `{peak, dropped, priorWorkerCount}` 도출(없으면 null). `recommendWorkers`로 N 계산, tier 분기 렌더.
- **구조 주의 — 슬롯 헬퍼와 다르다**: `SlotSizingHelper`는 fixed/curve **각 arm에 따로** 렌더된다(`LoadModelFields.tsx:550`·`:562`, 고정=`targetRps`/곡선=`peakStr`). 워커 헬퍼는 worker_count disclosure가 rateMode 분기 *앞*의 **단일 공유 블록**(`LoadModelFields.tsx:464`)이라 **한 번만** 렌더하고 `rateMode` 삼항으로 target/peakBased를 고른다. 슬롯 헬퍼의 per-arm 패턴을 복붙하지 말 것. `targetRps`(prop)·`peakStr`(memo `:93`)·`rateMode`·`maxInFlight`(prop) 모두 그 지점에서 in-scope.
- rateMode 배타라 한 번에 한 모드만. closed±는 다른 브랜치 + worker_count disclosure 자체가 open 전용(`loadModel==="open"` 가드)이라 구조적 미렌더.

---

## 7. UX·동작

**7.1 위치·노출**: open 브랜치 worker_count 접이식 disclosure(`{workerOpen && …}`)가 펼쳐졌을 때, worker_count `<input>` **바로 아래**. 접힘/closed/ScheduleForm에선 미렌더(§2 항목 5). 컨테이너 스타일·HelpTip 배치·`<button type="button">`은 슬롯 헬퍼와 동일.

**7.2 하이브리드 3-tier** (A·B는 `N = recommendWorkers(target, peak, prior_wc).recommendedWorkers`; C는 앵커 null이라 N 미산출):

| tier | 트리거 | 동작 |
|---|---|---|
| **A. 강한 근거** | 앵커 있음 & `dropped > 0` | 권장 N(tight) + 적용. confidence="측정된 천장". `peak`·`prior_wc`·`dropped`·per-worker(`round(peak/wc)`) 표시. |
| **B. 약한 근거** | 앵커 있음 & `dropped == 0` | 권장 N(보수적 상한) + 적용. confidence="보수적 — 더 적어도 될 수 있음". "포화시켜 측정" 안내. |
| **C. 근거 없음** | 앵커 null(prior open-loop run 없음) | 권장값 없음. "1대로 시작 → 드롭 보이면 리포트 권장값 따라 증설" 안내. 적용 버튼 없음. |

**7.3 적용·상한·cross-field 경고**: "적용" → `onApply(min(N, 64))` → `setWorkerCount(String(...))`. 조용한 덮어쓰기 없음. 두 종류 **비차단 경고**(적용은 막지 않되 발사 400을 미리 안내):
- **하드캡 64 초과** (raw N > 64; validate_run_config / `schemas.ts:93` `.max(64)`): "권장 {N}대가 상한(64)을 넘어요 — 64대로도 목표에 못 미칠 수 있어요. 목표를 낮추거나 워커당 부하(payload·지연)를 점검하세요." 적용은 64를 채움(유효 최대값, 초보 안전).
- **max_in_flight 미달** (`maxInFlight` 유효 정수이고 적용값 `min(N,64) > Number(maxInFlight)`; runs.rs:346-349 `max_in_flight >= worker_count`): "worker_count는 max_in_flight 이하여야 해요 — max_in_flight도 최소 {min(N,64)}로 함께 올리세요(현재 {maxInFlight})." 이게 §5.2-④의 *현실적* cross-field 가드. (퇴화적 `target_rps >= N`은 N>target일 때만이라 별도 줄 없이 이 메시지에 흡수 — N이 max_in_flight도 넘는 게 보통.) `maxInFlight`가 비었거나 무효면 이 경고는 생략(폼 자체 maxInFlightInvalid가 담당).

**7.4 문구(`ko.ts` — ADR-0035, 캐주얼 `-요`체, 기존 `ko.slotSizing`/`ko.sizing` 톤 통일)**: 신규 `ko.workerSizing` 객체. 변수 치환 명사 뒤 조사는 **`(으)로`/`(은)는` 병기형**(ui/CLAUDE.md "사이징 권장" 함정 — `~6으로` 비문 회피), RTL 단언 정규식도 `\(으\)로` escape. 대표 키(초안):
- `title`: "워커 수 도우미", `helpLabel`/`help`(HelpTip): *"워커 한 대가 낼 수 있는 최대 RPS는 요청 지연·페이로드·대상 서버에 따라 달라 고정값이 없어요. 그래서 한 번 돌려 워커가 한계에 부딪힐 때(드롭 발생) 비로소 정확히 알 수 있어요."*
- A: `strongBasis(wc, peak, dropped)`: *"지난 run이 워커 {wc}대로 최대 {peak} RPS에서 요청이 밀렸어요(드롭 {dropped}) → 워커당 ~{round(peak/wc)} RPS가 한계예요."*, `recommend(n)`: *"목표엔 워커 ~{n}대가 필요해요."*(곡선이면 `recommendPeak`: "최고 단계 목표엔 …"), `apply`: "적용".
- B: `weakBasis(wc, peak)`: *"지난 run은 워커 {wc}대로 {peak} RPS를 드롭 없이 냈어요 — 한계까진 안 밀어서 워커당 진짜 천장은 아직 몰라요."*, `weakRecommend(n)`: *"보수적으로 ~{n}대를 제안해요(여유가 있었다면 더 적어도 됩니다)."*, `weakHint`: *"정확히 줄이려면 더 높은 목표로 한 번 돌려 드롭이 날 때까지 포화시켜 보세요."*
- C: `noBasis`: *"참고할 종료된 열린 루프 run이 없어요. 1대로 시작하고, 리포트에 드롭(밀린 요청)이 보이면 그 권장값만큼 늘리세요."*
- 경고: `overCap(n)`(하드캡 64) + `needMaxInFlight(n, cur)`(max_in_flight 미달) — 위 §7.3. `{n}`/`{cur}` 치환 명사 뒤 조사는 `(으)로` 병기형.

**7.5 재계산**: 사용자가 폼 target(고정 `targetRps` / 곡선 stage `target`)을 편집하면 헬퍼가 받는 `targetRps`/`peakStr`이 갱신 → `recommendWorkers` 즉시 재계산(자체 입력 state 없음 → 비동기 시드 race 가드 불요).

**7.6 접근성·일관성**: 슬롯 헬퍼와 동일 패턴 — 컨테이너 `rounded border bg-slate-50 p-3`, `<HelpTip>`, `<button type="button">`. 적용 버튼 라벨 명확, 경고는 `text-amber-700`.

---

## 8. 건드리는 곳 (UI-only)

**수정/신규**:
- `ui/src/components/sizing.ts` — `peakThroughput`·`recommendWorkers` 순수 함수 **추가**(기존 `targetRpsValid` 재사용). 타입(`WorkerSizingResult`) 가산. 기존 함수 무변경.
- `ui/src/components/WorkerSizingHelper.tsx` — **신규** 자족 컴포넌트 + co-located `usePriorOpenRunWorkerAnchor` 훅. props: `scenarioId`/`targetRps`/`peakBased?`/`maxInFlight`/`onApply`(슬롯 헬퍼 props 미러, 단 measure/estMs **및 `env` 없음** — 측정 경로 부재라 env 불요·`maxInFlight` 가산).
- `ui/src/components/LoadModelFields.tsx` — `onApplyWorkerCount?: (n:number)=>void` prop 추가. worker_count disclosure `{workerOpen && …}` 안 입력 아래에 `{onApplyWorkerCount && sizingScenarioId!==undefined && <WorkerSizingHelper targetRps={rateMode==="curve"?peakStr:targetRps} peakBased={rateMode==="curve"} maxInFlight={maxInFlight} … />}`. **단일 공유 블록**(disclosure가 rateMode 분기 앞·open 전용 = arm 무관하게 한 번만 — 슬롯 헬퍼 per-arm과 다름, §6). 신규 import 1개(`WorkerSizingHelper`; `peakStr`/`maxInFlight`/`rateMode`/`targetRps`는 기존 in-scope).
- `ui/src/components/RunDialog.tsx` — `<LoadModelFields … onApplyWorkerCount={(n)=>setWorkerCount(String(n))} />` 1줄 추가(`setWorkerCount`는 이미 있음, `RunDialog.tsx:79`).
- `ui/src/i18n/ko.ts` — `ko.workerSizing` 객체 **추가**(기존 키 무변경).

**무변경(명시)**:
- `ui/src/components/ScheduleForm.tsx`(무전달 → 헬퍼 부재), `sizing.ts`의 기존 함수, `schemas.ts`(worker_count `.max(64)` 이미 있음), 엔진·워커·proto·controller·migration·run 생성 페이로드. → 머지 diff는 **`ui/` 한정**.

---

## 9. 테스트 전략

- **순수 함수**(`sizing.test.ts`에 추가):
  - `peakThroughput`: 빈 배열→0; 단일 초→그 합; 다중 초(스텝 여러 행 같은 ts)→초별 합의 최대(평균/총합 아님 — `insights.rs` `by_sec`와 동형 검증, 두 번째 초가 peak인 케이스); 정렬 무관.
  - `recommendWorkers`: 기본 케이스(`ceil(target×wc/peak)`), floor 1(target 작음), 무효 가드(target 무효·peak≤0·NaN·Inf·wc<1→null), 경계.
  - **parity 락인**: 같은 `(target, peak, wc)`로 `recommendWorkers` == `insights.rs:250` 산술(`ceil(t/(peak/wc))`) — 슬롯 헬퍼 insight-동치 테스트와 동형(예: target 2000·peak 790·wc 2 → 6, ADR-0038 라이브 수치).
- **컴포넌트**(`WorkerSizingHelper.test.tsx` 신규): 3 tier 렌더 — (A) 앵커 mock `dropped>0` → 강한 문구 + 권장 N + 적용; (B) `dropped==0` → 보수적 문구 + "포화시켜" 안내 + 적용; (C) 앵커 null(prior run 없음) → "1대로 시작" + 적용 버튼 부재. 적용 클릭 → `onApply(min(N,64))`. raw N>64 → `overCap` 경고. **`min(N,64) > maxInFlight` → `needMaxInFlight` 경고**(cross-field, §7.3); maxInFlight 충분하면 미표시. `peakBased` → 곡선 문구. HelpTip 존재. 조사 병기 정규식 escape. (앵커 훅은 `vi.mock`으로 `useScenarioRuns`/`useRunReport` 스텁 — 슬롯 헬퍼 테스트 패턴.)
- **모드 분기**(`LoadModelFields.test.tsx` **갱신**): 신규 `it.each` 락인 — `onApplyWorkerCount`+`sizingScenarioId` 있고 worker_count disclosure 펼침 시 open+fixed·open+curve **렌더**; closed+fixed·closed+curve **미렌더**; `onApplyWorkerCount` 미전달(ScheduleForm) **미렌더**. 슬롯/VU 헬퍼 기존 락인(별개 testid)과 공존. 신규 헬퍼 testid는 `worker-sizing-helper`(슬롯 `slot-sizing-helper`·VU `sizing-helper`와 별개). **주의**: worker_count disclosure가 기본 접힘이라 렌더 단언 전 `workerOpen`을 펼치는 상호작용 필요(또는 시드된 `workerCount>1`로 자동 펼침 — `LoadModelFields.tsx:89`).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(`tsc -b` Zod-default 누출·discriminated union). 머지 전 인자 없는 전체 `pnpm test` 1회(S-D 함정 — `RunDialog`/`LoadModelFields` 외 파일 잠복 red 차단).
- **라이브(Playwright + `/live-verify`)**: RunDialog open+fixed worker_count disclosure 펼침에서 —
  - (a) **포화 prior run**(≥50ms responder로 over-run해 `dropped>0` 만든 시나리오) → 강한 tier + 권장 N(`ceil(target×wc/peak)`) + "측정된 천장" 문구 + 적용→worker_count 칸 반영. target 바꿔 재계산.
  - (b) **비포화 prior run**(드롭 0) → 보수적 tier + "포화시켜" 안내 + 적용.
  - (c) **prior run 없는 시나리오** → "1대로 시작" 안내 + 적용 버튼 부재.
  - (d) **곡선**: open+curve에서 stages 입력 → peak 기준 권장 + `peakBased` 문구.
  - (e) **수식 parity**: 헬퍼 권장 N으로 실제 run 생성 vs 부족하게 잡은 대조 run에서 사후 `load_gen_saturated.recommended_workers`가 **같은 수식**(`ceil(target×wc/peak)`)으로 나오는지 = 사전 권장==사후 인사이트(ADR-0038 라이브 "recommended_workers=6"의 create-time 확인). React controlled input은 native setter(루트 CLAUDE.md), click과 단언은 별도 evaluate, 콘솔 Zod 0.

---

## 10. 의도적 연기 (roadmap §A9/§B2''에 누적)

- **prefer-latest-*포화*-run 앵커** — v1은 최근 open-loop run 하나를 쓰고 그 `dropped`로 tier 라벨. 더 오래된 포화 run이 정확한 천장을 가졌어도 안 찾는다(freshness 우선·단순성). 가산 시: `pickLatestSaturatedOpenRun` + 폴백.
- **test-run 측정 / 수동 추정 tier** — 무부하 단발은 per-worker 천장을 못 드러냄 → prior-run-only 유지(슬롯/VU 헬퍼의 3계층과 의도적 비대칭).
- **multi-point fit / 회귀** — 여러 prior run에서 per-worker 천장을 추세로 — v1은 단일 점 외삽.
- **per-stage 워커 분해**(곡선 단계별 권장 N)·**ScheduleForm 슬롯/워커 헬퍼**·**closed-loop worker override 헬퍼**·**측정값 영속화**·**XLSX/CSV recommended_workers 열** — A9 사이징 헬퍼 4종 spec §10과 동일하게 연기.
