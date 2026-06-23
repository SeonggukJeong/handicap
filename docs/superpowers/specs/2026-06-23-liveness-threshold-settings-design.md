# 라이브니스 grace 임계값 `/settings` 런타임 가변 (B2)

- 날짜: 2026-06-23
- 상태: 설계
- 선행: G1a(run 진행 라이브니스 — `2026-06-23-run-progress-liveness-design.md` §3.7/§8), L6 ops-hardening(`pool_heartbeat_*` settings 레지스트리)
- ADR 영향: 없음(기존 settings 레지스트리·watchdog 메커니즘 재사용, 새 결정 없음)

## 1. 배경 / 목표

G1a는 run watchdog의 두 grace 임계값을 **CLI 전용 `OnceLock`**(`watchdog_grace`)에 두었다 — `--run-startup-grace-seconds`(기본 90s, A: startup 무부하 grace)와 `--run-backstop-grace-seconds`(기본 120s, B: 예상 종료 초과 backstop). G1a §3.7은 당시 `/settings` 표면을 0으로 유지하려고 의도적으로 settings 레지스트리 대신 OnceLock을 골랐고, §8에서 **"A/B/C 임계값을 재배포 없이 `/settings`로"** 를 B2 후속으로 명시했다.

이 슬라이스는 그 후속이다. 사용자 결정으로 스코프를 좁힌다:

- **A/B 서버 grace**(OnceLock) → 기존 settings 레지스트리로 이주해 **편집 가능**하게.
- **C 클라 stall 상수**(`runStall.ts`의 `STARTUP_STALL_MS`=15s, `MIDRUN_STALL_MS`=120s, advisory-only)는 **편집 불가**로 두되, `/settings`에 **readonly 행으로 표시**(가시성만; 단일소스는 `runStall.ts` 유지).

근거: A/B는 watchdog가 run을 **자동 `Failed`** 시키는 임계값이라(너무 빡빡=정상 slow run 오발동, 너무 느슨=hung run 잔류) 재배포 없는 튜닝에 실제 운영 가치가 있다. C는 advisory(배지/배너)뿐이라 가변화 가치가 낮고 가장 많은 plumbing(두 run 페이지의 fetch 결합·fallback drift)을 부른다 — 그래서 C는 "값을 보여만 주되 클라 단일소스 유지"로 한정한다.

비목표: C를 런타임 가변으로 만들기, per-run grace override, 진행 중 run의 grace live re-read.

## 2. 접근 — L6 heartbeat 선례 1:1

heartbeat 임계값(`pool_heartbeat_interval_seconds`/`pool_stale_timeout_seconds`)이 이미 이 패턴을 구현한다. B2는 그대로 따른다.

| 단계 | heartbeat(기존) | B2(신규) |
|---|---|---|
| 레지스트리 행 | `SETTINGS`에 2 knob(`settings.rs:92-111`) | `SETTINGS`에 2 knob 추가 |
| CLI 플래그 | `--pool-heartbeat-*`(`main.rs:95-100`) → `cli_seeds`(`main.rs:283-284`) | `--run-*-grace-seconds`(`main.rs:107-110`) **유지** → `cli_seeds`로 라우팅 |
| 우선순위 | DB override > CLI seed > 레지스트리 default(`SettingsState::build`) | 동일(레지스트리 메커니즘 그대로) |
| 읽기 | reaper가 매 tick `settings.pool_heartbeat_interval_seconds()` live read(`main.rs:318-319`) | `spawn_run`이 run마다 `settings.run_startup_grace_seconds()` read |
| REST | GET/PUT/DELETE `/api/settings`(`api/settings.rs`) | 코드 무변경(키 일반 처리) |
| UI | `SettingsPage` Mutable 섹션 자동 렌더 | 자동 렌더 + ko desc/effect 추가 |

핵심: A/B는 서로 **독립**(B의 heartbeat pair 제약 `check_heartbeat_pair` 같은 교차제약 없음)이라 `validate()`의 범위검사만으로 충분하다 — heartbeat보다 단순하다.

## 3. 설계

### 3.1 settings 레지스트리 행 (A/B) — `crates/controller/src/settings.rs`

`SETTINGS: &[SettingDef]`(`settings.rs:30`)에 2행 추가. `SettingDef` 필드(`settings.rs:17-27`): `key`/`label`/`group`/`min`/`max`/`unit`/`mutable`/`default`.

```rust
SettingDef {
    key: "run_startup_grace_seconds",
    label: "Run 시작 grace (startup 라이브니스)",
    group: Group::Limits,
    min: 10,
    max: 3600,
    unit: "초",
    mutable: true,
    default: 90,
},
SettingDef {
    key: "run_backstop_grace_seconds",
    label: "Run 백스톱 grace (예상 종료 초과)",
    group: Group::Limits,
    min: 10,
    max: 3600,
    unit: "초",
    mutable: true,
    default: 120,
},
```

- `label`은 ADR-0035에 따라 한국어(SettingDef에 보유 — heartbeat 행 `label: "풀 하트비트 ping 주기"` 선례). `label`은 백엔드가 DTO로 서빙 → UI가 그대로 표시.
- `group: Group::Limits`(`settings.rs:10` enum) — heartbeat와 동거. **현 `SettingsPage`는 group으로 레이아웃하지 않고 `mutable`로만 섹션을 나누므로 group 선택은 렌더에 영향 없음**(메타데이터). 기존 enum 멤버라 Zod enum(`["limits","test_run","scheduler"]`) 무변경.
- 범위 `min 10, max 3600`: A는 floor이고 실효 grace는 `max(floor, http_timeout+15)+leading_idle`로 도출되므로(§3.2) floor 하한 10이 정상 run을 오발동시키지 않는다(http_timeout 마진이 보호). B는 `run_duration + grace`라 grace는 예상시간 너머 여유 — 10~3600(1h)이면 충분. (값 자체는 운영자 판단 영역; 이 범위는 합리적 가드레일.)

**접근자 2개 추가**(heartbeat `pool_heartbeat_interval_seconds(&self) -> u64`, `settings.rs:284` 미러):

```rust
pub fn run_startup_grace_seconds(&self) -> u64 { /* RwLock snapshot read, 미설정 시 default 90 */ }
pub fn run_backstop_grace_seconds(&self) -> u64 { /* default 120 */ }
```

레지스트리 일반 메커니즘이 default/CLI-seed/DB-override 우선순위·범위검사·out-of-range fallback을 이미 처리하므로(`settings.rs` 기존 테스트 `cli_seed_overrides_registry_default`·`out_of_range_override_falls_back_to_cli_seed_not_registry_default`가 증명) 신규 코드는 행+접근자뿐.

### 3.2 spawn_run 읽기 경로 — `crates/controller/src/api/runs.rs`

`spawn_run`(runs.rs:683-687)이 grace를 OnceLock에서 읽던 한 줄을 settings로 교체:

```rust
// 변경 전 (683):
let (startup_floor, backstop_grace) = state.coord.watchdog_grace_config();
// 변경 후:
let startup_floor = std::time::Duration::from_secs(state.settings.run_startup_grace_seconds());
let backstop_grace = std::time::Duration::from_secs(state.settings.run_backstop_grace_seconds());
```

- 함수 `startup_grace_eff(&assignment.profile, startup_floor)`(정의 runs.rs:532)가 결과 변수 `startup_grace`(runs.rs:684)를 만들고, `backstop_total = run_duration_secs + backstop_grace`(runs.rs:685-687), 3개 enqueue 사이트(runs.rs:759/825/852)로 동일 `Duration` 전달 — **전부 무변경**(변수명 `startup_grace`도 유지). `enqueue` 시그니처도 무변경(여전히 `Duration` 2개 수신).
- `spawn_run(state: &AppState, …)`(runs.rs:551-552)는 `AppState`(`app.rs:19`, `pub coord`(21)·`pub settings: SettingsState`(27))를 받고, **이미 `state.settings.*`를 다수 사용**한다(runs.rs:203 `max_open_loop_worker_count()`·250 `worker_capacity_vus()`·383·411·484). 따라서 `state.settings.run_startup_grace_seconds()` 접근은 **추가 배선 없이 가능**. 테스트 하니스(runs.rs:1282-1289)도 이미 `coord`+`settings: seeded_for_test_with(...)`로 AppState를 빌드 → 배선 churn 0.
- 두 접근자 호출은 별개(heartbeat reaper의 `main.rs:318-319` 2-호출 선례). 사이의 TOCTOU 윈도우는 무해(A/B 독립).
- runs.rs 테스트 헬퍼(runs.rs:1255/1274)는 `startup_grace_eff(&p, Duration::from_secs(90))`로 **리터럴 floor**를 직접 넘기므로 OnceLock과 무관 → **무변경**.

### 3.3 OnceLock 제거 — `crates/controller/src/grpc/coordinator.rs`

A/B가 settings에서 오므로 OnceLock은 redundant → 단일소스 유지를 위해 제거:

- `CoordinatorState.watchdog_grace: Arc<OnceLock<(Duration,Duration)>>` 필드(coordinator.rs:224) + 초기화(coordinator.rs:239) 삭제.
- `set_watchdog_grace`(coordinator.rs:281-288)·`watchdog_grace_config`(coordinator.rs:290-294) 삭제.
- 이 OnceLock을 직접 테스트하던 1건(coordinator.rs:~1705-1716: `watchdog_grace_config()` 기본값 → `set_watchdog_grace(5,7)` → 재확인) 삭제 — 동등 검증(default/seed/override)은 §3.1 settings.rs 테스트가 담당.
- `run_watchdog`(coordinator.rs:1235~)·`enqueue`(coordinator.rs:716~)는 **무변경**(여전히 spawn_run이 계산한 `Duration`을 받음). 모든 enqueue 테스트 사이트(`LONG`/`TINY` 직접 주입)도 무변경.

### 3.4 main.rs CLI seed — `crates/controller/src/main.rs`

- `set_watchdog_grace(...)` 호출 + readback 로그 블록(main.rs:181-190) 삭제.
- `SettingsState::build`(main.rs:277)의 `cli_seeds` 슬라이스에 2 entry 추가(heartbeat seed `main.rs:283-284` 옆):
  ```rust
  ("run_startup_grace_seconds", args.run_startup_grace_seconds as i64),
  ("run_backstop_grace_seconds", args.run_backstop_grace_seconds as i64),
  ```
- CLI 플래그 정의(`ControllerArgs` main.rs:107-110, 기본 90/120)는 **유지** — 기존 배포/스크립트 하위호환 + seed 역할(DB override 부재 시 기본값). heartbeat가 CLI seed에 range-check를 안 하지만(`main.rs:264` 주석) A/B는 pair 제약이 없어 seed clamp 불필요(heartbeat의 `pool_stale_seed` clamp `main.rs:266-276` 같은 전처리 없음).

### 3.5 가변 의미론 — future-runs-only

grace는 `spawn_run` 시점에 캡처돼 watchdog 태스크에 고정 `Duration`으로 전달된다. 따라서 **`/settings` 변경은 그 이후 spawn되는 run에만 적용**되고, 진행 중 run은 spawn 당시 grace를 유지한다.

- per-run deadline 아키텍처에 맞는 정답: 진행 중 run을 설정 편집으로 소급 kill/사면하지 않는다.
- heartbeat reaper(상시 루프, 매 tick live-read)와 다른 이유 = watchdog는 per-run 고정 deadline. live re-read는 `run_watchdog`에 `SettingsState`를 엮어야 하고 의미론도 부정확 → 채택 안 함.
- 이 의미론은 UI에서 A/B HelpTip(`effect`) 문구로 노출(§3.6).

### 3.6 UI — A/B mutable 행 — `ui/src/i18n/ko.ts`

A/B는 `SettingsPage`의 Mutable 섹션(`SettingsPage.tsx:167-202`)에 **자동 렌더**(레지스트리 구동). 단 행 본문이 ko 카탈로그를 키-룩업하므로 ko 추가 필요:

- `ko.opsSettings.desc[key]`(`SettingsPage.tsx:64`) — 행 설명 `<p>`. 누락 시 빈 설명(crash 아님)이나 기존 행과 일관성 위해 **2 키 추가**.
- `ko.opsSettings.effect[key]`(`SettingsPage.tsx:44-45`, `key in effect`로 HelpTip 게이트) — A/B의 비자명 의미론(floor 도출·**future-runs-only** §3.5)을 설명하는 HelpTip **2 키 추가**.
- `label`은 백엔드 SettingDef에서 오므로 ko 불필요.

`SettingsPage.tsx`의 heartbeat 전용 apply-note 블록(`SettingsPage.tsx:204-225`)은 heartbeat 키에 한정 → A/B 무영향(변경 없음).

### 3.7 UI — C readonly 클라 행 — `ui/src/pages/SettingsPage.tsx`

C 임계값을 readonly로 표시하되 **단일소스 = `runStall.ts`**(drift 0). `SettingsPage`가 `runStall.ts` 상수를 import해 `Setting`-형 객체 2개를 클라에서 구성, `readonly` 목록(`SettingsPage.tsx:139`)에 concat:

```ts
import { STARTUP_STALL_MS, MIDRUN_STALL_MS } from "../api/runStall";
// ...
const clientReadonly: Setting[] = [
  { key: "run_midrun_stall_seconds", label: ko.opsSettings.runMidrunStallLabel,
    group: "limits", value: MIDRUN_STALL_MS / 1000, default: MIDRUN_STALL_MS / 1000,
    min: 0, max: MIDRUN_STALL_MS / 1000, unit: "초", mutable: false, source: "readonly" },
  { key: "run_startup_stall_seconds", label: ko.opsSettings.runStartupStallLabel,
    group: "limits", value: STARTUP_STALL_MS / 1000, default: STARTUP_STALL_MS / 1000,
    min: 0, max: STARTUP_STALL_MS / 1000, unit: "초", mutable: false, source: "readonly" },
];
const readonly = [...(settings?.filter((s) => !s.mutable) ?? []), ...clientReadonly];
```

- Readonly 섹션 렌더(`SettingsPage.tsx:235-248`)는 `s.label`/`s.value`/`s.unit` + `ko.opsSettings.readonlyNote`만 표시(desc/HelpTip 없음) → C 행은 label(ko) + value(runStall.ts) + 단위 + 노트로 깔끔히 렌더. `pool_keepalive_seconds` 기존 readonly 행과 동일 형태.
- `key`는 클라 전용(백엔드 `run_*_grace_seconds`와 충돌 없음). React key 용도뿐 — readonly 렌더는 desc/effect를 안 본다.
- **라벨 출처(중요)**: readonly 행 렌더(`SettingsPage.tsx:240`)는 `s.label`을 **직접** 표시한다(mutable 행의 `ko.opsSettings.desc`/`effect` 키-룩업 경로 아님). 따라서 C 행의 `label`은 위 클라 리터럴이 `ko.opsSettings.runStartupStallLabel`/`runMidrunStallLabel`에서 가져온다 → **이 2 라벨 키를 반드시 추가**(누락 시 readonly 라벨이 `undefined`로 빈칸).
- 단위 변환: `runStall.ts`는 ms, 표시는 `/1000` 초. 상수는 그대로(단일소스), 표시 시 변환.
- A/B(Mutable 섹션)와 C(Readonly 섹션)는 서로 다른 섹션에 뜬다(현 페이지의 mutable/readonly 분할). group으로 묶지 않음 — 페이지 재구조화는 비목표.

### 3.8 migration / Zod / wire

- **Migration 0**: `settings` 테이블(migration 0017)이 이미 존재. 신규 knob은 코드 행(`SETTINGS` const). override만 기존 테이블에 키로 저장.
- **Zod 0**: `SettingSchema`(`ui/src/api/settings.ts:17-30`) generic(`key: z.string()` 등) + `group` enum에 `"limits"` 존재 → A/B DTO 무변경 통과. C 행은 API/Zod를 안 거치는 클라 구성 객체.
- **proto/engine/worker 0**: watchdog는 컨트롤러 전용. 워커·엔진·proto 무관.

## 4. 불변식 (acceptance)

- **R1** A/B 두 행이 `GET /api/settings` 응답에 `mutable:true`·`group:"limits"`·default 90/120·범위 10~3600으로 노출되고 `PUT /api/settings/run_startup_grace_seconds`(범위 내)가 200 + DB 영속, 범위 밖은 `validate()`로 400.
- **R2** `DELETE /api/settings/run_startup_grace_seconds`가 override 제거 → 값이 CLI seed(미설정 시 레지스트리 default 90)로 복원.
- **R3** `spawn_run`이 A/B grace를 **`state.settings`에서** 읽는다(OnceLock 아님). `watchdog_grace`/`set_watchdog_grace`/`watchdog_grace_config` 심볼이 코드베이스에서 **0건**(grep).
- **R4** A/B 변경은 **이후 spawn run에만** 적용(spawn 시점 캡처). 진행 중 run 무영향. (의미론 — §3.5, UI HelpTip 노출.)
- **R5** healthy run(설정 미변경)은 B2 전과 **동작 byte-identical** — 기본 90/120이 그대로 도출되므로 grace 도출·watchdog 발동 시점 불변.
- **R6** `SettingsPage`가 C 임계값 2개를 **Readonly 섹션**에 표시하고, 그 값이 `runStall.ts` 상수(`STARTUP_STALL_MS`/`MIDRUN_STALL_MS`)에서 직접 온다(중복 상수 정의 0 — grep로 `120_000`·`15_000` 리터럴이 SettingsPage에 없음, runStall import만).
- **R7** C stall 계산(`classifyRunStall`/`computeRunStall`)·RunDetailPage 배너·ScenarioRunsPage 배지 **무변경**(runStall.ts 동작 byte-identical).
- **R8** migration 0 · proto/engine/worker 0 · Zod `SettingSchema` 0 · enqueue/run_watchdog 시그니처 0.

## 5. 테스트

- **단위(settings.rs)**: 신규 접근자 `run_startup_grace_seconds()`/`run_backstop_grace_seconds()`가 ① 레지스트리 default(90/120) ② CLI seed override ③ DB override ④ out-of-range override → seed fallback 을 반환하는지(기존 일반 테스트 패턴 `seeded_for_test_with` 재사용).
- **단위(coordinator.rs)**: watchdog 타이머 테스트(`enqueue`에 sub-second `Duration` 직접 주입, 실타이머)는 무변경 통과. OnceLock 테스트 1건 제거.
- **API(controller)**: `PUT`/`DELETE /api/settings/run_*_grace_seconds` 라운드트립(200/400/복원) — 기존 settings API 테스트 패턴 미러. **pair 제약 없음은 구조적으로 단언**(A/B는 `check_heartbeat_pair` 경로에 진입 안 함): 한 A/B 키를 in-range PUT → 200이고 **형제 키 값 불변**(heartbeat의 stale>interval 같은 교차거부 없음을 negative-API 대신 형제-불변으로 입증).
- **RTL(SettingsPage)**: ① C 2행이 Readonly 섹션에 `runStall.ts` 값(120초/15초)으로 렌더 ② A/B 2행이 Mutable 섹션에 입력+저장 버튼으로 렌더(desc/HelpTip 존재). C 값은 `runStall.ts` mock이 아니라 실제 import 값으로 단언(단일소스 증명). **tdd-guard 순서(ui/CLAUDE.md)**: SettingsPage 테스트 파일을 `SettingsPage.tsx`/`ko.ts` src 편집보다 **먼저** 수정해 pending RED diff를 만든 뒤 src 편집(첫 src 편집 차단 회피) — plan task 순서에 반영.
- **게이트(orchestrator 직접 재실행)**: `cargo nextest run -p handicap-controller` + `cargo build --workspace` + UI `pnpm lint && pnpm test && pnpm build`.

## 6. 라이브 검증 (필수 — spawn_run 경로 변경, S-D 갭)

`/live-verify` 스택(워크트리 자체 바이너리 + responder + 격리 DB):

1. **설정 흐름**: 컨트롤러 기동 → `GET /api/settings`에 A/B/C 4행 확인(A/B mutable·C readonly·값) → `PUT /api/settings/run_backstop_grace_seconds {value: <작은값, 예 10>}` 200.
2. **spawn_run 반영(핵심)**: 짧은 `duration_seconds`(예 5s)의 run을 `kill -STOP`된(또는 무응답) 워커로 발사 → backstop이 **기본 120s가 아니라 설정한 ~`duration+10`s**에 `Failed`(사유 message 포함)되는지 확인. = 설정값이 spawn_run→watchdog로 흐름 입증.
3. **영속**: PUT 후 `GET`이 `source:"override"`·새 값 반영, (선택) 컨트롤러 재기동 후에도 DB override 생존.
4. **healthy byte-identical**: 설정 미변경 run은 정상 완료(grace 오발동 0).
5. **UI(선택, Playwright)**: `/settings` 페이지가 A/B 편집 가능 행 + C readonly 행 렌더, Zod 콘솔 0.

startup-A 경로는 `http_timeout+15`가 지배해 라이브 발동이 느리므로(G1a 노트) backstop-B 경로로 설정-흐름을 입증(동일 plumbing). 정확한 시나리오/responder 세부는 plan에서.

## 7. 연기 / 후속

- **C 런타임 가변**(15s/120s를 편집 가능하게) — run 페이지 fetch 결합·fallback drift 비용이라 advisory 가치 대비 보류.
- **per-run grace override**(run config에 grace 필드).
- **진행 중 run live re-read**(watchdog에 SettingsState 주입).
- **liveness 전용 group**으로 A/B/C를 한 묶음 표시(현 페이지 mutable/readonly 분할 재구조화).
- G2(k8s register-전 reaper) — 별개 라이브니스 후속.

## 8. 파일별 변경 요약

| 파일 | 변경 |
|---|---|
| `crates/controller/src/settings.rs` | `SETTINGS` 2행 + 접근자 2개 |
| `crates/controller/src/api/runs.rs` | spawn_run grace 읽기 1줄 교체(683) |
| `crates/controller/src/grpc/coordinator.rs` | OnceLock 필드·set/get·테스트 1건 제거 |
| `crates/controller/src/main.rs` | set_watchdog_grace 블록 삭제, cli_seeds 2 entry 추가, CLI 플래그 유지 |
| `ui/src/pages/SettingsPage.tsx` | C readonly 행 2개 주입(runStall import) |
| `ui/src/i18n/ko.ts` | A/B desc·effect 4키 + C 라벨 2키 |
| migration / proto / engine / worker / Zod | **0** |
