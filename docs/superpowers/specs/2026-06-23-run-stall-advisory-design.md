# Run 진행 라이브니스 — C: mid-run stall advisory (G1b) 설계

- **상태**: 설계 (G1b). G1a(A startup + B backstop)는 머지 완료(2026-06-23). 본 슬라이스는 G1a spec §7이 비전만 기록하고 미룬 **C tier(mid-run stall, advisory)** 의 자체 spec/plan이다.
- **선행**: `docs/superpowers/specs/2026-06-23-run-progress-liveness-design.md`(G1a, §2 3-tier 철학 · §7 C 설계 의도).
- **범위 결정(사용자, 2026-06-23)**: **상세(RunDetailPage)만, 순수 클라이언트**. run 목록 배지 + 서버-계산 stall + 임계값 런타임 가변은 연기(§7).

---

## 1. 문제 / 갭

G1a가 닫은 두 tier:
- **A (startup hang)**: 등록 후 유효 grace 안에 첫 메트릭이 0 → 자동 `Failed`.
- **B (duration backstop)**: `started + 예상종료 + grace` 초과인데 terminal 미도달 → 자동 `Failed`.

남은 tier:
- **C (mid-run stall)**: 메트릭이 **흐르기 시작한 뒤** `stall_threshold`간 새 메트릭이 끊겼고 run이 still `running`. think-time / 선두 `rate:0` stage가 **합법적으로 침묵**할 수 있어 자동 fail이 불가능 — "확실"하지 않다(G1a spec §2 tier 표).

C의 가치: **B보다 훨씬 이른 조기경보**. 긴 run(예 30분)이 5분에 wedge되면 B는 ~32분(duration+grace)에야 발동하지만, C는 7분(5분+2분 침묵)에 "정지 의심"을 표면화해 운영자가 일찍 결정([중단])하게 한다. 운영자가 무시해도 B가 결국 자동으로 닫는다 — **C=조기경보, B=확실한 최종 차단**.

> **용어**: 표면화하는 *상태*는 "정지 의심"이고, 운영자가 누르는 *버튼*은 앱 전역에서 쓰는 abort 액션 = **"중단"**(`ko.common.abort`). 이 spec에서 "[중단] 버튼"은 그 기존 abort 버튼을 가리킨다(상태명 "정지 의심"과 버튼 라벨 "중단"은 별개·의도적).

## 2. 설계 철학: advisory(알림+확인), 자동 fail 안 함

G1a spec §2의 결론을 그대로 따른다: **오탐 위험과 "자동으로 run을 죽일 권한"을 짝지으면 안 된다**([[load-divergence-explain-confirm]]). C는:
1. 제품에 라이브 대시보드/푸시 인프라가 없다(ADR-0009) → "모달로 물어보기" 불가. run **상세 화면의 배너 + [중단] 버튼**으로 표면화 = 제품 제약 안의 "물어보기".
2. **advisory라 오탐이 무해** — 틀린 경고는 "잘못된 배지"일 뿐 죽은 run이 아니다. 그래서 임계값을 think-time까지 완벽 도출할 필요 없이 넉넉한 기본값으로 충분(틀려도 운영자가 무시, B가 최종 차단).

run status는 **절대 변경하지 않는다**(자동 fail은 A/B만).

## 3. 핵심 통찰: 순수 클라이언트 계산 (백엔드 0 변경)

`RunDetailPage`는 run이 `running`인 동안 stall 판정에 필요한 데이터를 **이미 전부 로드**한다:

- **메트릭 윈도**: `metrics = useRunMetrics(id, terminal)`(`RunDetailPage.tsx:37`). `useRunMetrics`(`ui/src/api/hooks.ts:169`)는 `paused=terminal`이라 **running이면 폴링**, terminal이면 정지. 응답은 `MetricSummarySchema`(`ui/src/api/schemas.ts:216`)의 `windows: WindowSummarySchema[]`(`schemas.ts:207`) — 각 윈도에 **`ts_second`** 가 있다.
- **`ts_second`는 wall-clock unix 초**: 엔진 `aggregator.rs:360` `current_second() = SystemTime::now().duration_since(UNIX_EPOCH).as_secs()`. 워커가 이 값으로 윈도를 키잉(`aggregator.rs:179`), 컨트롤러 store가 **raw로 저장**(`store/metrics.rs`), `summary` 핸들러가 **rebase 없이 raw로 서빙**(`api/runs.rs:911` → `store::metrics::summary`). 즉 UI가 받는 `ts_second`는 그 윈도가 기록된 **벽시계 unix 초**다.
- **현재 시각**: `now = useNow(run.data?.status === "running" ? 1000 : null)`(`RunDetailPage.tsx:40`) — running이면 매 1초 tick하는 벽시계 ms(`Date.now()` 기반, 기존 `stalledRunning`이 `now - r.started_at`로 사용 중).

따라서 mid-run 침묵은:
```
maxTs   = max(w.ts_second for w in windows)   // 마지막 메트릭의 unix 초
silence = floor(now / 1000) - maxTs           // 마지막 메트릭 이후 경과 초
midRunStall = status === "running" && totalCount > 0 && silence > THRESHOLD
```

- `started_at` 불요(`ts_second` 자체가 절대 unix 시각이라 빼야 할 기준점이 없다).
- **하위 호환·byte-identical**: 백엔드(`crates/**`)·migration·proto·Zod 스키마·API 전부 **0 변경**. 순수 UI(`ui/src`)만 손댄다.
- **워커-clock vs 브라우저-clock skew**: LAN NTP로 sub-second, 120초 임계값엔 무의미. 기존 `stalledRunning`(브라우저 `now` vs 서버 `started_at`)이 **이미 같은 cross-clock 가정**으로 shipped — 새 위험 아님.

### 3.1 startup(메트릭 0) 케이스와의 관계

기존 `stalledRunning`(`RunDetailPage.tsx:92–96`)은 **startup 케이스**(running · 메트릭 도착 · `totalCount === 0` · `now - started > 15s`)를 잡아 amber 배너(`RunDetailPage.tsx:197–204`, `ko.runDetail.stalledRunning`)를 띄운다. 이는 A(자동 fail)의 클라 측 조기 힌트다. mid-run은 그 형제다:

| 케이스 | 조건 | 기존/신규 |
|---|---|---|
| **startup** | `running && metrics 도착 && totalCount === 0 && now-started > 15s` | 기존(보존) |
| **midrun** | `running && totalCount > 0 && silence > 120s` | 신규 |

두 케이스는 `totalCount`(0 vs >0)로 **상호배제**된다.

## 4. 임계값: UI 상수 120초

`MIDRUN_STALL_MS = 120_000`(120초) — 헬퍼 모듈의 named 상수(기존 startup 인라인 `15_000`도 `STARTUP_STALL_MS`로 같이 상수화).

근거:
- 엔진은 **그 초에 요청이 한 건이라도 완료되면 매 1초 메트릭을 flush**한다(`runner.rs`의 drain-non-empty 가드) → 보통의 think-time(다수 VU·중간 think_ms)에선 매 초 어떤 VU든 요청을 끝내므로 침묵이 1초를 거의 안 넘는다. 합법적 장기 침묵은 ① open-loop 선두 `rate:0` stage, ② **저-VU + 매우 큰 think_ms**(예 1 VU·think 130s — 모든 VU가 동시에 think 중이라 그 사이 완료 0) 정도다.
- 120초면 일반 think-time/짧은 rate:0은 다 흡수하면서 긴 run의 backstop-B보다 훨씬 이른 경보. 위 ①②처럼 임계값을 넘는 합법적 침묵은 **오탐**으로 배지를 띄우지만 — advisory라 **무해**(§2): 운영자가 무시하면 그만이고, 진짜 죽은 run은 B가 닫는다. 그래서 임계값을 think-time까지 완벽 도출할 필요가 없다.

**런타임 가변 안 함**(CLI flag·`/settings` 미도입) — 그건 B2(연기). 지금은 UI 상수로 충분(advisory + B2가 후속 튜닝 경로).

**think-time 도출 안 함** — §7이 "max(120s, think 도출)"을 예로 들었으나 "느슨해도 됨(advisory)"이라 했다. 도출은 복잡도만 키우고 위 분석상 불필요 → 연기.

## 5. 컴포넌트: 순수 헬퍼 `computeRunStall`

stall 로직을 `RunDetailPage` 인라인에서 **순수·단위테스트 가능 헬퍼로 추출**(repo 관용구: `runPrefill`/`sizing`/`loadModel`/`compareReports`). startup + midrun 두 케이스를 한곳에 모아 임계값 드리프트를 없앤다.

```ts
// ui/src/api/runStall.ts (신규)
export const STARTUP_STALL_MS = 15_000;
export const MIDRUN_STALL_MS = 120_000;

export type RunStallKind = "none" | "startup" | "midrun";
export interface RunStall {
  kind: RunStallKind;
  silentSeconds: number; // midrun일 때 침묵 초 (배너 문구용); 그 외 0
}

// run: { status: RunStatus; started_at: number | null; created_at: number }
//   (RunSchema: started_at는 .nullable() → number | null, undefined 아님; `started_at ?? created_at`로 흡수)
// windows: WindowSummary[] | undefined  (metrics.data?.windows — 첫 응답 전 undefined)
// nowMs: number  (Date.now() 기반 useNow tick)
export function computeRunStall(run, windows, nowMs): RunStall
```

판정(우선순위 명시):
- `status !== "running"` → `{ kind: "none", silentSeconds: 0 }`.
- 메트릭 미도착(`windows === undefined`, 아직 첫 응답 전) → `none`(기존 `metrics.data !== undefined` 가드 보존, 정상 진입 시 첫 RTT 동안 배너 플래시 방지).
- `totalCount === 0` → startup 판정: `nowMs - (started_at ?? created_at) > STARTUP_STALL_MS`면 `startup`, 아니면 `none`.
- `totalCount > 0` → midrun 판정: `silence = floor(nowMs/1000) - maxTs`; `silence*1000 > MIDRUN_STALL_MS`면 `{ kind: "midrun", silentSeconds: silence }`, 아니면 `none`.

`RunDetailPage`는 인라인 `stalledRunning`(`:92–96`)을 `const stall = computeRunStall(r, metrics.data?.windows, now)`로 교체하고, 렌더에서 `stall.kind`로 분기. 헬퍼는 `windows`에서 **자체적으로 `totalCount`/`maxTs`를 계산해 판정**한다(self-contained). 컴포넌트의 기존 `totalCount`(`:89`)는 카드(`cardTotalRequests` `:209`)·RPS(`:100`) 표시에 계속 쓰이므로 **제거하지 않는다** — 헬퍼와 컴포넌트가 같은 `windows` 배열을 읽을 뿐(별도 reduce, 마이크로 중복은 무시 가능). 즉 stall *판정 로직*만 헬퍼로 단일화하는 것이지 `totalCount` 파생 자체를 옮기는 게 아니다.

## 6. UI (RunDetailPage 한정)

**단일 렌더 슬롯(상호배제 구조화, M2)**: 기존 두 개의 독립 `&&` 블록이 아니라 `stall.kind` 한 스위치로 렌더해 startup/midrun이 동시에 못 뜨게 구조적으로 보장한다(불변식 4):
```tsx
{stall.kind === "startup" && (/* 기존 startup 배너 */)}
{stall.kind === "midrun"  && (/* 신규 midrun 배너 */)}
```
(`stall.kind`가 둘 중 하나만 될 수 있으므로 두 `&&`여도 동시 표시 0 — 단일 소스 `stall.kind`가 핵심.)

- **startup** → 기존 amber `role="status"` 배너(`ko.runDetail.stalledRunning`), **동작·문구 불변**(`RunDetailPage.tsx:197–204` 보존).
- **midrun** → amber `role="status"` 배너 신규:
  - 문구: **"⚠ {N} 진행 없음 — 워커가 멈췄을 수 있어요"** — `{N}` = `formatDurationKo(stall.silentSeconds)`(`ui/src/i18n/duration.ts:2`, 초 입력). `ko.runDetail.midRunStall(d)`.
  - **[중단] 버튼**을 배너 안에 둠 — 기존 헤더 abort 버튼(`RunDetailPage.tsx:133–142`)과 **같은 `abort.mutate()`** 호출, `disabled={abort.isPending}`, 라벨 `abort.isPending ? ko.common.aborting : ko.common.abort`(= "중단"/"중단 중…"). 헤더 버튼도 running 동안 그대로 유지 — 중복 무해, 둘 다 같은 idempotent abort, 앱 전역 라벨 일관성 위해 같은 "중단".
  - **R1 — 두 "중단" 버튼 공존**: midrun일 때 status는 항상 `running`이라 헤더 abort 버튼도 렌더된다 → 화면에 라벨 "중단" 버튼이 **둘**. 따라서 RTL에서 배너 버튼은 bare `getByRole("button",{name})`(다중 매치 throw)가 아니라 **배너 영역 안에서 `within(...)`로 스코프**해 찾아야 한다(§8). 프로덕션 동작엔 영향 없음(시각적 중복만).
  - 신규 문구는 전부 `ko.runDetail.*` 카탈로그 경유(ADR-0035). 하드코딩 영어 금지(`aria-label` 포함).

배치: 기존 startup 배너와 같은 위치(헤더 아래, `createRun.error`/`createPreset.error` 배너 근처, `RunDetailPage.tsx:197` 영역).

## 7. ko.ts 카탈로그 (ADR-0035)

`ko.runDetail`에 추가(기존 `stalledRunning`/`elapsed` 옆):
```ts
midRunStall: (d: string) => `⚠ ${d} 진행 없음 — 워커가 멈췄을 수 있어요`,
```
(배너 [중단] 버튼 라벨은 **새 키 없이** 기존 `ko.common.abort`("중단")/`ko.common.aborting`("중단 중…") 재사용 — 헤더 버튼과 동일 라벨로 일관성 유지.)

## 8. 테스트

- **단위(`runStall.test.ts`)**: `computeRunStall`의 분기 — ① 비-running → none; ② running·windows undefined → none(플래시 가드); ③ running·totalCount 0 + 임계 전/후 → none/startup; ④ running·totalCount>0 + `silence` 119s/121s 경계 → none/midrun; ⑤ 메트릭 재개(maxTs 증가) → midrun→none 회복. `silentSeconds` 값 검증.
- **RTL(`RunDetailPage.test.tsx`)**: midrun 배너가 frozen `ts_second` + 진행된 `now`(주입된 windows/now)로 임계 초과 시 나타나고, **배너의 [중단] 버튼이 `abort` mutation을 호출**. **R1 — 배너 버튼은 `within(banner).getByRole("button",{name:ko.common.abort})`로 스코프**(헤더 abort 버튼도 "중단"이라 bare `getByRole`은 다중 매치로 throw; banner는 `role="status"`+문구로 식별). **기존 startup-배너 테스트(`RunDetailPage.test.tsx`의 startup 케이스)는 그대로 green**(동작 보존; 헬퍼 교체가 startup 의미 불변임을 회귀가드).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(UI 3종, `tsc -b` 포함 — `pnpm test`(esbuild)는 헬퍼/시그니처 타입 에러를 못 잡으니 `pnpm build` 필수).
- **R2 — 구현 순서(tdd-guard·spec-review-guard)**: 플랜은 ① **test-path 파일 먼저** 편집(`__tests__/runStall.test.ts` + `RunDetailPage.test.tsx`의 RED diff)으로 pending diff를 만든 뒤 `runStall.ts`/`RunDetailPage.tsx`/`ko.ts` 같은 `ui/src` non-test 파일을 편집해야 `tdd-guard` 블록을 피한다(ui/CLAUDE.md). 또 plan은 clean APPROVE 후 `REVIEW-GATE: APPROVED` 마커를 달아야 `spec-review-guard`가 `ui/src` 편집을 허용한다.

## 9. 라이브 검증

**생략** — production diff가 `ui/src`-only(백엔드/엔진/run-생성/report-파싱 경로 0 변경)라 S-D 갭(서버 응답-파싱 불일치)에 해당 없음. 근거를 build-log에 기록(슬라이스 파이프라인 §5). midrun 배지 동작은 단위+RTL(주입 windows/now)로 결정적 검증.

## 10. 파일 터치 (예상)

- `ui/src/api/runStall.ts`: 신규 — `computeRunStall` + `STARTUP_STALL_MS`/`MIDRUN_STALL_MS`.
- `ui/src/api/__tests__/runStall.test.ts`: 신규 단위테스트.
- `ui/src/pages/RunDetailPage.tsx`: 인라인 `stalledRunning`(`:92–96`)→헬퍼 호출, 단일 `stall.kind` 슬롯 + midrun 배너 + [중단] 버튼 추가(`:197` 영역).
- `ui/src/pages/__tests__/RunDetailPage.test.tsx`: midrun 배너/abort RTL(+ startup 회귀 보존).
- `ui/src/i18n/ko.ts`: `ko.runDetail.midRunStall` 추가.
- 백엔드(`crates/**`)·proto·migration·Zod 스키마(`schemas.ts`)·API·`/settings`·engine: **0**.

## 11. 불변식

1. **백엔드 byte-identical**: `crates/**`·proto·migration·DB·`schemas.ts` 무변경.
2. **status 불변**: C는 run status를 절대 안 바꾼다(자동 fail은 A/B만).
3. **startup 케이스 보존**: 기존 `stalledRunning` 동작(15s·totalCount 0·문구)이 헬퍼 교체 후에도 동일.
4. **상호배제**: startup(totalCount 0)과 midrun(totalCount>0)은 동시에 true일 수 없다.
5. **플래시 가드**: 메트릭 응답 도착 전(`windows === undefined`)엔 어떤 배너도 안 뜬다.
6. **ko.ts 단일 소스**: 모든 신규 사용자노출 문구는 `ko.runDetail.*` 경유(ADR-0035).

## 12. 연기 / 후속

- **run 목록 배지 + 서버-계산 stall**: 목록(ScenarioRunsPage)은 per-run 메트릭을 안 받아 와(백엔드 신호 필요) → runs DTO에 read-time 계산 stall 필드 + 목록 배지. 사용자 범위 결정으로 연기.
- **임계값 런타임 가변(B2)**: A/B/C 임계값을 재배포 없이 `/settings`로(L6 ops-hardening 선례). 본 슬라이스는 UI 상수만.
- **think-time 도출 임계값**: scenario walk로 max think 간격 도출 — advisory라 불필요, 연기.
- **mid-run 자동 fail**: 설계상 불가(think-time 침묵 구분 불가, §2). C는 영구 advisory.
- **G2**: k8s register-前 사망 reaper(현재 60s watchdog 폴백) — 별개 갭, 본 spec 무관.
