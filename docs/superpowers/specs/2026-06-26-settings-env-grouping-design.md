# 설정 화면 환경별 그룹핑 — 운영 상한을 배포 환경(공통 / 분산 풀 전용)으로 묶고 적용 모드를 표면화 (사용성 묶음 B[UX1])

- **날짜**: 2026-06-26
- **상태**: 설계 초안
- **출처**: roadmap §UX1.B / 사용자 요청 (사용성 개선 4종 중 B). **왜 지금**: `/settings` 운영 상한이 Windows 단일 exe·쿠버네티스/LAN 풀 구분 없이 평면 노출돼, 관리자가 "어느 값이 어느 배포 환경에서 효과가 있는지"를 모른다(특히 풀 reaper 2종 `pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds`는 단일 exe에서 완전 무효; `pool_keepalive_seconds`는 이름과 달리 전 모드 적용 — §3).
- **연관**: 운영 상한 관리자(`2026-06-16-ops-config-limits-admin-design.md`, `settings.rs` 레지스트리·`SettingsPage.tsx`), LAN 분산 워커 L1~L7(pool 모드·`GET /api/pool/workers`), ADR-0035(한국어 카탈로그), ADR-0039/0041(단일 exe·LAN 풀).
- **ADR**: 신규 불필요. 설정 동작·와이어·검증을 바꾸지 않는 **UI-only 프레젠테이션** 슬라이스라 기존 ADR 범위 내. 분류 메타데이터는 UI 정적 맵(레지스트리 비변경).

---

## 1. 문제와 목표

`/settings`(운영 상한)는 설정을 "조정 가능 / 읽기 전용" 두 섹션으로만 나눠 평면 나열한다. 하지만 일부 설정은 **배포 환경별로 효과가 다르다** — `pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds`(풀 reaper)는 `is_pool_mode()`로 게이트돼 **Windows 단일 exe·로컬 dev(subprocess 모드)에서는 아무 효과가 없다**. 관리자는 이를 화면만 봐선 알 수 없어, 단일 exe 배포에서 무의미한 값을 만지거나 "이게 내 환경에 적용되나?"를 헷갈린다. (반대로 `pool_keepalive_seconds`는 이름과 달리 *전 모드 gRPC 서버에 적용*되므로 풀 전용이 아니다 — §3 참조.)

- **목표**: 설정을 **환경 적용 범위**로 그룹핑("모든 배포 공통" / "분산 워커 풀(LAN) 전용")하고, 풀 전용 그룹엔 설명 + 현재 컨트롤러 실행 모드(풀/단일) 배너를 달아, "어느 값이 내 배포에 적용되는가"를 한눈에 보이게 한다. 환경별 의미가 다른 공통 설정(`worker_capacity_vus`·`pool_keepalive_seconds`)엔 환경 주석을 단다.
- **비목표(연기)**: §7 참조. 백엔드 레지스트리에 scope 필드 추가·환경을 Windows/K8s로 세분·설정 동작 변경은 안 한다.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `/settings`를 환경 그룹 2개("모든 배포 공통" → "분산 워커 풀(LAN) 전용", 이 순서)로 1차 그룹핑하고, 각 그룹 안에서 조정 가능 → 읽기 전용 서브섹션으로 나눈다. | `SettingsPage.test.tsx`: 두 그룹 `<section>`(aria-label) 존재·순서, 각 그룹 내 조정/읽기 서브 헤더 | |
| R2 | MUST 설정→그룹 분류는 UI 정적 sparse 맵 `settingsEnv.ts`가 단일 소스다: **`is_pool_mode()` 게이트로 비-풀 배포에서 무효인 reaper 2종** `pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds` = `scope:"pool"`, **그 외 모든 key(`pool_keepalive_seconds` 포함) = 공통(미매핑 그래이스풀 폴백 `?? "common"`)**. | `settingsEnv.test.ts`: `scopeOf`가 reaper 2종=`"pool"`·`pool_keepalive_seconds`=`"common"`·임의 공통키=`"common"`·미매핑키=`"common"` | |
| R3 | MUST 각 설정 행은 `scopeOf(s.key)`로 자기 그룹에 배치된다(서버 설정 mutable·readonly + UI client-readonly 행 전부). pool 그룹은 reaper 2종(둘 다 mutable)뿐 → 읽기 전용 서브 없음; `pool_keepalive_seconds`(readonly)는 **공통** 그룹 읽기 전용 서브에 든다. | `SettingsPage.test.tsx`: `within(poolSection)`에 reaper 2종, `within(commonSection)`에 `worker_capacity_vus`·`pool_keepalive_seconds` 등 | |
| R4 | MUST 분산 풀 전용 그룹에 정적 설명("풀 모드(LAN 분산 워커)에서만 효과 — Windows 단일 exe·로컬 실행에서는 무시")을 단다. 이 설명은 reaper 2종에만 적용되며 `pool_keepalive_seconds`(전 모드 적용)는 이 그룹에 없으므로 오주장 없음. | `SettingsPage.test.tsx`: 풀 그룹 내 `ko.opsSettings.poolGroupNote` 텍스트 | |
| R5 | MUST 컨트롤러 실행 모드 배너를 표시한다: `usePoolWorkers().pool_mode===true`면 "현재 풀 모드로 실행 중 — 적용됨", `false`면 "현재 풀 모드 아님 — 미적용". 쿼리 미해결(loading)·에러면 배너를 **생략**(페이지 비차단). | `SettingsPage.test.tsx`: `usePoolWorkers` 모킹 3분기(true→active 문구 / false→inactive 문구 / error→배너 부재) | ✅ wire: 기존 `PoolWorkersResponseSchema.pool_mode`(읽기, 신규 0) |
| R6 | MUST 환경별 의미가 다른 공통 설정에 환경 주석을 단다: `worker_capacity_vus`("풀 모드에서는 이 값 대신 유휴 워커 수와 부하로 워커 수를 정함") + `pool_keepalive_seconds`("풀 전용 아님 — 전 모드 gRPC 워커 연결에 적용, 특히 LAN 풀 연결 복구에 중요"). | `SettingsPage.test.tsx`: 두 행에 각 `ko.opsSettings.envNote.*` 텍스트 | |
| R7 | MUST 모든 신규 사용자-노출 문구(그룹 라벨·서브 라벨·풀 설명·모드 배너·환경 주석)는 `ko.opsSettings.*` 카탈로그 경유다(ADR-0035, 인라인 영어/한국어 0). | `grep`로 신규 인라인 문자열 0·`ko.ts` 키 존재 | |
| R8 | MUST 설정 동작·범위·검증·와이어를 바꾸지 않는다: 백엔드(`crates/**`)·`proto`·migration·`ui/src/api/settings.ts`(`SettingSchema`)·`ui/src/api/schemas.ts` 0-diff. | `git diff` 상 해당 파일 무변경 단언 | ✅ (의도적 무변경) |
| R9 | MUST 기존 행 동작(저장/복원/범위 검증/`aria-invalid`/`변경됨` 배지/하트비트 apply-note·margin-hint)을 보존한다 — 그룹핑은 행을 **재배치만** 한다. | `SettingsPage.test.tsx`: 기존 저장·복원·범위·하트비트 힌트 테스트가 `within(group)` 스코핑으로 통과 | |

- **R5 seam**: `pool_mode`는 **이미** `PoolWorkersResponseSchema`(`ui/src/api/pool.ts`)가 파싱하는 필드이고 `usePoolWorkers`가 `/workers`에서 소비 중 → 신규 와이어 0(읽기 재사용). 그래서 S-D 응답파싱 갭이 발생하지 않는다(§6 라이브 판단의 근거).

---

## 3. 핵심 통찰 (설계 근거)

1. **정직한 taxonomy는 "공통 + 풀 전용" 2그룹이다(R1/R2).** 컨트롤러의 워커 오케스트레이션 모드는 셋(subprocess[로컬·Windows 단일 exe] / K8s Job / pool[LAN])이지만, 설정 관점에서 **Windows 단일 exe는 subprocess의 부분집합**(전용 설정이 따로 없음)이라 "Windows 섹션"을 만들면 거의 전부 공통과 중복된다. **비-풀 배포에서 진짜로 무효인 건 풀 reaper가 `is_pool_mode()`로 게이트하는 2종**(`pool_heartbeat_interval_seconds`·`pool_stale_timeout_seconds`, 리퍼 spawn이 `main.rs:297`/`in_process.rs:317` 게이트)뿐이다. **`pool_keepalive_seconds`는 풀 전용이 아니다** — gRPC 서버측 h2 keepalive를 *모든 모드에서 무조건* 설정하고(`main.rs:338-343`/`in_process.rs:362-363`, 게이트 밖), 단일 exe도 self-spawn한 subprocess 워커가 이 in-process gRPC 서버에 붙으므로 keepalive가 적용된다. 그래서 keepalive를 풀 그룹에 넣고 "무시"라 적으면 *정확도가 후퇴*한다(spec-plan-reviewer F1) → keepalive는 **공통** 그룹(읽기 전용)으로 두고 "전 모드 적용, 풀 연결 복구에 특히 중요"라는 정확한 주석을 단다. 결과적으로 "공통" + "분산 풀(reaper) 전용"이 코드 현실과 1:1이다. (사용자 검토에서 2그룹 모델 채택.)

2. **분류는 *프레젠테이션* 메타데이터라 UI에 둔다(R2/R8).** 설정의 *동작·범위*는 레지스트리(`settings.rs::SETTINGS`)가 단일 소스지만, *설명/효과 문구*는 이미 UI(`ko.opsSettings.desc`/`.effect`, key별)에 산다. 환경 분류는 같은 부류의 표시 메타데이터다 → UI 정적 맵이 자연스럽고, 백엔드·`schemas.ts` 0-diff(R8)로 위험이 최소다. 레지스트리에 `env_scope` 필드를 더하는 대안은 `SettingDef`+`SettingItem` DTO+Zod `.strict()`+전 fixture를 건드리는 additive 와이어 변경이라, 순수 표시 목적엔 과하다(사용자 검토에서 UI-only 채택).

3. **sparse 맵 + 그래이스풀 폴백이 "거짓 배지 불가"를 구조적으로 보장한다(R2).** 맵(`POOL_KEYS`)엔 pool reaper 2종만 명시하고 `scopeOf(key)=POOL_KEYS.has(key)?"pool":"common"`. 미래에 새 knob이 레지스트리에 추가되고 UI 맵을 안 고쳐도, 최악이 "공통으로 표시(배지 없음)"라 **거짓 '풀 전용' 배지는 발생 불가**(안전한 방향). 새 pool knob을 추가할 때 `POOL_KEYS`에 한 줄(맵이 `ko.opsSettings` 옆에 위치)만 더하면 된다.

4. **런타임 모드 배너가 사용자 원래 불만("어느 값이 내 환경 소속인지 모름")을 가장 직접 닫는다(R5).** 정적 그룹 라벨은 "이 설정이 *언제* 적용되나"를, 배너는 "*지금 내 컨트롤러*가 그 환경인가"를 답한다. `usePoolWorkers`(이미 존재·`pool_mode` 파싱 중)를 재사용하므로 신규 엔드포인트/Zod 0. loading/error에 배너 생략(graceful)이라 풀 엔드포인트 미가용(비-pool 빌드도 200 `{pool_mode:false}` 반환하므로 사실상 항상 옴)에도 페이지는 정상이다.

5. **그룹은 비접이식 메인 섹션이다(R1).** 자동메모리의 "optional 섹션은 접이식" 선호는 *선택적* 보조 섹션 대상이고, 운영 상한은 페이지의 본 콘텐츠라 접으면 핵심을 숨긴다 → 항상 표시. 접이식 default가 기존 RTL을 깨는 함정도 회피.

---

## 4. 변경 상세

> 전부 `ui/src/` 한정. 충족 R 태그로 역추적.

### 4.1 `ui/src/settings/settingsEnv.ts` (신규) — 충족 R: R2, R6
```ts
export type SettingScope = "common" | "pool";
// sparse: is_pool_mode()-게이트로 비-풀 배포에서 무효인 reaper 2종만 pool.
// pool_keepalive_seconds는 전 모드 적용이라 pool 아님(F1).
const POOL_KEYS = new Set<string>([
  "pool_heartbeat_interval_seconds",
  "pool_stale_timeout_seconds",
]);
export function scopeOf(key: string): SettingScope {
  return POOL_KEYS.has(key) ? "pool" : "common";
}
// 환경별 의미가 다른 공통 설정 → ko.opsSettings.envNote.* 키(없으면 주석 없음)
export type EnvNoteKey = "workerCapacityPoolIgnored" | "poolKeepaliveAllModes";
export const ENV_NOTE_KEY: Record<string, EnvNoteKey> = {
  worker_capacity_vus: "workerCapacityPoolIgnored",
  pool_keepalive_seconds: "poolKeepaliveAllModes",
};
```
- 순수 모듈(React/ko 의존 없음) — 테스트가 가볍고 `ko` 키는 소비처(`SettingsPage`)가 lookup.
- 테스트 경로는 **`ui/src/settings/__tests__/settingsEnv.test.ts`** 고정(vitest `include`=`src/**/__tests__/**`, `__tests__/` 밖이면 조용히 미실행 — ui/CLAUDE.md).

### 4.2 `ui/src/pages/SettingsPage.tsx` (재구성) — 충족 R: R1, R3, R4, R5, R9
- 기존 `mutable`/`readonly`(+`clientReadonly`) 도출은 유지. 그 위에 **그룹 분할**: `partitionByScope(rows)` 헬퍼(또는 인라인 `filter(scopeOf(s.key)===g)`)로 각 그룹의 mutable/readonly 행 집합을 만든다.
- 렌더 구조: 그룹 순서 `["common","pool"]` 고정 → 각 그룹의 mutable/readonly 행을 `scopeOf`로 분할. **서브섹션은 행이 있을 때만 렌더**(빈 서브 생략):
  - `<section aria-label={ko.opsSettings.groupCommon}>` `<h3>` + (조정 가능 서브 `<h4>subMutable`/`mutable.map(MutableRow)`) + (읽기 전용 서브 `<h4>subReadonly` + readonly 행 — `pool_keepalive_seconds` 포함).
  - `<section aria-label={ko.opsSettings.groupPool}>` `<h3>` + 풀 설명(`poolGroupNote`) + **모드 배너**(4.3) + 조정 가능 서브(reaper 2종)만(읽기 전용 행 없음 → 그 서브 미렌더). 풀 그룹에 행이 0이면(서버가 풀 설정을 안 줄 일은 없으나 방어) 섹션 자체 생략.
- **하트비트 apply-note + margin-hint**(현재 mutable 섹션 뒤 인라인, `settings?.find("pool_heartbeat_interval_seconds"/"pool_stale_timeout_seconds")` 전체 목록 lookup이라 그룹핑과 무관)는 **pool 그룹의 조정 가능 서브 안으로 이동** — interval/stale이 pool 전용이라 더 정확한 위치. `null`-guard(두 행 부재면 미렌더)는 그대로라 풀 행 없는 fixture에서도 안전(R-C).
- `MutableRow` 컴포넌트·readonly 행 마크업·draft/rowError state·저장/복원 mutation·`clearDraft`-on-success는 **무변경**(재배치만, R9).
- `ENV_NOTE_KEY[s.key]`가 있으면(`worker_capacity_vus`·`pool_keepalive_seconds`) 그 행 desc 아래 `ko.opsSettings.envNote[key]` 한 줄 추가(R6). 읽기 전용 행에도 주석을 달 수 있게 readonly 행 렌더를 envNote 대응.
- **테스트 인프라(R-A, 필수)**: `SettingsPage.test.tsx`는 전역 `fetch`를 one-shot 큐로 모킹한다. 무조건 발화하는 `usePoolWorkers()`가 `fetch("/api/pool/workers")` 2차 호출을 끼워 큐를 흐트러 기존 ~13 테스트를 깬다 → **`usePoolWorkers`를 파일 전역 `vi.mock("../../api/hooks", factory-spread)`로 모킹**(실 `useSettings`/`usePutSetting`/`useResetSetting`은 spread 보존 — 커스텀 에러/실훅 유지 패턴, ui/CLAUDE.md). 기본 반환 `{isSuccess:false}`(배너 미렌더·2차 fetch 0)로 기존 테스트 보호, R5 3분기만 per-test override.

### 4.3 모드 배너 (SettingsPage 내 소형 요소) — 충족 R: R5
- `const pool = usePoolWorkers();` (기존 훅). `pool.isSuccess` && `pool.data`일 때만 배너 렌더:
  - `pool.data.pool_mode===true` → `ko.opsSettings.modeActivePool`(녹색 계열 `bg-green-50/border-green-200`, roleless 정적 배지 — `/workers` stale 배지 컨벤션).
  - `false` → `ko.opsSettings.modeInactive`(회색 계열 muted). **주의**: `pool_mode:false`는 단일 exe·로컬뿐 아니라 K8s Job 배포도 포함하므로 문구는 "단일/로컬"이 아니라 "풀 모드 아님"으로 정확히.
- loading/error → null(배너 없음). 풀 그룹 `<h3>` 바로 아래 배치(가장 contextual).
- 폴링: `usePoolWorkers`는 `pool_mode`일 때 3s refetch — settings 페이지에서도 동일(작은 엔드포인트라 무해, 별도 변형 안 만듦).

### 4.4 `ui/src/i18n/ko.ts` `opsSettings` 확장 — 충족 R: R4, R5, R6, R7
신규 키(값 한국어):
- `groupCommon: "모든 배포 공통"`, `groupPool: "분산 워커 풀(LAN) 전용"`
- `subMutable: "조정 가능"`, `subReadonly: "읽기 전용"` (그룹 내 서브 헤더 — 짧은 신규 키)
- `poolGroupNote: "풀(LAN 분산 워커) 모드에서만 효과가 있습니다 — Windows 단일 exe·로컬 실행에서는 무시됩니다."`
- `modeActivePool: "● 현재 풀 모드로 실행 중 — 이 그룹 설정이 적용됩니다."`
- `modeInactive: "○ 현재 풀 모드가 아님 — 이 그룹 설정은 효과가 없습니다."`
- `envNote: {`
  - `workerCapacityPoolIgnored: "풀 모드에서는 이 값을 쓰지 않습니다 — 유휴 워커 수와 부하에 맞춰 워커 수를 정합니다."` (F2: "모두 사용" 과장 제거),
  - `poolKeepaliveAllModes: "풀 전용이 아닙니다 — 모든 배포의 gRPC 워커 연결에 적용되며, 특히 LAN 풀 워커의 끊긴 연결 감지·복구에 중요합니다."`
  - `}`
- **삭제(R-B 정리)**: 기존 `ko.opsSettings.mutableSection`/`readonlySection`은 그룹 재구성으로 더 이상 렌더되지 않아 **고아 키**가 된다 → 두 키 삭제(소비처는 `SettingsPage` 하나뿐, 본 슬라이스에서 신규 `groupCommon`/`subMutable` 등으로 대체). 삭제 후 `grep "mutableSection\|readonlySection" ui/src` = 0 확인.

---

## 5. 무변경 / 불변식 (명시)

- **백엔드 0-diff**: `crates/controller/src/settings.rs`(레지스트리)·`api/settings.rs`(DTO)·전 Rust·`proto`·migration 무변경(R8). 설정 동작·범위·검증·기본값 그대로.
- **와이어 0-diff**: `ui/src/api/settings.ts`(`SettingSchema`)·`ui/src/api/schemas.ts` 무변경. `pool_mode`는 기존 `PoolWorkersResponseSchema` 필드 재사용(신규 파싱 0).
- **행 동작 byte-identical**: `MutableRow`·저장/복원 mutation·draft `clearDraft` on success·`aria-invalid`/`aria-describedby`·`변경됨` 배지·하트비트 margin-hint 로직 동일(R9). 그룹핑은 *순서/컨테이너*만 바꾼다.
- **다른 페이지 0-diff**: `/workers`(`WorkerDashboardPage`)·`usePoolWorkers` 훅 정의 무변경(소비만 추가).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `SettingsPage.test.tsx`: 그룹 2개 `<section>` aria-label·DOM 순서(common 먼저), 각 그룹 내 조정/읽기 서브 헤더 | |
| R2 | `settingsEnv.test.ts`: `scopeOf` reaper 2종=`"pool"`·`pool_keepalive_seconds`=`"common"`·공통키 `"common"`·미매핑키 `"common"` | |
| R3 | `SettingsPage.test.tsx`: `within(poolSection)`에 reaper 2종, `within(commonSection)`에 `worker_capacity_vus`·`pool_keepalive_seconds` | |
| R4 | `SettingsPage.test.tsx`: pool 그룹 내 `poolGroupNote` 텍스트(keepalive 행은 pool 그룹에 부재) | |
| R5 | `SettingsPage.test.tsx`: `usePoolWorkers` 모킹 — true→`modeActivePool`, false→`modeInactive`, error/loading→배너 부재 | (시각 권장) |
| R6 | `SettingsPage.test.tsx`: `within(worker_capacity_vus 행)` workerCapacity 주석 + `within(pool_keepalive_seconds 행)` keepalive 주석 | |
| R7 | 신규 인라인 사용자-문구 grep 0 + `ko.opsSettings` 신규 키 존재 + `mutableSection`/`readonlySection` grep 0 | |
| R8 | `git diff --stat`로 `crates/`·`proto`·`*.sql`·`api/settings.ts`·`schemas.ts` 무변경 단언(리뷰) | |
| R9 | 기존 저장/복원/범위/하트비트-힌트 테스트가 `usePoolWorkers` 파일-모킹 + `within(group)` 스코핑 + 그룹 헤더 sentinel(`groupCommon`)로 갱신 후 통과 | |

- **라이브 검증 판단**: run-생성·리포트-파싱·엔진 경로를 **건드리지 않고**, `pool_mode`는 기존 스키마 재사용이라 신규 응답파싱 0(S-D 갭 부재) → **필수 아님**. 단 시각 재구성 슬라이스라 머지 전 Playwright 헤드리스 sanity 1회 권장(컨트롤러 띄워 `/settings`에서 ① 두 그룹 렌더·reaper 2종이 풀 그룹·keepalive가 공통 그룹 위치 ② pool 모드 vs 비-pool 모드 배너 문구 분기 ③ console Zod 0). UI-only diff·response-path 0이므로 생략 시 build-log에 근거 기록.
- 머지 전 `pnpm lint && pnpm test && pnpm build`(전체) green 필수.

---

## 7. 의도적 연기 (roadmap §UX1에 누적)

- **레지스트리 `env_scope` 백엔드 필드**: 분류를 `settings.rs::SettingDef`로 올려 "새 knob = 컴파일러가 분류 강제" 보장. 지금은 UI sparse 맵 + 그래이스풀 폴백으로 충분(거짓 배지 불가). 와이어 변경 가치가 생기면(예: 외부 도구가 scope 소비) 별도 슬라이스.
- **환경 taxonomy 세분(Windows / 로컬 멀티 / K8s / LAN 풀)**: 현재 효과 차이는 pool 게이트뿐이라 2그룹이 정직. subprocess 내부를 더 쪼갤 동작 차이가 생기면 재검토.
- **`max_open_loop_worker_count` 환경 주석**: 이 cap도 `worker_capacity_vus`와 **대칭으로 env-divergent**(둘 다 비-풀 fan-out에서만 소비, 풀 모드는 N을 부하로 도출해 비소비)다. 그래도 `worker_capacity_vus`만 주석을 다는 건 의도적 비대칭 — 전자는 사용자가 실제로 튜닝하는 *대표 fan-out 노브*라 풀-무시 사실이 헷갈리기 쉽고, 후자는 드물게 만지는 상한이라 혼란이 적다(YAGNI). 필요 시 `ENV_NOTE_KEY`에 한 줄로 확장(spec-plan-reviewer F3 명시).

---

## 8. 구현 순서 (plan 입력)

> 전부 UI-only(cargo 게이트 미발동). `tdd-guard`(루트 C-1)는 src 편집 전 pending test-path 파일을 요구하므로 **각 task의 테스트 파일을 먼저** 만든다(ui/CLAUDE.md). 커밋은 task별 green.

1. **Task 1 — 분류 맵 + ko 신규 키(추가만)**: `ui/src/settings/__tests__/settingsEnv.test.ts`(RED, 경로 고정) → `ui/src/settings/settingsEnv.ts`(`scopeOf` reaper 2종·`ENV_NOTE_KEY` 2종) + `ko.opsSettings` **신규 키 추가**(`groupCommon`/`groupPool`/`subMutable`/`subReadonly`/`poolGroupNote`/`modeActivePool`/`modeInactive`/`envNote`) → green 커밋. **`mutableSection`/`readonlySection`은 이 단계에서 삭제하지 않는다**(아직 `SettingsPage`·기존 테스트가 sentinel로 참조 → RED). 새 키는 아직 미소비라도 추가 무해(미사용 객체 키는 lint 무관).
2. **Task 2 — SettingsPage 그룹핑 재구성 + 모드 배너 + 환경 주석**: `SettingsPage.test.tsx` 갱신 — ① **`usePoolWorkers` 파일-전역 모킹**(factory-spread, 기본 `{isSuccess:false}`; R5 3분기 per-test override) ② mount sentinel `mutableSection`→`groupCommon` ③ 그룹 헤더·`within(group)` 행 스코핑(reaper 2종=pool·keepalive/capacity=common)·풀 설명·envNote 2종·기존 저장/복원/하트비트 rescope → `SettingsPage.tsx` 재구성 + `ko.ts`에서 `mutableSection`/`readonlySection` 삭제 → green 커밋. `pnpm lint && pnpm test && pnpm build` 전체 green + `grep "mutableSection\|readonlySection" ui/src`=0.
3. **마무리**: handicap-reviewer(UI-only·wire 0-diff 1:1 대조) → (보안 path-gate: 요청실행/템플릿/바인딩 무관 → N/A) → (라이브 시각 sanity 권장) → finish-slice.
