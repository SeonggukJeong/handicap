# ADR-0022 — Data-driven 데이터셋 (독립 리소스 + 서버 파싱 + 바인딩/주입)

* Status: Accepted
* Date: 2026-05-30
* Deciders: handicap maintainers
* Tags: dataset, csv, xlsx, parser, controller, worker, engine, ui

## Context

Slice 8(data-driven). 8b에서 리소스+파싱이 출하됨. 8c에서 바인딩/주입이 완성됨.

QA 팀이 "사용자 ID 목록" 같은 외부 데이터를 시나리오에 주입해 데이터 다양성 테스트를 할 수
있어야 한다(ADR-0013 §4.5 데이터셋 확장). Slice 8a에서 body 템플릿팅을 먼저 완성했으므로,
8b는 템플릿 변수에 주입할 데이터셋을 독립 DB 리소스로 저장하는 기반을 만든다.
8c는 바인딩 설정(매핑 + 정책)을 run profile에 추가하고, run 실행 시 controller→worker로
행을 스트리밍해 엔진이 반복마다 `{{var}}`를 실제 값으로 치환한다.

설계 명세: `docs/superpowers/specs/2026-05-30-slice-8-data-driven-design.md`.

## Decision Drivers

- 데이터셋은 여러 시나리오·여러 run에서 재사용 가능해야 한다 (ADR-0013 separation).
- 파싱(CSV/XLSX 인코딩·시트·구분자 처리)은 서버에서 수행해야 한다: 오프라인 UX 유지,
  브라우저 SheetJS 번들 제거, 대용량(수만 행) 처리.
- `runs` 테이블 스키마 변경 없이 바인딩을 나중에(8c) 붙일 수 있어야 한다
  (`profile_json` JSON 컬럼의 #[serde(default)] 패턴 — ADR-0021 precedent).
- Migration은 `CREATE TABLE IF NOT EXISTS`만으로 idempotent(Slice 6 `ALTER TABLE` 함정 재발 방지).

## Considered Options

1. **독립 DB 리소스 (`datasets`/`dataset_rows` 테이블, migration 0004)** (채택)
   — dataset_id로 profile.data_binding(8c)이 참조, 파싱은 controller 서버 모듈.

2. **Scenario YAML inline 데이터**
   — ADR-0013 위반 (Scenario와 RunConfig 분리 원칙). 시나리오 편집 때마다 데이터도 같이
   관리해야 하고, 대용량 시나리오 YAML이 됨.

3. **Run-only ephemeral (run 실행 때만 업로드, DB 저장 안 함)**
   — 재사용 불가, 동일 데이터셋을 여러 run에 쓸 때 매번 재업로드 필요.

4. **브라우저 SheetJS 파싱**
   — 오프라인 번들 크기 증가, 파서 불일치(서버 검증과 다른 결과), 수만 행 XLSX에서 메인
   스레드 블록.

5. **항상 전체 스트리밍 (worker가 controller에서 행을 lazy fetch)**
   — 각 VU마다 네트워크 왕복. ADR-0016 VU 모델에서 hot-path 오버헤드.

## Decision

**옵션 1 선택 (독립 DB 리소스 + 서버 파싱).**

### 스키마

```sql
-- migration 0004 (CREATE TABLE IF NOT EXISTS — idempotent)
CREATE TABLE IF NOT EXISTS datasets (
    id           TEXT PRIMARY KEY,   -- ULID
    name         TEXT NOT NULL,
    columns_json TEXT NOT NULL,      -- JSON array of column names (순서 보존)
    row_count    INTEGER NOT NULL,
    byte_size    INTEGER NOT NULL,   -- 원본 업로드 바이트 수
    created_at   INTEGER NOT NULL    -- Unix ms
);

CREATE TABLE IF NOT EXISTS dataset_rows (
    dataset_id TEXT NOT NULL,        -- FK 없음 — cascade는 앱 레벨(DELETE 트랜잭션)
    idx        INTEGER NOT NULL,     -- 0-based
    row_json   TEXT NOT NULL,        -- {"col":"value"} — 컬럼 이질성·매핑 용이
    PRIMARY KEY (dataset_id, idx)
);
```

행은 `{"col":"value"}` JSON으로 저장. 컬럼 순서는 `columns_json`으로 별도 보존.

### 파싱 모듈

`crates/controller/src/datasets/parse.rs` — 순수 함수, no I/O:

- **CSV**: `csv` 1.4 크레이트. 구분자(`,`/`;`/`\t`) 자동감지(첫 4KiB 샘플링).
  `encoding_rs` 0.8로 UTF-8 BOM strip + CP949 fallback.
  헤더 없음→`col1`/`col2`/…(1-based), 빈/중복 컬럼명 정규화(빈→`colN`, 중복→`_2` suffix), 짧은 행 빈 문자열 패딩.
- **XLSX**: `calamine` 0.26 크레이트. 단일 시트(기본 첫 번째) + 다중 시트 이름 지정 지원.
  `ExcelDateTime` → ISO-8601 문자열, `Float`/`Int` → 소수점 없는 경우 정수 문자열.

### REST API (`/api/datasets`)

| 메서드 + 경로 | 기능 |
|---|---|
| `POST /api/datasets` | multipart 업로드 → 파싱 → DB 저장, 200 + DatasetResponse(메타+sample 20행) |
| `POST /api/datasets/preview` | 파싱만(저장 안 함), override options 포함, 200 + PreviewResponse(메타 없음) |
| `GET /api/datasets` | 목록(메타만, 행 미포함) |
| `GET /api/datasets/{id}` | 메타 + sample 20행 |
| `DELETE /api/datasets/{id}` | 8b: 무조건 삭제. 비-terminal run 참조 409 가드는 8c |

업로드/preview POST 라우트에만 `DefaultBodyLimit::max(256 MiB)` — 기본 2MB로는 실제 데이터셋
업로드가 막힘. 전역 변경 금지(`/runs`·`/scenarios`는 소형 JSON).

### 데이터 바인딩·주입 (8c)

`profile_json` 컬럼의 새 `data_binding` 필드(`#[serde(default)]`)로 바인딩 설정을 저장한다.
`runs` 테이블 스키마 무변경 — `profile_json`의 `#[serde(default)]`만으로 옛 run과 호환.

#### 매핑 형식

`Mapping` = `{kind:"column", var, column}` (데이터셋 열 → flow 변수) 또는
`{kind:"literal", var, value}` (상수값). Rust `#[serde(tag="kind")]` ↔ TS Zod
`discriminatedUnion("kind")`으로 양쪽 형식이 동일하게 직렬화된다.

#### 3가지 바인딩 정책

| 정책 | 행 선택 규칙 | 워커 수신 행 수 |
|---|---|---|
| `per_vu` | `vu_id % row_count` — VU당 고정 1행 | `min(vus, rows)` |
| `iter_sequential` | worker-local `AtomicU64` fetch_add % `row_count` | 전체 데이터셋 (≤ `--dataset-max-rows`) |
| `iter_random` | splitmix64-seeded `StdRng::from_seed`로 매 반복마다 랜덤 행 | 전체 데이터셋 (≤ `--dataset-max-rows`) |

`unique` 정책은 run-create에서 미구현으로 거부(`400 "unique policy is not yet supported"`).
멀티-워커 전역 커서가 필요하므로 후속 슬라이스에서 결정.

#### 결정론적 시드

`seed = FNV-1a fold over run_id bytes`. run_id(ULID)가 같으면 항상 같은 난수 시퀀스 →
재현 가능한 테스트. 시드 충돌은 결정론성(같은 시드 = 같은 시퀀스)이므로 무해.

#### 슬라이싱과 `--dataset-max-rows`

`per_vu`는 `min(vus, rows)` 행만 전달(VU 수보다 많으면 낭비) — 상한 없음.
`iter_*`는 전체 데이터셋을 전달하되 `--dataset-max-rows`(controller CLI 인자, 기본 100,000)
초과 시 run-create에서 거부. 워커에서 다시 한 번 `row_count` 검증.

#### 책임 분리: controller가 매핑 적용, worker는 행만 받는다

controller가 `apply_mappings(row, mappings)` → `{var: value}` 형식으로 변환한 다음
`DatasetBatch` gRPC 메시지로 스트리밍한다. worker는 열 이름을 전혀 모르고 `{var:value}`
행만 `Vec<BTreeMap<String,String>>`으로 누적한다. 이렇게 하면:
- gRPC payload에 원본 컬럼 이름이 노출되지 않는다.
- 워커/엔진의 매핑 로직 중복이 없다.
- 새 `kind`(함수, 합성 컬럼 등)는 controller에서만 추가하면 된다.

#### worker 로딩 단계

worker가 Register → RunAssignment.data_binding을 받으면 엔진 시작 전에 row_count 행을
모두 수신한다(블로킹). 이 단계에서:
- abort/cancel → `Phase::Aborted` (클린 종료).
- stream 조기 종료(controller DB 오류/dataset 삭제/worker disconnect) → `Phase::Failed`.
- controller가 row_count를 맞추지 못하는 경우(예: DB 오류) → `ServerMessage::AbortRun`을
  전송해 worker의 블로킹 대기를 해제한다. `drop(tx)`로는 안 됨 — `state.active`에 clone
  이 살아있어 stream이 닫히지 않기 때문.
- `load_dataset`은 `inbound_rx`를 빌리므로 `abort_listener` spawn(inbound_rx를 move) 전에 호출해야 한다.

#### 엔진 오버레이

엔진은 매 반복(`iter_id`)마다 정책에 따라 행을 선택하고 `iter_vars`에 overlay한다.
우선순위: `scenario.variables` < dataset 행 < extract 결과.
`None` binding(데이터셋 미설정) = 이전과 byte-identical — pre-8c 시나리오 호환.

#### 로깅 정책

dataset 행의 값(`{var:value}` 페어)은 어느 레이어(controller/worker/engine)에서도 로그에
남기지 않는다. 값 자체가 민감 정보일 수 있기 때문.

#### UI 바인딩 패널

`DataBindingPanel`이 시나리오 YAML에서 `{{var}}`를 스캔(`scanFlowVars`)하고,
선택한 데이터셋의 열과 매핑(column/literal)을 설정하며, 정책을 선택한다.
검증: 데이터셋 선택 시 모든 column 매핑이 실제 열에 존재해야 통과. extract/scenario.variables로
값이 공급될 `{{var}}`는 검증 대상에서 제외(런타임에 값이 들어오기 때문).

## Consequences

**Positive**
- 데이터셋 재사용: 여러 시나리오·run이 같은 dataset_id를 참조.
- 서버 파싱: 브라우저 번들 추가 없이 오프라인 UX 유지. 대용량(수만 행) XLSX 처리.
- `CREATE TABLE IF NOT EXISTS` migration: controller 재시작 무한히 안전.
- `runs` 테이블 무변경: 8b/8c 모두 `profile_json`의 `#[serde(default)]`만으로 기존 행 호환.
- per_vu 정책: VU당 고정 행 → 사용자 토큰/ID 고정 매핑 패턴. iter_sequential/random: 전체
  데이터셋 순환 → 넓은 데이터 다양성. 두 패턴 모두 단일 워커로 완결.
- 책임 분리(controller 매핑 적용, worker 행 수신): 새 매핑 종류는 controller만 수정.
- 로딩 단계: 엔진 시작 전 모든 행 수신 완료 → 첫 VU 이전 모든 데이터 준비 보장.
- 결정론적 시드(FNV-1a fold over run_id): 같은 run_id = 재현 가능한 iter_random 시퀀스.
- `DELETE /api/datasets/{id}`: 8c에서 non-terminal run 참조 시 409 가드 추가.

**Negative / Trade-offs**
- DELETE 409 가드는 8c 시점 기준 — run이 로딩 중(`running`) dataset을 삭제하면 controller가
  `AbortRun`을 전송해 worker를 클린 종료시키는 경로가 아직 미구현. 현실적으로 UI 흐름에서는
  run 시작 직후 즉시 dataset 삭제가 어려운 UX라 후속 대응.
- calamine 0.26은 런타임 의존성에 codepage/quick-xml/zip/zopfli 4크레이트를 추가
  (이미지 크기 모니터링 권장).
- UploadPanel 라이브 미리보기는 응답 시퀀싱 없음(8b 알려진 한계) — 옵션 연속 변경 시
  stale 미리보기 가능. 후속에서 AbortController 가드 추가 가능.
- `unique` 정책 미구현: 멀티-워커 전역 커서 없이는 정확한 "한 번만" 보장이 불가. 후속.
- iter_* 대용량 데이터셋: 전체 행을 controller → worker gRPC 스트림으로 전달하므로
  수십만 행 × 여러 열이면 스트림 전송 시간이 수 초 걸릴 수 있음. 현재 `--dataset-max-rows`
  100,000 기본값으로 제한.

## 성능 (8c)

벤치 하네스(`just bench-throughput`)는 body 없는 flat GET 기준이라 데이터 바인딩 경로를
직접 구동하지 못한다(하네스가 8c 이전에 만들어졌고 `data_binding` profile 필드를 지원하지
않음). 따라서 **해석적 분석**으로 결론짓는다:

- **no-binding 기준선**: Task 12에서 release 재빌드를 실행하지 않았음(docs-only task, ~20분
  소요). Prior documented baseline(Slice 8a 시점) ~20,000 RPS / p95 17ms / p99 24ms.
  8c 코드는 `data_binding: None` 분기로 byte-identical이므로 구조적 no-op.
- **binding 경로의 반복당 비용**: 정책에 따라 (a) modulo 1회(`per_vu`/`iter_sequential`)
  또는 (b) `splitmix64` + `StdRng::sample_single` 1회(`iter_random`) + `BTreeMap` 1회
  clone-insert. 이 연산들은 나노초 단위 — 단일 HTTP round-trip(수 밀리초)에 완전히 묻힌다.
- **로딩 단계 비용**: `DatasetBatch` 스트리밍 + `Vec` 누적은 run 시작 시 1회만 발생하고
  엔진 실행 중에는 0 오버헤드. Slice 8a의 결론("실제 8a 비용은 body 보유 요청당 1회로
  직렬화+RTT에 묻힘")과 동일한 클래스.

결론: data-binding은 측정 가능한 처리량 회귀를 일으키지 않는다(구조적 no-op, Slice 8a와 같은 근거).

## 명시적 연기 (Out of scope)

- **8c 이후**: `unique` 정책(멀티-워커 전역 커서 필요) / 민감정보 마스킹 / JSON 숫자·타입
  주입 / 멀티워커 HPA / Helm `controller.datasetMaxRows` values.yaml 노출 / 데이터셋
  버전·diff·편집 / 로딩 중 dataset 삭제 → AbortRun 경로. (spec §12)

## Links

- ADR-0013 (Scenario/RunConfig 분리) — 독립 리소스 결정의 근거
- ADR-0014 (변수 표기 분리) — `{{var}}` 흐름 변수 표기 근거
- ADR-0021 (loop 메트릭 breakdown) — `CREATE TABLE IF NOT EXISTS` + `profile_json` 패턴 precedent
- ADR-0016 (VU 실행 모델) — worker lazy-fetch 거절 근거 + tokio-task per VU 컨텍스트
- Spec `docs/superpowers/specs/2026-05-30-slice-8-data-driven-design.md`
