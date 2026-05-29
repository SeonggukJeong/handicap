# Slice 8 — Data-driven (데이터셋 주입) 설계 명세

- **상태**: 작성 완료
- **날짜**: 2026-05-30
- **대상 범위**: Slice 8 (MVP 1단계 완료 후 후속 — 노드 종류 확장에 이은 "데이터 주입" 축)
- **참조**: MVP 설계 [2026-05-27-handicap-mvp1-design.md](2026-05-27-handicap-mvp1-design.md) §4.5, [Slice 7 명세](2026-05-29-slice-7-loop-node-design.md) §8(data-driven loop을 "다음 슬라이스"로 연기), [ADR 인덱스](../../adr/README.md), ADR-0013(시나리오/run config 분리)·ADR-0014(변수 표기)·ADR-0016(VU 모델)

> **슬라이스 번호 메모**: Slice 7 명세 §8은 conditional을 잠정 "Slice 8", parallel을 "Slice 9"로 적었으나, 사용자가 **data-driven을 다음 슬라이스로 선택**했다. 따라서 본 슬라이스가 Slice 8이 되고 conditional/parallel은 이후 슬라이스로 밀린다(번호는 그때 확정).

MVP 1단계(슬라이스 1–6)와 Slice 7은 모든 VU가 **동일한 변수 값**으로 요청을 보냈다(`{{var}}`는 시나리오 고정값 또는 run-level `${ENV}`). 이 슬라이스는 **VU/반복마다 서로 다른 데이터 행**을 주입한다 — 로그인 사용자 풀, 상품 ID 목록 등을 CSV/XLSX로 업로드해 부하 테스트에 흘려보낸다. LoadRunner의 "Data file" / JMeter의 "CSV Data Set Config" / k6의 `SharedArray`에 해당하는 기능이다.

---

## 목차

1. 범위 (In / Out)
2. 아키텍처 결정
3. 데이터 모델 / 저장 (SQLite)
4. 바인딩 정책 (run config)
5. API (controller)
6. 파싱 (Rust, calamine + csv)
7. 전송 (proto + 정책별 슬라이싱)
8. 엔진 (데이터 적재 · 인덱싱 · body 템플릿팅)
9. UI (Datasets 페이지 · RunDialog 바인딩 · 검증)
10. 성능
11. 에러·경계·재현성 의미
12. 명시적 연기 (Future)
13. 완료 기준
14. 추가되는 ADR

---

## 1. 범위 (In / Out)

**IN — Slice 8**
- 새 **Dataset 리소스**: CSV/XLSX 업로드 → Rust 서버 파싱 → SQLite 저장. 독립 리소스(`/api/datasets`)로 여러 run·시나리오에서 재사용.
- **컬럼 → 변수 매핑** + **바인딩 정책**을 run config(`profile_json`)에 스냅샷.
- 바인딩 정책 **3종**: `per_vu`(VU마다 고정 1행, 기본) · `iter_sequential`(반복마다 순차, wrap) · `iter_random`(반복마다 랜덤).
- 데이터 행 값을 VU별 `iter_vars`에 overlay → `{{var}}`로 url·header·**form 값·JSON 문자열 leaf**·raw body 어디서나 치환.
- **body 템플릿팅 추가**(전제조건): 현재 form/JSON body는 치환 없이 전송됨 → form 값 전체 + JSON 문자열 leaf에 `render` 적용.
- 정책별 전송 슬라이싱: per-VU는 `min(vus, rows)`행만, per-iteration은 전체 전송.
- 파싱 자동감지(첫 행=헤더, 구분자, 인코딩 UTF-8/CP949) + 얇은 override(헤더 토글·구분자·인코딩·XLSX 시트 선택).
- UI: 신규 **Datasets 페이지**(목록·업로드·미리보기) + **RunDialog 바인딩 섹션**(자동 스캔된 `{{var}}` 행, 추가·삭제, 컬럼/리터럴 선택, 정책 드롭다운, row 0 샘플 미리보기, per-iteration 메모리 경고).
- per-iteration **설정 가능한 상한**(기본 100만 행, controller 플래그/Helm 값으로 조정), 초과 시 안내와 함께 run 차단.

**OUT — 명시적으로 후속 (§12 상세)**
- **`unique`(1회성 소진) 정책** — run 종료 의미 변경 + 멀티워커 전역 조율. variant 자리만 예약.
- **민감정보 마스킹** — 별도 보안 슬라이스(미리보기/리포트/로그 값 마스킹, 컬럼별 토글). 이번엔 **서버 로그에 데이터 값 미출력**의 기본 위생만 지킴.
- **JSON 숫자/타입 주입**(`{"age": {{age}}}`) — 문자열 leaf 치환만. number/bool 주입은 후속.
- **멀티워커 전역 커서** — wrap 정책은 워커-로컬 허용(§11). 멀티워커(이후 슬라이스)에서 컨트롤러가 행을 워커별로 파티션.
- 데이터셋 버전 관리·diff·라이브 편집 — 업로드=불변 스냅샷.

---

## 2. 아키텍처 결정

**독립 Dataset 리소스 (채택).** 데이터는 시나리오(git/YAML)에도, run에만 붙는 ephemeral에도 두지 않고 **별도 DB 리소스**로 둔다. run config가 `dataset_id` + 매핑 + 정책을 참조. 근거:
- ADR-0013(시나리오는 git/YAML, run config는 DB)과 정합 — 데이터는 run-specific이고 자격증명을 git에 넣지 않는다.
- 같은 시나리오를 staging/prod-like 등 다른 데이터셋으로 반복 실행 가능, 데이터셋은 run 간 재사용.

**Dumb worker (채택).** 워커는 **컬럼·매핑을 모른다**. 컨트롤러가 매핑을 선적용해 "**변수명→값**" 행만 보낸다. 워커는 정책으로 행 인덱스만 골라 `iter_vars`에 overlay. 매핑·슬라이싱 지식은 컨트롤러 한 곳에 집중.

**정책 인지 슬라이싱 (채택).** per-VU 고정은 컨트롤러가 `min(vus, rows)`행만 전송 → 데이터가 1000만이어도 VU가 500이면 워커는 500행만 적재. 워커 수신 로직은 정책 무관 균일(받은 `Vec`에 인덱스). per-iteration만 전체 전송 → 워커 RAM이 유일한 실질 제약.

**Rust 서버 파싱 (채택).** CSV/XLSX를 컨트롤러가 `csv`+`calamine`로 파싱. 거절: 브라우저(SheetJS) 파싱 — 오프라인 CSP 번들 부담 + 브라우저/서버 파서 불일치 위험 + 대용량 약함.

거절한 대안:
- **데이터 inline in scenario YAML**: 대용량·자격증명이 git에 유입, ADR-0013 위반.
- **run-only ephemeral 업로드**: 재사용 불가, 매 run 재업로드.
- **항상 전체 스트리밍(cap 고정)**: per-VU에서 안 쓸 행까지 적재(낭비) + 고정 cap이 절대 상한.
- **워커 lazy fetch(행 on-demand)**: hot path 왕복 → 처리량 저하, 또는 로컬 캐시 = 전체 적재 재발명.

## 3. 데이터 모델 / 저장 (SQLite, migration 0004)

`CREATE TABLE IF NOT EXISTS` + 컬럼 존재 가드 패턴(Slice 6/7-1과 동일 — 멱등).

```sql
CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,         -- ULID
  name        TEXT NOT NULL,
  columns_json TEXT NOT NULL,           -- ["email","pw","user_id","region"] (순서 보존)
  row_count   INTEGER NOT NULL,
  byte_size   INTEGER NOT NULL,         -- 원본 파일 바이트(진단/표시)
  created_at  INTEGER NOT NULL          -- now_ms
);

CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_id  TEXT NOT NULL,
  idx         INTEGER NOT NULL,         -- 0-based 행 번호
  row_json    TEXT NOT NULL,            -- {"email":"a@ex.com","pw":"...",...} 컬럼→값
  PRIMARY KEY (dataset_id, idx)
);
```

- 행당 JSON → 컬럼 이질성(빈 셀, 추가 컬럼)에 유연하고 매핑 적용이 쉽다. 10만 행도 무리 없음.
- `dataset_rows`는 FK를 명시하지 않고 앱 레벨에서 cascade 삭제(SQLite FK ON이나 대량 행은 앱에서 `DELETE WHERE dataset_id=?`가 명료). PK(dataset_id, idx)로 슬라이스 조회(`WHERE dataset_id=? AND idx < ?` / `ORDER BY idx`)가 인덱스 탄다.
- **`runs` 테이블 무변경**: 바인딩은 `profile_json` JSON 안의 새 필드(`#[serde(default)]`)라 기존 행 호환(Slice 7-1 패턴). 과거 run은 `data_binding: None`.

## 4. 바인딩 정책 (run config)

`profile_json`에 추가(스냅샷):

```jsonc
"data_binding": {
  "dataset_id": "01J...",
  "policy": "per_vu",              // per_vu | iter_sequential | iter_random
  "mappings": [                    // 변수 → 컬럼
    { "var": "username", "column": "email" },
    { "var": "password", "column": "pw" }
  ]
}
```

- `data_binding`이 없으면(=`None`) 기존 동작 그대로(전부 하위 호환).
- `policy` enum은 Rust `#[serde(rename_all="snake_case")]`. **`unique` variant 자리만 예약**(파싱은 받되 이번 슬라이스는 검증에서 거부 — "다음 슬라이스" 안내). 종료 의미·멀티워커 조율 격리 지점을 §12에 명시.
- 매핑은 run마다 다를 수 있으므로 run config에 둔다(시나리오 이식성). 업로드 시 컬럼명=변수명 자동 추천으로 UI가 초기값 채움.

## 5. API (controller)

- `POST /api/datasets` — `multipart/form-data`(파일 + 선택적 파싱 옵션 `header`,`delimiter`,`encoding`,`sheet`). 컨트롤러가 파싱→저장→`{ id, name, columns, row_count, sample: [..N행..] }` 반환(미리보기용 N=상위 20행).
- `GET /api/datasets` — 목록(id·name·row_count·created_at).
- `GET /api/datasets/{id}` — 메타 + 샘플 N행(미리보기).
- `DELETE /api/datasets/{id}` — 삭제. 과거 run 리포트는 메트릭이 step_id 집계라 **무영향**. 진행 중(non-terminal) run이 참조 중이면 차단(409) + 메시지.
- 기존 `POST /api/runs`는 profile에 `data_binding`을 받아 검증(매핑된 컬럼이 데이터셋에 존재? 정책이 `unique`면 거부? per-iteration이면 상한 검사).

## 6. 파싱 (Rust, `calamine` + `csv`)

- **CSV**: `csv` crate. 자동감지 — 첫 행=헤더(override 토글), 구분자(쉼표 기본, `;`·`\t` 감지/override), 인코딩(UTF-8/BOM, **CP949** 한글 — `encoding_rs`로 디코드, 자동감지 실패 시 override 드롭다운).
- **XLSX**: `calamine`. 다중 시트면 시트 목록 반환 → UI에서 선택(기본 첫 시트). 셀은 문자열화(숫자/날짜는 표시 문자열로 — 타입 주입은 §12 연기).
- 빈 셀 → 빈 문자열. 컬럼명 중복/공백 → 정규화(중복은 `col`, `col_2`). 헤더 없으면 `col1`,`col2`…
- 파싱은 **스트리밍**(전체를 한 번에 메모리에 안 올리고 행 단위로 `dataset_rows` insert) → 대용량 업로드 견고.
- 단위 테스트: CSV(쉼표/세미콜론/탭), CP949 한글, BOM, XLSX 단일/다중 시트, 빈 셀, 헤더 없음, 중복 컬럼명.

## 7. 전송 (proto + 정책별 슬라이싱)

`RunAssignment`에 옵션 `DataBinding` 추가, `ServerMessage` oneof에 `DatasetBatch` 추가:

```proto
message DataBinding {
  Policy policy = 1;
  uint32 seed = 2;          // iter_random 재현용 (run_id 파생)
  uint64 row_count = 3;     // 워커가 받을 행 수(슬라이스 후)
  enum Policy { PER_VU = 0; ITER_SEQUENTIAL = 1; ITER_RANDOM = 2; }
}
message RunAssignment {
  // ... 기존 필드 ...
  DataBinding data_binding = <다음 가용 태그>;   // 없으면 데이터 주입 안 함
}
message DatasetRow { map<string, string> values = 1; }  // 변수명→값 (매핑 선적용)
message DatasetBatch { repeated DatasetRow rows = 1; }
message ServerMessage {
  oneof msg { /* ... 기존 ... */ DatasetBatch dataset_batch = <다음 가용 태그>; }
}
```

> 태그 번호는 현재 `.proto`의 다음 가용 번호로 배정(여기 `<다음 가용 태그>`). `Policy` enum은 이번 슬라이스에 `PER_VU`/`ITER_SEQUENTIAL`/`ITER_RANDOM`만 — `UNIQUE`는 구현 슬라이스에서 추가.

- 컨트롤러: RunAssignment 직후, 워커가 실행 시작 전 `DatasetBatch`들을 순서대로 전송. 워커는 `row_count`만큼 누적되면 적재 완료로 간주.
- **정책별 슬라이스**(컨트롤러 한 곳):
  - `per_vu`: `min(vus, rows)`행 전송. 워커 idx = `vu_id % row_count`(vus≤rows면 row_count=vus라 idx=vu_id; vus>rows면 row_count=rows라 wrap). 매핑 적용한 변수→값.
  - `iter_sequential`/`iter_random`: 전체 `rows`행 전송(상한 검사 후).
- prost 구조체는 exhaustive → `RunAssignment`·`ServerMessage` literal 생성처 전부 grep해서 새 필드 채움(Slice 7-1 교훈).

## 8. 엔진 (데이터 적재 · 인덱싱 · body 템플릿팅)

**적재 (worker-core)**: 워커가 `DatasetBatch`들을 모아 `Arc<DataSet>` 구성:
```rust
struct DataSet { rows: Vec<BTreeMap<String,String>>, policy: Policy, seed: u32 }
```
`run_scenario`/`run_vu`에 `dataset: Option<Arc<DataSet>>` 전달.

**인덱싱 (`run_vu`/iteration)**:
- `per_vu`: `idx = vu_id as usize % rows.len()` — VU별 고정. 한 VU의 모든 iteration 동일 행.
- `iter_sequential`: 워커-로컬 `Arc<AtomicU64>` counter, iteration마다 `idx = counter.fetch_add(1) % rows.len()`.
- `iter_random`: 시드 RNG(`seed ^ vu_id ^ iter` 등 결정적 파생)로 `idx = rng % rows.len()` — run_id 시드라 재현 가능.
- `rows.is_empty()` → 빈 데이터셋은 바인딩 시점(API)에서 거부하므로 도달 안 함(방어적으로 overlay 건너뜀).

**iter_vars overlay 순서**(우선순위): `scenario.variables`(기본값) → **데이터 행 overlay** → extract(실행 중 기록). `${ENV}`는 별도 네임스페이스(충돌 없음). 즉 데이터가 시나리오 기본값을 덮고, extract가 데이터를 덮을 수 있다(같은 iteration 내 가장 신선한 값).

**body 템플릿팅 (`executor.rs` — 전제조건 수정)**:
- 현재: url·header·raw만 `render`, **form/JSON은 치환 없이 전송**(잠복 갭 — 토큰을 헤더에 넣어 안 드러남).
- 변경: `Body::Form(map)` → 각 값에 `render`. `Body::Json(v)` → `serde_json::Value`를 walk하며 **문자열 leaf만** `render`(객체/배열 재귀, number/bool/null 보존). 키는 치환 안 함.
- 하위 호환: `{{}}`가 없으면 출력 불변.
- 단위 테스트: form 값 치환, 중첩 JSON 문자열 leaf 치환 + number 보존, 데이터 미바인딩 시 무변경.

## 9. UI (Datasets 페이지 · RunDialog 바인딩 · 검증)

**Datasets 페이지(신규)**: 목록 + 드래그-드롭 업로드 → 서버 파싱 결과(컬럼·미리보기 표) → 이름 확인·저장. 얇은 override 패널(헤더 토글·구분자·인코딩·XLSX 시트)은 미리보기 위에 두고, 잘못 감지 시 즉시 재파싱 미리보기.

**RunDialog 바인딩 섹션(확정 목업 `mapping-hybrid-v2`)**:
- 데이터셋 선택(드롭다운).
- "데이터로 덮어쓸 변수" 표 — 행=변수. 시나리오 YAML을 클라이언트에서 스캔(`{{var}}`, `flattenHttpSteps`로 loop `do:`까지 재귀)해 자동 행 생성(출처 "시나리오"). 이름 같은 컬럼 자동 매칭.
- **모든 행 삭제 가능**(✕). 행 둠=데이터 override, 삭제=시나리오/env 기본값. 리터럴 기본값은 **정상**(경고 아님).
- "+ 변수 바인딩 추가"(시나리오에 아직 없는 변수도 가능, "미사용" 힌트) + "감지됨(미사용)" 칩으로 빠른 재추가.
- 바인딩 정책 드롭다운. per-iteration 선택 시 **항상 경고 배너**: "전체 N행(~X MB)을 워커 메모리에 적재. 상한은 controller `--dataset-max-rows`(Helm `controller.datasetMaxRows`)로 조정." per-VU는 경고 없음.
- row 0 샘플 미리보기 컬럼.
- **검증(차단)**: 시나리오가 쓰는 `{{var}}`가 데이터 바인딩·시나리오 기본값·env **어디에서도** 값을 못 얻으면 빨간불 + run 차단(엔진 `UnknownVar`와 일치). 그 외(리터럴 사용 등)는 차단 안 함. `unique` 선택 시 "다음 슬라이스" 안내로 차단.
- flex 레이아웃은 `min-w-0`/`shrink-0`(기존 RunDialog 함정), Zod 검증, `pnpm build` 게이트.
- UI 테스트(RTL): 자동 스캔 행 생성, 추가/삭제, 자동 매칭, 미해결 변수 차단, 정책별 경고 표시.

## 10. 성능

- **per-VU**: 데이터 크기 무관 가벼움(컨트롤러 슬라이스). 행 조회=`Vec` 인덱싱, HTTP RTT 대비 무시 가능 → 회귀 없음 예상.
- **iter_sequential**: `AtomicU64::fetch_add` 1회/iteration — 락 없음, 경합 무시 가능.
- **iter_random**: 시드 RNG 1회/iteration — 무시 가능.
- A/B 측정(SCENARIO_KIND 추가): 데이터 미바인딩 vs per-VU(예: 1000행) vs iter_sequential, 200 VUs × 20s, 1KB body. 기대: run-to-run 변동 범위 내. body 템플릿팅(JSON walk)은 요청당 1회 — 측정해 회귀 없음 확인.
- per-iteration 메모리: 100만 행 ≈ 200MB(워커). 상한 기본 100만, 조정 가능.

## 11. 에러·경계·재현성 의미

- **빈 데이터셋(0행)**: 업로드는 허용하되 바인딩 시점에 거부(주입할 행 없음).
- **행 < VU (per-VU)**: wrap(`vu_id % rows`) — 여러 VU가 같은 행 공유. 정상.
- **per-iteration wrap**: 데이터 끝나면 처음으로 순환(소진 아님). `unique`만 소진=종료, 이번엔 연기.
- **iter_random 재현성**: seed=run_id 파생 → 같은 run 재생/리포트에서 동일 시퀀스.
- **멀티워커(이후)**: `iter_sequential`/`iter_random`은 **워커-로컬** — 워커마다 독립 순회/시드라 워커 간 행 재사용 발생(wrap 정책이라 허용). `unique`는 전역 조율 필요 → 그 슬라이스에서 컨트롤러가 행을 워커별 파티션. 이 invariant를 ADR-0022에 기록.
- **데이터셋 삭제 후 과거 run**: 리포트 메트릭은 step_id 집계라 무영향. 진단용 dataset_id는 run config 스냅샷에 남음(데이터셋 행은 사라져도 어떤 데이터셋이었는지 식별 가능).
- **로그 위생**: 워커/컨트롤러 로그에 데이터 행 값을 출력하지 않는다(마스킹 슬라이스 전 기본 위생).

## 12. 명시적 연기 (Future)

- **`unique` 정책**: run 종료 의미 변경(데이터 소진=run 조기 종료 vs 에러) + 멀티워커 전역 커서. **Rust run-config 정책 enum에 `unique` variant 예약**(파싱은 받되 API 검증에서 거부, "다음 슬라이스" 안내). proto `Policy` enum과 엔진 인덱싱은 구현 슬라이스에서 확장. 격리 지점: 엔진 인덱싱 함수 + run 종료 조건 + 컨트롤러 행 파티션.
- **민감정보 마스킹**: 별도 보안 슬라이스 — 컬럼별 마스킹 토글, 미리보기/리포트 마스킹, 감사. 이번엔 로그 미출력만.
- **JSON 숫자/타입 주입**: 문자열 leaf만. number/bool 주입은 표현(Value vs raw text) 결정 후 후속.
- **데이터셋 버전·diff·라이브 편집**: 업로드=불변 스냅샷.
- **멀티워커 행 파티션**: 이후 멀티워커/HPA 슬라이스에서.

## 13. 완료 기준

- 엔진: 정책별 인덱싱·overlay·body 템플릿팅 단위 테스트 통과. wiremock 통합(per-VU가 VU마다 다른 값으로 도달, iter_sequential이 행 순회).
- Controller: 파싱 단위 테스트(CSV/CP949/XLSX/시트/경계), `/api/datasets` CRUD, 정책별 슬라이싱, per-iteration 상한 검사, `unique` 거부.
- proto/전송: `DatasetBatch` 적재 e2e(업로드→바인딩→run→메트릭).
- UI: Datasets 페이지·RunDialog 바인딩 RTL, `pnpm build` 통과.
- e2e: subprocess 워커로 업로드→per-VU run→리포트까지.
- A/B 성능: 미바인딩 대비 회귀 없음 확인(§10).
- ADR-0022 추가, CLAUDE.md "알아둘 결정들"·상태 갱신.

## 14. 추가되는 ADR

- **ADR-0022 — Data-driven 데이터셋**: 독립 Dataset 리소스 + dumb worker(변수→값 행) + 정책 인지 슬라이싱 + 3 정책(per-VU 기본). 거절 대안(inline/ephemeral/전체스트리밍/lazy-fetch). 멀티워커 워커-로컬 wrap invariant. `unique`·마스킹·타입주입 연기.
