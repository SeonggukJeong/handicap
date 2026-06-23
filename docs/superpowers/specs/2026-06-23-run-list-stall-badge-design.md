# Run 목록 stall 배지 — 서버 신호 + 클라 계산 advisory 배지 (G1b 후속 — run 라이브니스 마무리)

> R-id 척추(§2)가 normative 코어. plan·구현·리뷰가 전부 이 ID를 참조한다.

- **날짜**: 2026-06-23
- **상태**: 설계 초안 → plan 대기
- **출처**: G1b(mid-run stall advisory) §12 연기 항목 "run 목록 배지 + 서버-계산 stall". G1b는 `RunDetailPage`만 다뤘고(순수 클라), 목록은 per-run 메트릭을 안 받아 와 백엔드 신호가 필요해 연기됐다. **왜 지금**: 사용자가 "run 라이브니스 마무리" 슬라이스로 선택(2026-06-23), 범위를 이 항목으로 좁힘(G2 = 별도 후속).
- **연관**: 선행 = `2026-06-23-run-stall-advisory-design.md`(G1b, `computeRunStall`/임계값 단일소스), `2026-06-23-run-progress-liveness-design.md`(G1a, A/B 자동fail). ADR-0009(라이브 대시보드 없음 — advisory 표면 제약), [[load-divergence-explain-confirm]](오탐≠자동fail).
- **ADR**: 신규 불필요. 기존 패턴 내 additive(읽기경로 DTO 필드 + UI 배지). G1b 철학(pure-client 판정, 백엔드는 raw 신호만 서빙) 그대로.

---

## 1. 문제와 목표

G1b는 running run의 진행 stall을 **상세 화면(`RunDetailPage`)** 에만 표면화했다 — 그 페이지는 메트릭 윈도(`useRunMetrics`)를 폴링해 `computeRunStall(run, windows, now)`로 순수 계산할 수 있었기 때문이다. **run 목록(`ScenarioRunsPage`)** 은 per-run 메트릭을 받아오지 않아(목록은 runs DTO만 fetch) 같은 판정을 못 한다. 그래서 QA가 가장 자주 보는 목록 화면에서는 "어느 run이 멈췄나"가 안 보이고, 상세로 들어가야만 G1b 배너를 본다.

이 슬라이스는 **목록의 각 running run 옆에 "⚠ 정지 의심" 배지**를 띄워 G1b advisory를 목록까지 확장한다. 신호는 서버가 **raw `last_metric_ts`**(마지막 메트릭 윈도의 wall-clock unix초)를 runs DTO에 실어 주고, 클라가 G1b의 임계값(`runStall.ts`)을 재사용해 판정한다(Approach A — 사용자 결정 2026-06-23).

- **목표**: 목록 running run에 startup·midrun stall 배지(advisory) — 임계값은 G1b와 **단일 소스**. 백엔드는 read-path DTO 필드 1개만 가산(engine/proto/migration 0).
- **비목표(연기)**: §7. 서버측 stall 계산(임계값 backend 이주=B2)·G2(k8s reaper)·배지에서 직접 중단 액션·think-time 도출 임계값.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | `RunResponse`(runs DTO)에 `last_metric_ts: Option<i64>` 필드를 가산 — **running run**이면 `MAX(ts_second)` (메트릭 0이면 None), **non-running**이면 항상 None. | store cargo test(R3 공유) + 라이브 `/api/scenarios/{id}/runs` JSON에 running=number·terminal=null (필드-세팅은 non-Default DTO라 컴파일러 강제) | ✅ wire: serde→UI Zod (R2와 짝) |
| R2 | UI `RunSchema.last_metric_ts`를 `z.number().int().nullish()`로 수용(서버 None→`null`). | `RunSchema.parse`가 실 응답(running 숫자·terminal null) 통과 — 라이브 throwaway Zod | ✅ wire: serde→UI Zod (R1과 짝) |
| R3 | store/metrics.rs에 stall 신호 쿼리 `last_metric_ts_by_scenario(scenario_id)`(running 서브쿼리로 좁힌 GROUP BY MAX(ts_second)) → `HashMap<run_id,last_ts>`. (단건용 단일 쿼리는 두지 않음 — FIX-3.) | cargo test: running 행=Some·terminal/메트릭0=맵 부재·여러 run 맵 | |
| R4 | `list_for_scenario`가 running run에만 `last_metric_ts`(맵 조회)를 채워 `to_response`로 전달; 단건 GET·run 생성 응답은 `None`(목록이 유일 소비처 — FIX-3). | store 쿼리 cargo test(R3) + 라이브 목록 응답(running=number·terminal=null; 필드-세팅은 `RunResponse` non-Default라 컴파일러 강제) | |
| R5 | `runStall.ts`에서 판정 코어 `classifyRunStall(status, startedMs, lastMetricTs: number\|null, nowMs)`를 추출 — startup/midrun 임계값(`STARTUP_STALL_MS`/`MIDRUN_STALL_MS`)·kind의 **단일 소스**. | 단위테스트(분기·경계) | |
| R6 | `computeRunStall`(상세, 시그니처 불변)은 `windows===undefined` 플래시가드 유지 후 `classifyRunStall(status, started, totalCount>0?maxTs:null, now)`로 위임 — **동작 byte-identical**. | 기존 G1b `runStall.test.ts`·`RunDetailPage.test.tsx` 무수정 green | |
| R7 | `ScenarioRunsPage`가 각 run에 `classifyRunStall(r.status, r.started_at ?? r.created_at, r.last_metric_ts ?? null, now)`로 판정해 `kind!=="none"`이면 Status 칼럼에 amber roleless "⚠ 정지 의심" 배지(startup+midrun 공통, `title`로 상세). | RTL: midrun/startup 출현·healthy/terminal 미출현 | |
| R8 | `useScenarioRuns`가 running run이 하나라도 있으면 목록을 주기 폴링(`refetchInterval`), 없으면 정지 — healthy run에 stall 오탐 0. | RTL/코드: `refetchInterval` predicate; 폴 간격 ≪ 120s 임계 | |
| R9 | advisory-only — run status·report·DB·engine/proto/migration 불변; non-running 응답은 `last_metric_ts: null` 필드 가산 외 byte-identical. | grep/리뷰: status 미변경·migration 0·proto 0 | |
| R10 | 신규 사용자노출 문구 전부 `ko.runStall.*` 카탈로그 경유(ADR-0035 단일소스=카탈로그-routing, *메시지 dedup 아님* — §4.7), 하드코딩 영어 0(`title`/`aria` 포함). | grep: 인라인 영어 0 | |

- **R1↔R2 = 한 계약의 양쪽**(serde 직렬화 ↔ UI Zod 수용) — plan에서 같은 계약-task로 묶거나 함께 머지(한쪽만=와이어 드리프트). 최종 `handicap-reviewer`가 1:1 대조.
- **R5↔R6 = parity/단일소스** — 임계값을 두 곳에 복제하지 않고 코어 하나로 상세+목록 공유.

---

## 3. 핵심 통찰 (설계 근거)

1. **`last_metric_ts`가 G1b `maxTs`와 의미적으로 동일** — 둘 다 "어떤 요청이든 완료된 마지막 wall-clock unix초"다. 엔진은 그 초에 요청이 완료될 때만 `MetricFlush`를 보내(`runner.rs` drain-non-empty 가드) `run_metrics` 행을 만든다. 따라서 `MAX(ts_second)`가 null인 것 ⇔ 메트릭 행 0 ⇔ G1b의 `totalCount===0`(startup). 서버가 `MAX(ts_second)`를 주면 클라는 G1b와 **정확히 같은 판정**을 한다(R1).
2. **Approach A(클라 계산)가 임계값 단일소스를 지킨다**(사용자 결정) — 서버가 boolean을 계산하면(B) 임계값이 backend 상수 + `runStall.ts` 두 곳으로 분화해 drift 위험 + backend 상수/CLI flag가 생긴다. 클라 계산은 backend를 raw 신호만 서빙하게 두고(byte-identical+필드 1개) `runStall.ts`를 단일 권위로 유지(R5). G1b가 확립한 "pure-client 판정, 백엔드 raw 서빙" 패턴의 연장.
3. **목록엔 "미로드" 상태가 없다 → 플래시가드 불요** — 상세 `computeRunStall`은 `windows===undefined`(첫 응답 전)에 배너 플래시를 막아야 했지만, 목록 row는 항상 로드된 상태로 렌더되고 `last_metric_ts`는 present(number)-or-null이다. 그래서 `classifyRunStall`은 `lastMetricTs: number|null`만 받고(null=메트릭 없음=startup 후보), 플래시가드는 상세 래퍼(`computeRunStall`)에만 남긴다(R6).
4. **폴링이 healthy *midrun* 오탐의 유일한 방어선**(R8) — `useScenarioRuns`는 현재 폴링하지 않아(invalidate 시에만 refetch) `last_metric_ts`가 frozen된다. healthy run은 서버에서 계속 메트릭을 내 `last_metric_ts`가 전진하지만, 목록의 cached 값은 frozen → `floor(now/1000)-cached`가 120s를 넘겨 **healthy run을 midrun으로 오발동**한다. running run이 있을 때만 짧은 주기(≪120s)로 폴링하면 cached `last_metric_ts`가 항상 신선(최대 폴간격만큼 stale, ≤5s)해 오탐이 구조적으로 불가능. stall run은 서버 `last_metric_ts`가 멈추므로 cached 값도 참값에 수렴 → `now` 전진이 임계를 정확히 넘김. (1s `useNow` tick은 폴 사이 침묵초를 매끄럽게 표시 — 기존 elapsed 칼럼이 이미 사용 중.)
   - **startup은 폴링과 무관**(FIX-1) — startup 판정은 *immutable* `started_at`(row에 고정·절대 stale 안 됨) vs *live* `now`(1s tick)이라, 목록이 안 폴링해도 정확하다. 폴 freshness 논거(위)는 **midrun 전용**(cached `last_metric_ts`가 frozen되는 경우). 즉 폴링은 midrun 오탐 방지용이고 startup 정확성엔 불필요.
5. **목록 배지는 kind 무관 단일 chip** — 상세는 G1b 배너가 startup/midrun 문구를 구분하지만, 목록 셀은 compact해야 하므로 둘 다 "⚠ 정지 의심" 한 chip + `title`(midrun=침묵초·startup=부하 시작 전)로 상세를 보조(R7). 색은 amber(상세 advisory 배너와 통일), role 없음(visible 텍스트가 의미 전달 — `StatusBadge`/LAN L6 stale 배지 컨벤션, `role="status"`는 로딩 스피너 전용).

---

## 4. 변경 상세

### 4.1 `crates/controller/src/store/metrics.rs` — 충족 R: R3
- `pub async fn last_metric_ts_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<HashMap<String,i64>>` = `SELECT run_id, MAX(ts_second) AS last_ts FROM run_metrics WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ? AND status = 'running') GROUP BY run_id`. 동적 IN-바인딩 회피(서브쿼리로 scenario+running 한정). running run이 0이거나 그 run의 메트릭이 0이면 맵에 부재(→ 핸들러가 None). `idx_metrics_run`(0001_initial.sql:34, `run_id` 선두)이 MAX를 인덱스-백.
- **단건 GET용 `last_metric_ts(run_id)` 단일 쿼리는 두지 않는다(FIX-3)** — 상세 화면(`RunDetailPage`)은 `useRunMetrics` 윈도로 stall을 자체 계산(G1b)해 `last_metric_ts`를 소비하지 않으므로, 단건 경로에 채우면 `useRun` 1s 폴마다 무소비 MAX 쿼리가 돈다. 목록이 유일 소비처.

### 4.2 `crates/controller/src/api/runs.rs` — 충족 R: R1, R4, R9
- `RunResponse`에 `pub last_metric_ts: Option<i64>` 가산(`skip_serializing_if` 없음 → None은 `null`로 항상 직렬화, R1).
- `to_response(r: runs::RunRow)`(`:1171`) → `to_response(r: runs::RunRow, last_metric_ts: Option<i64>)`. (DB 접근 없는 순수 매핑이라 값을 주입받는다.) 크레이트 내 유일 호출부 **3곳**: `create`(`:900`)·`get`(`:908`)·`list_for_scenario`(`:1133`) — 다른 `to_response`는 preset/env/schedule 동명이인.
- `list_for_scenario`(:1123): rows fetch 후 `metrics::last_metric_ts_by_scenario(db, scenario_id)` 1회 호출 → 맵. row마다 `let lt = if matches!(r.status, RunStatus::Running) { map.get(&r.id).copied() } else { None };` → `to_response(r, lt)`. (terminal/메트릭0=None — R4/R9.)
- `get`(단건, `:908`)·`create`(`:900`): `to_response(row, None)`(FIX-3 — 단건은 무소비라 None; 갓 만든 run은 메트릭 0이라도 None). running run의 단건 GET도 `last_metric_ts: null`을 반환하지만 무소비라 무해.

### 4.3 `ui/src/api/schemas.ts` — 충족 R: R2
- `RunSchema`에 `last_metric_ts: z.number().int().nullish()` 가산(서버 None→null; `verdict`/`message`와 동일 패턴, S-D 클래스).

### 4.4 `ui/src/api/runStall.ts` — 충족 R: R5, R6
- 판정 코어 추출:
  ```ts
  export function classifyRunStall(
    status: RunStatus, startedMs: number, lastMetricTs: number | null, nowMs: number,
  ): RunStall {
    if (status !== "running") return NONE;
    if (lastMetricTs === null) {
      return nowMs - startedMs > STARTUP_STALL_MS ? { kind: "startup", silentSeconds: 0 } : NONE;
    }
    const silence = Math.floor(nowMs / 1000) - lastMetricTs;
    return silence * 1000 > MIDRUN_STALL_MS ? { kind: "midrun", silentSeconds: silence } : NONE;
  }
  ```
- `computeRunStall`(시그니처·동작 불변)은 `windows===undefined→NONE` 가드 유지 후 `totalCount`/`maxTs`를 윈도에서 도출, `classifyRunStall(run.status, run.started_at ?? run.created_at, totalCount>0?maxTs:null, nowMs)` 위임. `STARTUP_STALL_MS`/`MIDRUN_STALL_MS`/`RunStall`/`NONE`는 그대로 export(R6).

### 4.5 `ui/src/api/hooks.ts` — 충족 R: R8
- `useScenarioRuns`에 `refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === "running") ? 5000 : false)` 추가(React Query v5 `(query)=>number|false`, 기존 `useRun :151` 선례).
- **간격 근거(FIX-4)**: 5000ms는 **midrun freshness**가 지배 — healthy run의 cached `last_metric_ts`는 최대 ~5s stale이라 거짓 침묵 상한 ~5s ≪ 120_000ms midrun 임계라 오탐 구조적 불가. **startup은 폴 간격과 무관**(immutable `started_at` vs live `now`로 판정 — §3.4)이라 15s startup 임계보다 폴이 느려도 정확. 전체 목록 re-render(`normalizeProfile`/`parseScenarioDoc` per row)는 running run 있을 때만 5s 주기라 비용 무시 가능.

### 4.6 `ui/src/pages/ScenarioRunsPage.tsx` — 충족 R: R7, R10
- 각 row에서 `const stall = classifyRunStall(r.status, r.started_at ?? r.created_at, r.last_metric_ts ?? null, now)`. (`now`는 기존 `useNow(hasRunning?1000:null)` 재사용.)
- Status 칼럼에서 `<StatusBadge>` 옆에 `stall.kind !== "none" &&` amber roleless chip:
  ```tsx
  <span className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
        title={stall.kind === "midrun" ? ko.runStall.badgeTitleMidrun(formatDurationKo(stall.silentSeconds)) : ko.runStall.badgeTitleStartup}>
    ⚠ {ko.runStall.badge}
  </span>
  ```
- **startup title은 침묵초 없음**(`runStall.ts:36`이 startup `silentSeconds:0`) → 정적 `badgeTitleStartup`; midrun만 `formatDurationKo(silentSeconds)`. 의도적 비대칭(startup에 duration 렌더 시도 금지).
- **RTL 셀렉터는 `within(row)`**: 배지는 roleless(텍스트가 의미 전달)라 텍스트/`title`로 찾되, running run이 2개 이상이면 다중 매치 → row 컨테이너 `within(...)`로 스코프(G1b `within(banner)` 함정·ui/CLAUDE.md).

### 4.7 `ui/src/i18n/ko.ts` — 충족 R: R10
- **신규 `ko.runStall` 네임스페이스(FIX-5)** — G1b 상세 배너 문구(`ko.runDetail.midRunStall :655`)와 *별도*로 둔다(목록 배지는 `title` 속성·다른 표면이라 문구가 다름). R10의 "단일 소스"는 ADR-0035 의미(모든 copy를 카탈로그 경유)지 *메시지 dedup이 아니다* — `ko.runStall`도 카탈로그-routed라 R10 충족. 두 표면 문구는 의도적으로 독립.
- `ko.runStall`: `badge: "정지 의심"`, `badgeTitleMidrun: (d: string) => \`${d} 진행 없음 — 워커가 멈췄을 수 있어요\``, `badgeTitleStartup: "부하 시작 전 — 워커가 멈췄을 수 있어요"`.

---

## 5. 무변경 / 불변식 (명시)

- **engine·worker·proto·migration 0** — `run_metrics`/`runs`는 기존 테이블·컬럼, `ts_second`는 기존 신호. 새 read-path 쿼리 2개 + DTO 필드 1개만.
- **run status·report·DB 불변(R9)** — advisory만. 자동 fail은 G1a A/B 소관, 이 슬라이스는 status를 절대 안 바꾼다.
- **non-running run 응답 byte-identical except 가산 필드** — terminal run은 `last_metric_ts: null`이 추가될 뿐(additive, UI `.nullish()` 수용). 기타 필드 무변경.
- **메트릭 ingest 핫패스 byte-identical** — `MAX(ts_second)`는 읽기경로(목록/단건 응답 빌드)에서만, ingest·aggregator·flush 무관.
- **`computeRunStall` 동작 보존(R6)** — 코어 추출은 순수 리팩터, 기존 G1b 테스트가 회귀 가드.
- **임계값 단일소스(R5)** — `STARTUP_STALL_MS=15_000`/`MIDRUN_STALL_MS=120_000`은 `runStall.ts`에만; backend 임계 상수 없음(B2 연기).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | store cargo test(`last_metric_ts_by_scenario`: running→Some(max ts)·terminal/메트릭0→부재) + 라이브 목록 응답 | ✅ |
| R2 | 라이브 throwaway: 실 `/api/scenarios/{id}/runs` JSON을 `RunListSchema.safeParse`(running 숫자·terminal null 통과) | ✅ |
| R3 | `store::metrics` cargo test: `last_metric_ts_by_scenario`(running run만 맵에 포함·메트릭0 run 부재·MAX 값) | |
| R4 | 라이브 목록: running row=number·terminal row=null (핸들러 분기 검증); 필드-세팅은 컴파일러 강제(non-Default DTO) | ✅ |
| R5 | `runStall.test.ts`: `classifyRunStall` 분기(non-running→none·null+15s 경계·number+119/121s 경계·회복) + `silentSeconds` | |
| R6 | 기존 G1b `runStall.test.ts`/`RunDetailPage.test.tsx` 무수정 green(위임 후 의미 불변) | |
| R7 | `ScenarioRunsPage.test.tsx`: 주입 `last_metric_ts`+`now`로 midrun/startup 배지 출현·healthy(신선 ts)/terminal(null·non-running) 미출현·`title` 문구 | |
| R8 | `useScenarioRuns` predicate 단위 또는 RTL: running 있으면 interval number·없으면 false | |
| R9 | grep/리뷰: status writer 미추가·migration/proto 0·terminal 응답 가산 외 동일 | |
| R10 | grep: `ScenarioRunsPage`/배지 인라인 영어 0(`ko.runStall.*` 경유) | |

- **FIX-2/R5·R6**: `classifyRunStall` 단위테스트는 기존 `computeRunStall` 테스트에 **추가**(대체 아님) — 새 직접 진입점(목록)과 위임 래퍼(상세)를 둘 다 커버.
- **R7 `within(row)`**: 배지 RTL은 row 컨테이너 `within(...)`로 스코프(다중 running row 다중매치 회피, §4.6).
- **라이브 검증 필수**(S-D 갭) — 새 DTO 필드가 **목록 응답 경로**에 실린다. RTL fixture는 `last_metric_ts`를 absent로 줘 `.nullish()`↔서버-null 미스매치를 통과시킬 수 있다(루트 CLAUDE.md). 머지 전 `/live-verify`로: ① subprocess run 생성·메트릭 흐른 뒤 실 목록 응답에 `last_metric_ts`(number) 확인 + 실 `RunListSchema` 파싱(R2), ② terminal run은 `null` 확인. 배지 120s 타이밍은 RTL 주입(`last_metric_ts`/`now`)으로 결정적 — 라이브에서 120s 대기 불요(`kill -STOP`로 침묵 유발 후 임계 도달은 RTL이 증명, 라이브는 **신호 배선+Zod**가 목적).

---

## 7. 의도적 연기 (roadmap §B3/§G1b에 누적)

- **서버측 stall 계산(Approach B) / 임계값 backend 이주(B2)**: A/B/C 임계값을 재배포 없이 `/settings`로(L6 ops-hardening 선례). 이 슬라이스는 클라 계산·UI 상수 유지.
- **G2 (k8s register-前 사망 reaper)**: k8s Job-status 폴링으로 register-전 죽은 Pod를 60s보다 빨리 Failed. 별개 backend-only 슬라이스(코드 공유 0·kind 클러스터 검증 필요). 사용자 범위 결정으로 분리(2026-06-23).
- **배지에서 직접 중단(abort) 액션**: 목록 배지는 표시만. 중단은 상세 화면(G1b 배너 [중단])·목록 기존 동선. 목록 인라인 abort는 후속.
- **think-time 도출 임계값**: scenario walk로 max think 간격 도출 — advisory라 불필요(G1b §12 동일 판단).
- **목록 배지 kind별 문구 분화**: 현재 단일 chip + `title`. startup/midrun 별색·별문구는 과설계(상세가 담당).

---

## 8. 구현 순서 (plan 입력)

cargo-영향 커밋마다 전체 워크스페이스 게이트 → green fold 지점 명시. UI는 `tdd-guard`(test-path 파일 먼저) + `spec-review-guard`(plan `REVIEW-GATE: APPROVED` 마커) 준수.

1. **Backend 신호(R1·R3·R4·R9)** — store 1 fn(`last_metric_ts_by_scenario`) + `RunResponse` 필드 + `to_response` arity(3 호출부: list=맵·get/create=None) + cargo 단위테스트(store query). 핸들러 분기는 라이브(Task 4)가 검증·필드-세팅은 컴파일러 강제(격리 핸들러 테스트 불요). R1↔R2 와이어라 R2(UI Zod)와 같은 머지 단위. **한 green 커밋**(미사용 fn 단독 커밋 불가 — 핸들러 배선까지 fold).
2. **UI Zod(R2)** — `RunSchema.last_metric_ts` `.nullish()`. (1과 같은 머지 단위 — 와이어 양쪽.)
3. **stall 코어 + 상세 위임(R5·R6)** — `runStall.ts` `classifyRunStall` 추출 + `computeRunStall` 위임. test-path(`runStall.test.ts`) 먼저(tdd-guard) → 코어. 기존 G1b 테스트 회귀 green.
4. **목록 폴링 + 배지 + ko(R7·R8·R10)** — `ScenarioRunsPage.test.tsx`(배지/폴링 RTL) 먼저 → `hooks.ts` refetchInterval + `ScenarioRunsPage` 배지 + `ko.runStall`. UI 게이트(`pnpm lint && pnpm test && pnpm build`).
5. **라이브 검증(R1·R2·R4)** — `/live-verify`로 목록 응답 `last_metric_ts` + 실 `RunListSchema` 파싱(S-D 갭).
