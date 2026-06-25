# Run 목록 필터/정렬 — 시나리오 run 목록을 결과·상태·부하모드·날짜로 거르고 다중키로 정렬 (사용성 트랙, UI-only)

- **날짜**: 2026-06-25
- **상태**: 설계 승인(사용자 2026-06-25) → plan 대기
- **출처**: roadmap §B6 연기 항목("verdict 필터/정렬") + 사용자 요청(2026-06-25, "리포트 깊이/사용성 쪽"). **왜 지금**: run이 시나리오당 쌓이면(`list_by_scenario`가 LIMIT 없이 전량 반환) 원하는 run(불합격·실행중·특정 부하모드·최근)을 찾기 어렵다 — 목록이 created_at DESC 한 줄 정렬뿐.
- **연관**: `ui/src/pages/ScenarioRunsPage.tsx`(run 목록), `ui/src/components/loadModel.ts`(`deriveLoadMode`/`profileVuDisplay`), `ui/src/components/VerdictBadge.tsx`·`StatusBadge.tsx`·`RunVuCell.tsx`, `ui/src/api/runPrefill.ts`(`profileDurationSeconds`), ADR-0035(ko.ts 한국어 카탈로그).
- **ADR**: 신규 불필요. 와이어/proto/migration/엔진 무변경의 순수 클라이언트 UI 슬라이스(기존 read-path 위 표시·정렬 레이어).

---

## 1. 문제와 목표

시나리오 run 목록(`ScenarioRunsPage`)은 서버가 `list_by_scenario`로 **전량(페이지네이션 없음)** 반환한 run을 `created_at DESC` 한 줄로만 보여준다. run이 수십~수백 개로 쌓이면 "불합격한 run만", "지금 실행 중인 것", "곡선 부하 run", "최근 7일", "가장 오래 돈 run"을 찾으려면 사용자가 눈으로 스크롤해야 한다.

- **목표**: 이미 클라이언트에 로드된 run 배열을 **4차원 필터**(결과·상태·부하모드·날짜) + **다중키 명시-우선순위 정렬**(날짜·Duration·VU/peak·결과·상태)로 거르고 정렬한다. 상태는 URL 쿼리파라미터에 보관해 새로고침·공유·북마크에 생존. **순수 클라이언트 UI-only** — controller/store/proto/migration/엔진 0-diff.
- **비목표(연기)**: §7 참조. 서버측 페이지네이션·자유 텍스트 검색·VU/duration 버킷 필터·포화(dropped) 필터(run 목록 DTO에 `dropped` 부재 → 서버 변경 필요)·정렬 프리셋 저장.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

> 이 슬라이스는 **계약 경계(seam) 없음** — 서버 DTO/proto/migration/CSV 무변경의 순수 클라이언트 표시·정렬. 유일한 "계약"은 URL 쿼리파라미터 스킴(클라 내부, §5)이라 `seam ✅` 없음.

### 필터

| ID | 요구사항 (MUST/SHOULD) | acceptance | seam? |
|---|---|---|---|
| R1 | MUST 결과(verdict)로 필터: `합격(pass)`/`불합격(fail)`/`기준없음(none)`, 차원 내 다중 선택. **매핑**: `verdict==null → none`, `verdict.passed===true → pass`, `===false → fail`(`VerdictBadge` 트리코토미와 동일) | 단위(`filterRuns` PASS-only/FAIL+none/빈=전체) + RTL | |
| R2 | MUST 상태(status)로 필터: `대기중(pending)`/`실행중(running)`/`완료(completed)`/`실패(failed)`/`중단(aborted)` **5종 전부**(`RunStatusEnum`=5값, 신규 run은 `pending`), 다중 선택 | 단위(5종 각 매칭) + RTL | |
| R3 | MUST 부하모드로 필터: `닫힌+고정`/`닫힌+곡선`/`열린+고정`/`열린+곡선` — `deriveLoadMode(r.profile)`로 도출, 다중 선택 | 단위(4모드 fixture 각 1개씩 → 모드별 매칭) + RTL | |
| R4 | MUST 날짜(created_at)로 필터: 프리셋(`전체`/`오늘`/`최근 7일`/`최근 30일`) **+** 커스텀 범위(from~to, YYYY-MM-DD); 커스텀(from·to 중 하나라도) 입력 시 프리셋보다 **우선** | 단위(프리셋 경계·커스텀 inclusive·custom-overrides-preset) | |
| R5 | MUST 필터는 **차원 간 AND, 차원 내 OR**, 차원의 선택이 비면 그 차원 전체 통과 | 단위(조합 케이스) | |

### 정렬

| ID | 요구사항 (MUST/SHOULD) | acceptance | seam? |
|---|---|---|---|
| R6 | MUST 다중키 정렬: 우선순위 순서의 키 목록, 각 `{field, dir}`(목록 순서=1차·2차·…) | 단위(`sortRuns` 2키 [verdict asc, created desc] 순서 보존) | |
| R7 | MUST 정렬 필드 5종: `날짜(created_at)`·`Duration`·`VU/peak`·`결과(verdict)`·`상태(status)` | 단위(각 필드 비교자) | |
| R8 | MUST 정렬 미지정(URL `sort` 부재) 시 **단일 키 `[created_at desc]`** = 현행 목록 순서 byte-identical | 단위(no-param → 입력순 유지) + R18 | |
| R9 | MUST 모든 정렬키 동률 시 **안정 tiebreaker `created_at desc → id`**로 결정적 순서 | 단위(동률 fixture 결정적) | |
| R10 | MUST VU/peak 정렬값: `닫힌+고정`=`vus`, `닫힌+곡선`=`max(vu_stages.target)`, **열린루프=비교불가(`null`) → 방향(▲/▼) 무관 항상 맨 끝**(nulls-last). 정렬값은 `deriveLoadMode`로 분기해 도출(열린→`null`) — `profileVuDisplay().peak`를 **읽지 않는다**(빈 곡선 시 `Math.max(...[])=-Infinity` 오염 회피, FR1). nulls-last 행끼리는 R9 tiebreaker(`created desc→id`) 적용 | 단위(asc·desc 둘 다 열린루프가 끝·null끼리 created desc) | |
| R11 | MUST 결과/상태 정렬은 정의된 서수 랭크 — 결과 asc: `불합격(fail)<합격(pass)<기준없음(none=verdict null)`; 상태 asc: `실행중(running)<대기중(pending)<실패(failed)<중단(aborted)<완료(completed)`(5종 전부 슬롯) | 단위(랭크 순서 단언·pending 포함) | |
| R12 | MUST 정렬 가능한 열 헤더 클릭 = 그 필드를 **1차로 승격**: 키 목록에 이미 있으면 그 위치에서 맨 앞으로 **이동**, 없으면 **prepend**(필드 기준 **dedup** — 목록 무한 성장 없음); 이미 1차면 그 키 **방향 토글**. 정렬 빌더가 진실의 원천(같은 dedup 키 목록 조작), 헤더는 단축 + 활성 정렬 표시(▲/▼ + 우선순위 번호) | RTL(헤더 클릭→URL `sort` 1차 승격·재클릭 방향 토글·중복필드 클릭 시 dedup) | |

### 상태·UI

| ID | 요구사항 (MUST/SHOULD) | acceptance | seam? |
|---|---|---|---|
| R13 | MUST 필터+정렬 상태를 URL 쿼리파라미터(§5)에 보관; 누락/빈 = 기본; 파싱은 미지 값 무시(견고) | 단위(parse/serialize round-trip·미지값 drop) + RTL(필터 적용→URL 반영) | |
| R14 | MUST 필터 적용 시 "전체 N개 중 M개 표시" 카운트 + 필터/비-기본 정렬 활성 시 **"필터 초기화"** | RTL | |
| R15 | MUST run은 있으나 조건에 맞는 게 0개면 **전용 빈 상태**("조건에 맞는 run이 없습니다" + 초기화) — run 자체 0개(`ko.empty.runs`)와 구분 | RTL | |
| R16 | MUST 비교 선택(`selectedIds`)은 필터링과 **독립** — 필터는 *표시 행*만 바꾸고 선택/비교·baseline 로직은 전체 run 집합 위에서 동작(필터해도 선택 유지) | RTL(필터 변경 후 선택 유지·비교 버튼 동작) | |
| R17 | MUST 신규 사용자 노출 문구(라벨·옵션·`aria-label`·`title`·빈상태) 전부 `ko.ts` 경유(ADR-0035) | grep(신규 인라인 영어/한국어 0) + 코드리뷰 | |
| R18 | MUST 기본 URL(파라미터 0) 진입 시 목록 **행·순서·비교 흐름이 byte-identical** — 기존 *행/셀/비교* 테스트는 무수정 통과. (열 헤더가 버튼화되므로 헤더 role/accname을 단언하는 테스트가 있으면 그것만 갱신 — 현 테스트는 셀 내용·비교 단언이라 영향 없음을 확인) | RTL(no-param 렌더 행/순서 동일·기존 셀/비교 테스트 green) | |
| R19 | MUST 필터 술어·다중키 comparator·정렬값 도출·URL parse/serialize를 순수 모듈 `ui/src/runs/runFilterSort.ts`로 분리(단일 소스, 단위 테스트) | 단위(모듈 전수) | |

---

## 3. 핵심 통찰 (설계 근거)

1. **서버 0-diff가 가능한 근거**: `crates/controller/src/store/runs.rs::list_by_scenario`가 `SELECT … WHERE scenario_id = ? ORDER BY created_at DESC`로 **LIMIT 없이 전량** 반환하고 `ScenarioRunsPage`가 `runs.data.runs` 전부를 이미 보유한다. 필터·정렬은 이 메모리 배열에 대한 순수 변환이라 controller/store/proto/migration 무변경(R18 byte-identical의 토대). 페이지네이션은 비목표(§7) — 사내 QA 시나리오당 run 수가 클라 필터로 충분.
2. **필요한 모든 차원이 이미 로드된 필드에서 도출 가능**: `RunSchema`에 `status`·`verdict`·`profile`(→`deriveLoadMode`로 부하모드·`profileVuDisplay`/`vu_stages`로 VU/peak·`profileDurationSeconds`로 Duration)·`created_at`이 있다. 새 서버 필드 0(R1–R4·R7).
3. **`deriveLoadMode`/`profileDurationSeconds`/`profileVuDisplay`는 이미 leak-free `Pick<>` read-only 헬퍼**(곡선 VU 표시 슬라이스에서 확립) — `runFilterSort.ts`가 이들을 재사용해 부하모드 필터(R3)·Duration/VU 정렬값(R7·R10)을 도출, 모드 역도출 로직 복제 없음(drift 방지).
4. **VU/peak 정렬의 nulls-last(R10)**: 열린루프는 VU 개념이 없어(profileVuDisplay가 "—") 비교 가능한 VU 값이 없다. asc/desc 어느 방향이든 열린루프를 맨 끝에 두면(닫힌 run끼리만 VU로 정렬) "큰/작은 부하 찾기" 의도가 깨지지 않는다 — 사용자 결정.
5. **다중키 + 헤더 단축의 단일 진실원천(R6·R12)**: 정렬 빌더가 키 목록을 소유하고, 열 헤더 클릭은 그 목록을 조작하는 **단축**(R12: 그 필드를 1차로 승격 — 있으면 move·없으면 prepend·필드 dedup·이미 1차면 dir 토글)이라 두 입력이 같은 URL `sort`를 갱신 → 두 소스 분기 없음. 정렬 상태는 URL이 권위(R13)라 빌더·헤더·새로고침이 모두 일관.
6. **비교 선택 독립(R16)**: 기존 코드의 baseline 계산이 `allRuns.filter(r => selectedIds.has(r.id))`로 이미 *전체* run 집합을 본다 — 필터는 **렌더되는 행**만 줄이고 `selectedIds`/`allRuns`(선택 해석)는 안 건드리면 비교 흐름이 그대로 동작. "필터로 좁혀 선택 → 필터 변경"에도 선택이 보존(id 기준).
7. **단일 슬라이스 유지(분할 8a/8b 기각)**: 다중키 빌더 UI를 별도 슬라이스로 미루는 안을 검토했으나 기각 — ① 사용자가 다중키 명시-우선순위를 직접 요청, ② 순수 comparator(R6·다중키)는 어차피 Task 1에서 공유, ③ **헤더 승격(R12)이 다중키 목록을 전제**(클릭이 기존 키를 2차로 밀어내려면 목록이 있어야)라 "단일키-only 8a"는 헤더 의미가 달라져 8b에서 재작성(churn)을 부른다. C2(R12 dedup 승격 의미 확정)로 헤더↔빌더 동기 모호성이 제거돼 한 슬라이스로 안전. 빌더 UI는 §9 마지막 task로 격리.

---

## 4. 변경 상세

> 전부 `ui/` 한정.

### 4.1 신규 `ui/src/runs/runFilterSort.ts` (순수) — 충족 R: R1–R11, R13, R19
- 타입: `RunFilter`(verdicts:Set·statuses:Set·modes:Set·datePreset·dateFrom·dateTo), `SortKey{field, dir}`, `SortField = 'created'|'duration'|'vu'|'verdict'|'status'`.
- `filterRuns(runs, filter, now)` — R5(AND across·OR within·빈=통과). 날짜 경계(`now` 주입, 로컬 타임존): `오늘`=로컬 자정~`now`, `7일`/`30일`=rolling `now − N×86400000`~`now`, custom=`[from 00:00:00.000, to 23:59:59.999]` 로컬 inclusive(from·to 각각 선택적 — 한쪽만이면 open-ended). custom(from 또는 to)이 있으면 프리셋 무시(R4).
- `sortRuns(runs, keys)` — 안정 다중키 comparator(R6); 각 필드 비교자(R7); VU/peak nulls-last(R10); verdict/status 서수 랭크(R11); 동률 tiebreaker `created desc → id`(R9). `keys` 빈 = `[created desc]`(R8).
- 정렬값 도출 헬퍼: `vuSortValue(profile)`(R10, `deriveLoadMode`+`vu_stages` 재사용, 열린루프→`null`), `durationSortValue`=`profileDurationSeconds`, `verdictRank`/`statusRank`(R11).
- `parseRunControls(searchParams)` / `serializeRunControls(filter, keys)` — URL ↔ 상태(R13, §5 스킴), 미지 값 drop, 기본값 round-trip 안정.

### 4.2 신규 toolbar 컴포넌트 (프레젠테이셔널) — 충족 R: R1–R4, R6, R12, R14, R17
- `RunListControls.tsx`(또는 `RunFilterBar`+`RunSortBuilder` 분리): 필터 4개(결과·상태·부하모드 다중선택 + 날짜 프리셋/커스텀) + 정렬 빌더(키 행: 필드 select·방향 토글·제거·우선순위 ↑/↓·"+ 정렬 추가" 미사용필드만). controlled — 상태는 부모(`ScenarioRunsPage`)가 URL에서 소유, `onChange`로 URL 갱신.
- 카운트 "전체 N개 중 M개 표시" + "필터 초기화"(R14). 전부 `ko.ts`(R17).

### 4.3 `ui/src/pages/ScenarioRunsPage.tsx` 배선 — 충족 R: R5, R8, R12, R15, R16, R18
- `const [searchParams, setSearchParams] = useSearchParams()`(현재 setter 미구조분해 — R12/R13 URL 쓰기 위해 추가). `parseRunControls(searchParams)` → `filter`/`sortKeys` 도출. 렌더 직전 `visible = sortRuns(filterRuns(allRuns, filter, dateNow), sortKeys)`.
- **날짜 경계 `dateNow`**: 렌더-시점 스냅샷(`Date.now()`, running 없으면 `useNow`가 mount-frozen이라 day 경계가 세션 중 drift 가능 — 이 사용성 기능엔 허용; 필터/URL 변경·refetch 때 재평가). live-tick은 비목표(re-sort churn 회피).
- 테이블은 `visible`을 렌더(기존 `allRuns.map` → `visible.map`). **selection/baseline 계산은 `allRuns` 유지**(R16). 비교 toolbar(2–5/50 게이트)도 `selectedIds`∩`allRuns` 그대로.
- 열 헤더 클릭 핸들러 → `setSortPrimary(field)`(URL `sort` 갱신·R12) + 활성 정렬 표시(▲/▼+번호).
- `visible.length===0 && allRuns.length>0` → 전용 빈상태(R15). no-param이면 `filter` 빈·`sortKeys=[created desc]`라 `visible`==기존 순서(R18).

### 4.4 `ui/src/i18n/ko.ts` — 충족 R: R17
- `ko.runFilter.*`(차원/옵션 라벨·날짜 프리셋·"필터 초기화"·"전체 N개 중 M개 표시"·빈상태)·`ko.runSort.*`(필드 라벨·방향·"정렬 추가"·우선순위 aria) 신설.

---

## 5. URL 쿼리파라미터 스킴 (R13)

```
?status=pending,running           # CSV, ∈{pending,running,completed,failed,aborted}  (5종)
&verdict=fail                     # CSV, ∈{pass,fail,none}
&mode=closed_curve,open_fixed     # CSV, ∈{closed_fixed,closed_curve,open_fixed,open_curve}
&date=7d                          # ∈{all,today,7d,30d}; 기본 all
&from=2026-06-01&to=2026-06-25    # YYYY-MM-DD; 존재(from 또는 to) 시 date 프리셋 무시(R4)
&sort=verdict:asc,created:desc    # CSV of field:dir; field∈{created,duration,vu,verdict,status}, dir∈{asc,desc}
```

- 누락/빈 파라미터 = 기본(필터 없음·정렬 `created:desc`). 미지 토큰은 무시(견고). **파라미터 0 = 기본 = 현행 화면(R18)**.
- 기존 `?retry=`·compare `?runs=&baseline=`(별도 페이지) 파라미터와 키 충돌 없음.
- 커스텀 날짜 입력은 **네이티브 `<input type="date">`**(URL `from`/`to`=`YYYY-MM-DD`) — 신규 의존성 0(ADR 불필요·번들 무증가).

---

## 6. 무변경 / 불변식 (명시)

- **controller/store/proto/migration/엔진/워커 0-diff** — 순수 클라 표시·정렬. 서버 DTO(`RunSchema`)·`/api/scenarios/{id}/runs` 응답 무변경.
- **run 생성·리포트 파싱·비교 export 경로 무변경** — 이 슬라이스는 목록 *읽기* 레이어만. `createRun`/RunDialog/compare URL/`downloadFile` 무수정.
- **기본 URL byte-identical(R18)** — 파라미터 없을 때 행·순서·비교 게이트(terminal/2–5/50)·`?retry=` 동작 그대로. 기존 `ScenarioRunsPage` 테스트는 무수정 통과.
- **비교 선택 로직 무변경(R16)** — `selectedIds`/baseline(최소 created_at)/2–5·>5·>50 분기 그대로, 입력 집합만 `allRuns` 유지. (필터로 가려진 선택 run도 선택 유지·비교 N에 포함 — 의도된 동작, plan은 카운트/안내 문구가 혼란 없게.)
- **`?retry=` deep-link 가드 무변경** — `setSearchParams`로 filter/sort를 쓰면 `searchParams` identity가 바뀌어 기존 `?retry=` effect(deps `[retryId, runs.data, createRun]`)가 재발화하나 `consumedRetry` ref가 id당 1회 가드(`ScenarioRunsPage.tsx:67`)라 no-op 보존 — 이 ref/가드를 깨지 말 것(기존 회귀 테스트 존재).
- **R8/R9 tiebreaker는 의도적 개선** — `list_by_scenario`는 `ORDER BY created_at DESC`만(2차 키 없음)이라 동일 `created_at` run의 상대순서가 미정의지만, R9 `created desc→id` tiebreaker가 그걸 결정적으로 만든다. R18 byte-identical은 distinct timestamp(흔한 경우)에서 성립 — R18 fixture는 distinct `created_at` 사용(기존 테스트 100/200/300이 이미 그러함), 동률 reorder는 회귀 아닌 개선.

---

## 7. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1–R5 | `runFilterSort.test.ts` 단위(차원별 매칭·AND/OR·빈=통과·날짜 경계/custom-overrides) + `ScenarioRunsPage` RTL(필터 적용→행 수·URL) | |
| R6–R11 | `runFilterSort.test.ts` 단위(다중키 순서·필드 비교자·VU nulls-last asc&desc·verdict/status 랭크·동률 tiebreaker·no-key 기본) | |
| R12 | RTL(헤더 클릭→URL `sort` 1차 갱신·재클릭 방향 토글·활성 표시) | |
| R13 | `runFilterSort.test.ts`(parse/serialize round-trip·미지값 drop) + RTL(필터→`searchParams`) | |
| R14, R15 | RTL(카운트 문구·초기화 버튼·전용 빈상태 vs no-runs 빈상태) | |
| R16 | RTL(필터 변경 후 `selectedIds` 유지·비교 버튼 navigate) | |
| R17 | grep(신규 인라인 영어/카탈로그-밖 한국어 0) + 코드리뷰 | |
| R18 | RTL(no-param 페이지 = 기존 테스트 무수정 green) | |

- **라이브 검증 판단**: 이 슬라이스는 **run 생성/리포트 파싱/엔진 경로를 건드리지 않는다**(목록 읽기 표시·정렬만, `RunSchema`/응답 0-diff). 따라서 S-D 갭(서버 null↔Zod·응답경로 버그)이 **구조적으로 무관** → 라이브 검증 **waived 후보**(RTL+단위로 결정적 커버). 머지 전 finish-slice에서 최종 판정·근거를 build-log에 기록.

---

## 8. 의도적 연기 (roadmap §B6/§B9에 누적)

- **서버측 페이지네이션/필터링**: 클라 전량 로드가 사내 run 규모에 충분 — run이 수천 개가 되면 서버 LIMIT+필터로 별도 슬라이스.
- **자유 텍스트 검색**: run은 이름이 없어 매칭 대상 빈약 — 비목표.
- **포화(dropped>0) 필터**: run 목록 DTO에 `dropped` 부재 → 서버 변경 필요(UI-only 위반)라 별도.
- **VU/duration 버킷 필터**: 정렬로 대체 가능 — 낮은 가치.
- **정렬/필터 프리셋 저장**(자주 쓰는 뷰): URL 공유로 1차 충족 — 영속 프리셋은 후속.
- **run 목록 stall/워커 배지 정렬·필터**: 별개 표시 항목(§B9 누적).

---

## 9. 구현 순서 (plan 입력)

> 전부 `ui/` UI-only라 cargo 게이트 무관(pre-commit은 ui 게이트만). **`tdd-guard` 함정**: src 편집 전 pending test 파일 필요 → 각 task는 테스트 파일을 먼저(RED) 만든 뒤 src(ui/CLAUDE.md 게이트-에러 매핑 함정).

1. **순수 모듈 `runFilterSort.ts` + 단위 테스트**(R1–R11, R13, R19) — UI 무관 순수 로직 단독 검증. green fold(헬퍼+테스트 한 커밋).
2. **`ko.ts` 문구 + toolbar 컴포넌트(`RunListControls`) + RTL**(R1–R4, R6, R12, R14, R17) — controlled 프레젠테이셔널.
3. **`ScenarioRunsPage` 배선 + 헤더 클릭 정렬 + 빈상태 + RTL**(R5, R8, R12, R15, R16, R18) — URL ↔ 필터/정렬, 기존 테스트 무수정 확인(R18).
