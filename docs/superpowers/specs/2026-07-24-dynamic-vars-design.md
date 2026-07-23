# 생성 변수 (dynamic-vars) — 설계

- 날짜: 2026-07-24 · 유형: **user-path** · 워크트리: `dynamic-vars`
- 목업: `.superpowers/brainstorm/1344-1784818222/content/variables-generator-layout*.html` (C안 확정)
- 관련: ADR-0013(시나리오/RunConfig 분리)·ADR-0014(변수 표기)·ADR-0022(데이터셋 바인딩)·ADR-0029(캐스트)

## 사용자 스토리 (US)

- **US1**: QA가 "체크인=오늘+7일" 같은 실행-시점 날짜가 필요한 예약/조회 API 시나리오에서, 지금은 run 돌리기 전마다 변수 값을 손으로 고쳐야 한다 — 성공하면 `checkin`을 날짜 생성기(형식·오프셋·타임존)로 한 번 선언해 두고, 언제 실행해도 그날 기준 날짜(예: `2026-07-31`)가 요청 와이어에 실려 나가는 것을 test-run trace/에코 서버에서 본다.
- **US2**: QA가 수량·금액 필드에 반복마다 다른 값을 넣고 싶을 때(캐시/중복 회피) — 금액처럼 특정 단위(100원 단위 등)로만 유효한 값도 포함 — 지금은 데이터셋 파일 우회뿐이다. 성공하면 `qty`를 랜덤 정수(min~max, 단위 step)로 선언하면 반복마다 격자 위의 다른 값이 나가고, 같은 반복 안의 두 스텝은 같은 값을 공유함을 trace에서 확인한다.
- **US3**: QA가 주문번호처럼 매번 유일해야 하는 필드에 지금은 `${vu_id}`/`${iter_id}` 조합 같은 수공 우회를 쓴다 — 성공하면 `order_ref`를 UUID/랜덤 문자열로 선언해 반복마다 유일한 값이 전송되는 것을 본다.
- **US4**: QA가 형식 문자열(`%Y-%m-%d` 등)이 맞는지 실행 전엔 알 수 없다 — 성공하면 변수 행을 펼쳐 형식/오프셋/타임존을 고치는 즉시 "예:" 샘플이 갱신돼, run 없이 형식 실수를 잡는다.

(YAML 양방향 왕복 보존은 US1~3의 수용 기준 — ADR-0003 불변식.)

## 1. 문제

시나리오 변수(`{{var}}`)의 값 소스는 정적 문자열·데이터셋 행·extract뿐이다. "실행 시점에 생성되는 값"(오늘 날짜, 범위 내 랜덤 수, 유일 ID)은 표현할 수 없어 QA가 매 실행 전 시나리오를 수동 편집하거나 데이터셋 파일을 우회 제작한다.

## 2. 목표 / 비목표

**목표**: `variables` 선언을 확장해 변수를 4종 생성기(날짜/시간·랜덤 정수·UUID·랜덤 문자열)로 선언 — 반복(iteration)마다 평가, 사용은 기존 `{{var}}` 그대로. GUI(변수 패널)와 YAML 양방향 sync.

**비목표(v1 연기)**: 리스트 랜덤 선택(사용자 제외) · 인라인 함수 토큰(`${random(1,100)}` — B안, 필요 시 후속) · 시드 재현성(`think_seed` 선례로 후속 가능; v1은 엔트로피) · 복합 오프셋(`+1d2h`) · 요청 위치마다 새 값(per-use) · `random_string` 문자군 선택.

## 3. 모델·와이어 (엔진 `scenario.rs`)

`Scenario.variables: BTreeMap<String, String>` → `BTreeMap<String, VarDecl>`.

```rust
enum VarDecl { Static(String), Gen(GenSpec) }   // 수동 serde: string ↔ map
enum GenSpec {                                   // #[serde(tag = "gen")] 내부 태그
    Date { format, offset, tz },                 // 전부 Option — 기본값 아래 표
    RandomInt { min, max, step },
    Uuid {},
    RandomString { length },
}
```

YAML: 값이 **문자열이면 정적**(현행 그대로), **`gen:` 키를 가진 맵이면 생성기**.

```yaml
variables:
  base_url: "https://api.example.com"        # 정적 (불변)
  checkin: { gen: date, format: "%Y-%m-%d", offset: "+7d", tz: "Asia/Seoul" }
  ts:      { gen: date, format: unix_ms }
  qty:     { gen: random_int, min: 1000, max: 10000, step: 100 }
  order_ref: { gen: uuid }
  tag:     { gen: random_string, length: 12 }
```

**serde 규칙** (레포 함정 준수):
- `VarDecl`은 수동 `Serialize`/`Deserialize`(`Body`/`Condition` 선례) — `Static`은 **plain string으로 emit**(기존 시나리오 파싱·재직렬화 byte-identical), 맵이면 `GenSpec`으로 위임.
- `GenSpec`은 내부 태그(`tag = "gen"`, `Extract` 선례 round-trip OK) + **variant별 `deny_unknown_fields`**(내부 태그는 enum 레벨 강제 안 됨 함정).
- round-trip 프로퍼티 테스트(`from_yaml(to_yaml(s)) == s`)에 생성기 변수 케이스 추가.

### 3.1 생성기 파라미터·기본값·검증

| gen | 파라미터 | 기본값 | 검증(파싱 시 거부) |
|---|---|---|---|
| `date` | `format`: strftime 문자열 또는 sentinel `unix`/`unix_ms` · `offset`: `^[+-]\d{1,9}[smhd]$` · `tz`: IANA 이름 | `format="%Y-%m-%d"` · `offset` 없음 · `tz` 없음=**워커 로컬** | strftime 유효성(chrono `StrftimeItems`에 `Item::Error` 없음) · offset 정규식 · `tz`는 chrono-tz 파싱 성공 |
| `random_int` | `min`,`max`: i64 · `step`: u32 | `step=1` | `min ≤ max` · `step ≥ 1` |
| `uuid` | 없음 | — | — |
| `random_string` | `length`: u32 | `length=8` | `1 ≤ length ≤ 64` |

- `unix`/`unix_ms`는 `format` 값의 sentinel — 오프셋 적용 후 epoch 초/밀리초(타임존 무관·`tz`가 있어도 no-op).
- `random_int` 값 집합 = `{ min + k·step | k ≥ 0, min + k·step ≤ max }` 균등 선택 — **anchor는 min**("1의 자리 고정"은 min이 결정). `step > max−min`이면 항상 `min`(허용). 오버플로는 i64 checked 산술로 방어.
- `random_string` 문자군 = `[a-z0-9]` 고정.
- `uuid` = UUIDv4 소문자 하이픈 표기. 생성은 VU rng 16바이트 + version/variant 비트(`uuid` crate `Builder::from_random_bytes` 또는 등가 수동 구현 — `getrandom` 직접 의존 없이 rng 일원화).

**의존성**: 엔진 `Cargo.toml`에 `chrono`/`chrono-tz` 추가(워크스페이스에 이미 있음 — controller 스케줄러가 사용 중). `rand`는 기존.

## 4. 평가 의미론 (엔진)

- **평가 시점 = 반복 시드**: `iter_vars` 시드 4곳 — `runner.rs:397`(run_vu)·`:1125`(vu_curve)·`:1478`(open-loop arrival)·`trace.rs:251`(test-run) — 의 `scenario.variables.clone()`을 공유 헬퍼 `seed_iter_vars(&scenario.variables, &mut rng)`로 교체. 생성기는 반복 시작마다 평가돼 그 반복 동안 고정(US2 "두 스텝 같은 값"). Static은 clone(현행과 동일 값).
- **우선순위 불변**: 생성/정적 변수 < 데이터셋 바인딩(시드 직후 덮어씀) < extract. `VariablesPanel` "추출 덮어씀" 배지·바인딩 충돌 로직은 키 기준이라 무변경.
- **RNG**: VU별 독립(3개 부하 진입점 각각의 VU 루프 스코프), trace는 패스당 entropy rng 1개. 시드 재현성은 비목표(§2).
- **parallel**: 분기는 entry 스냅샷 clone — 같은 반복 = 같은 값(추가 작업 없음).
- **런타임 무오류**: 파라미터는 파싱 시 검증 완료(§5)라 생성 자체는 infallible(chrono format은 사전 검증된 items로 수행). date 계산의 이론적 edge(오프셋 오버플로)는 checked 산술 + 포화로 처리하고 run을 죽이지 않는다.
- **template.rs·cast.rs 0-diff**: 생성은 시드 레이어에서 끝난다 — 렌더러 문법·3진입점·UI resolver lockstep 함정을 구조적으로 회피. `{{qty:num}}` 캐스트는 생성 값(십진 문자열)에 자연 적용(시너지).

## 5. 검증 게이트 — "parse, don't validate"

잘못된 생성기(미지원 `gen`·잘못된 format/offset/tz·`min>max`·`step=0`·length 범위 밖·`gen` 맵의 미지 키)는 **`GenSpec` Deserialize에서 거부**(derive wire-struct + `try_from` 변환 또는 커스텀 visitor — 구현은 plan). 따라서 `Scenario::from_yaml`이 곧 게이트:

- 시나리오 create/update(`api/scenarios.rs:130/198`) → 400
- test-run(`api/test_runs.rs`) → 422
- run 생성 `validate_run_config`(`api/runs.rs:171`)·`spawn_run`(`:571`) → 저장분 방어
- 워커 YAML 수신 → 파싱 실패 시 기존 실패 경로

별도 validator 함수 0개. 에러 메시지는 serde 문구에 필드 컨텍스트가 실리도록 variant/필드명 유지(한국어 게이트 매핑은 기존 `problems.ts` 확장 범위 밖 — UI Zod가 선제 차단하므로 서버 문구 도달은 curl/손편집 한정).

## 6. UI — 변수 패널 C안 (요약 행 + 그 자리 펼침)

### 6.1 행 상태 (`VariablesPanel` declared 행 확장)

- **모든 선언 행에 ▸/▾ 접힘 토글** 추가. 접힘 상태:
  - 정적: 현행 그대로(이름·✎·×·값 textarea·사용처) — 정보 손실 없음.
  - 생성기: [이름 · 타입 배지(`날짜`/`랜덤 정수`/`UUID`/`랜덤 문자열`, indigo-50 계열) · ×] + [한 줄 요약 · `예:` 샘플] + 사용처. 요약 예: `오늘+7일 · Asia/Seoul`, `1000 ~ 10000 · 100 단위`(step=1이면 단위 생략).
- **펼침 상태**: 타입 select(정적 값/날짜·시간/랜덤 정수/UUID/랜덤 문자열) + 타입별 필드:
  - 날짜: 형식 프리셋 select(날짜=`%Y-%m-%d` / 날짜+시각=`%Y-%m-%dT%H:%M:%S` / 유닉스 초=`unix` / 유닉스 ms=`unix_ms` / 직접 입력…) + 직접 입력 시 형식 문자열 input + 오프셋 input + 타임존 select(`Asia/Seoul`/`UTC`/`워커 로컬`) + 샘플. 프리셋에 없는 형식 문자열이 YAML에서 오면 "직접 입력"으로 표시(read 보존).
  - 랜덤 정수: 최소/최대/단위 3필드 + 샘플. UUID: 샘플만. 랜덤 문자열: 길이 + 샘플.
  - 정적: 값 textarea(접힘과 동일 — 펼침은 타입 전환 통로).
- 타입 전환(정적↔생성기, 생성기 간)은 펼침의 타입 select로 — YAML엔 스칼라↔맵 교체로 커밋. 미정의 ⚠ "선언 추가"는 현행대로 정적 `""` 추가.
- 접힘 상태는 컴포넌트 로컬 state(영속화 비목표 — B13 변수 접힘 선례).

### 6.2 편집·커밋 규약 (기존 이디엄 준수)

- 텍스트/숫자 입력은 draft + commit-on-blur(F5), min/max 짝은 **`useThinkTimePair` 훅 재사용 또는 동형 보류 규칙**(`relatedTarget`이 짝이면 보류 — pair-input-blur-commit 선례). step·length는 단독 필드라 일반 draft-blur.
- select(타입·프리셋·타임존)는 즉시 커밋(구조 변경 — ExtractEditor 선례).
- `yamlError !== null`이면 새 어포던스 전부 disabled(기존 게이트 이디엄). rename ✎·사용처 nav·× 삭제·검색은 생성기 행에도 현행 그대로(검색 매치 대상: 이름 + 생성기 요약 문자열).
- 모든 신규 문구·aria-label은 `ko.ts` 경유(ADR-0035). 타입 배지/요약은 표시 전용 단일 소스 헬퍼(예: `genSummary(spec)`)로 — `formatThink` 선례.

### 6.3 샘플 미리보기 ("예:")

- 클라이언트 순수 함수로 즉시 계산(파라미터 변경·펼침 시 재생성). 서버 왕복 없음.
- **날짜 형식은 클라 strftime 부분집합만 지원**: `%Y %y %m %d %H %M %S %s %%` + 리터럴(비-% 텍스트). 부분집합 밖 토큰(`%j`, `%b` 등 chrono는 유효)이 있으면 **틀린 샘플 대신 "미리보기 불가 — 실행 시 적용" 표시**(거짓 미리보기 금지). 서버(chrono) 판정이 항상 권위 — UI가 미리보기를 포기해도 저장은 막지 않는다(엔진이 유효하면 400 없음).
- 타임존 변환은 `Intl.DateTimeFormat(timeZone)` formatToParts — `워커 로컬` 선택 시 브라우저 로컬로 근사하고 캡션에 "실행 워커 기준" 병기.

### 6.4 모델·sync (`model.ts`/`yamlDoc.ts`/`scanVars.ts`)

- Zod: `variables: z.record(z.string(), z.union([z.string(), GenSpecModel]))`. `GenSpecModel` = `gen` discriminatedUnion + `.strict()` — 검증 규칙 §3.1과 lockstep(min≤max는 `.superRefine`).
- `yamlDoc.ts`: `setVariable(key, string)` 유지 + 생성기 커밋용 edit(스칼라↔맵 교체는 `doc.setIn`으로 맵 노드 생성 — 주석 보존은 해당 키 노드 교체 한도). rename은 키 rename이라 무변경.
- `scanVars.ts`: 선언 키 판정(`Object.keys`) 무변경. 값 문자열을 읽는 지점(검색 등)은 정적/생성기 분기(요약 문자열로 대체).
- GUI로 날짜 변수를 만들면 **`tz`를 항상 명시 기록(기본 `Asia/Seoul`)** — 엔진의 "생략=워커 로컬"이 K8s pod에서 UTC가 되는 함정 회피. YAML 손편집 생략은 워커 로컬(§3.1). GUI 타임존 select의 `워커 로컬` 선택 = `tz` 키 제거.
- `variables`를 소비하는 다른 표면(`DataBindingPanel` 충돌 검사·`InsertTemplateModal` 파라미터화 등)은 키 기준이면 무변경, 값 문자열 가정 지점은 plan에서 전수 grep해 분기(tsc가 union으로 전부 적발 — `pnpm build` 게이트).

### 6.5 표시/진단 표면 — 무영향 확인

`resolveForDisplay` 호출부(ReportView·RunDetailPage)는 **envMap만** 치환하고 흐름 변수 `{{var}}`는 원래 비치환(실측 확인) — 생성기 변수 도입으로 거짓 진단이 생길 표면 없음. 실값 확인은 test-run trace(기존 기능)가 담당.

## 7. 호환성·범위

- **byte-identical**: 생성기 미사용 시나리오는 파싱·재직렬화·실행 전 경로 불변. proto·migration·controller store·워커 코드 0-diff(워커는 엔진 재컴파일만).
- **옛 워커 바이너리**는 새 문법을 못 읽는다 — 기존 함정 그대로("모델 변경 후 `cargo build -p handicap-worker` 필수", run 즉시 failed + message).
- 보안 게이트: diff가 `crates/engine/src/trace.rs`·시나리오 파싱을 건드리므로 `finish-slice §0` grep 매치 예상 → `security-reviewer` 필수로 계획. 생성 값은 시크릿 아님·마스킹 무관(§B1 범위 밖).

## 8. 테스트 전략

- 엔진: `VarDecl`/`GenSpec` round-trip(정적 문자열 byte-identical 포함) · 검증 거부 케이스(표 §3.1 각 1+) · `seed_iter_vars` 단위(빈도 아닌 **값 집합/격자 소속** 단언 — `random_int` step 격자, string 길이/문자군, uuid v4 포맷 regex, date 고정 시각 주입식) · 반복마다 재평가(2회 시드 값 상이 — uuid) · 세 부하 진입점 배선(Mode::{Closed,Curve,Open} 직접 spawn — "run_scenario만 테스트하면 곡선/open 누락이 green" 함정) · trace 시드.
- 컨트롤러: create 400/test-run 422(잘못된 gen) 통합 테스트.
- UI: GenSpecModel 검증 · 패널 행 상태(접힘/펼침·요약·배지) RTL · 커밋 경계(blur·select 즉시) · 샘플 부분집합 폴백 · YAML 왕복(맵↔스칼라). 회귀 가드는 이빨 실증(RED→GREEN) 의무.
- 날짜 형식 실측: chrono `%Y년 %m월 %d일` 같은 리터럴 혼합 케이스 포함.

## 9. 라이브 검증 (US 척추)

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 날짜 생성기(`offset:+7d`·`Asia/Seoul`) 선언 → 로깅 에코 서버로 run | 와이어에 오늘+7일 날짜 문자열 |
| US2 | `random_int(1000,10000,step:100)` 2-스텝 시나리오 → test-run trace | 두 스텝 같은 값·100 격자·trace 재실행 시 다른 값 |
| US3 | uuid 변수 → 다반복 run 에코 로그 | 반복 수만큼 유일 값 |
| US4 | 에디터에서 형식 `%Y년 %m월 %d일` 입력 | 샘플 즉시 갱신·미지원 토큰(`%j`) 입력 시 "미리보기 불가" |

에디터 마운트 양 진입 화면(`/scenarios/new`·`/scenarios/{id}`) 모두 확인([[live-verify-all-mount-paths]]).

## 10. 열린 질문

없음 — 파라미터 기본값·문자군·타임존 기본 정책은 사용자 승인 완료(2026-07-23~24 brainstorming).
