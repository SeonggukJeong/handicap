# Slice 8 — Data-driven (데이터셋 주입) 설계 명세 (8a/8b/8c 분할)

- **상태**: 작성 완료 (프레시 리뷰 NEEDS-REWORK 반영 — 분할 + 배선/전송/PRNG/의존성 결함 수정)
- **날짜**: 2026-05-30
- **대상 범위**: Slice 8 — **3개 하위 슬라이스로 분할**: **8a 본문 템플릿팅**(전제조건) → **8b 데이터셋 리소스**(업로드·파싱·CRUD·페이지) → **8c 바인딩+전송+엔진+RunDialog**(실제 주입). 각 하위 슬라이스는 **독립 출하 + 자체 구현 plan**.
- **참조**: MVP 설계 [2026-05-27-handicap-mvp1-design.md](2026-05-27-handicap-mvp1-design.md) §4.5, [Slice 7 명세](2026-05-29-slice-7-loop-node-design.md) §8, ADR-0013(시나리오/run config 분리)·0014(변수 표기)·0016(VU 모델)

> **슬라이스 번호 메모**: Slice 7 §8은 conditional을 잠정 "Slice 8"로 적었으나 사용자가 data-driven을 다음으로 선택. conditional/parallel은 이후로 밀린다. 본 문서는 **공유 설계 + 8a/8b/8c 범위 구획**을 담는 우산(umbrella) spec이고, 구현 plan은 하위 슬라이스별로 따로 작성한다.

MVP 1단계와 Slice 7은 모든 VU가 **동일한 변수 값**으로 요청을 보냈다. 이 슬라이스는 **VU/반복마다 다른 데이터 행**을 `{{var}}`에 주입한다 — 로그인 사용자 풀, 상품 ID 목록 등을 CSV/XLSX로 업로드해 흘려보낸다. (LoadRunner "Data file" / JMeter "CSV Data Set Config" / k6 `SharedArray`.)

---

## 목차

1. 범위 (8a / 8b / 8c, 공유 OUT)
2. 아키텍처 결정 (공유)
3. 데이터 모델 / 저장 — 8b
4. 바인딩 정책 — 8c
5. API — 8b
6. 파싱 — 8b
7. 전송 + 배선 (proto · PendingAssignment · 워커 로딩 단계) — 8c
8. 엔진 (본문 템플릿팅 8a · 인덱싱/overlay 8c)
9. UI (Datasets 페이지 8b · RunDialog 바인딩 8c)
10. 성능
11. 에러·경계·재현성 (단일 검증 게이트)
12. 명시적 연기 (Future)
13. 완료 기준 (하위 슬라이스별)
14. 의존성 & 호환성 검사
15. 추가되는 ADR

---

## 1. 범위

### 8a — 본문 템플릿팅 (전제조건, 자족적)
**IN**: `executor.rs`에서 `Body::Form(map)` 각 값 + `Body::Json(v)`의 **문자열 leaf**에 `render` 적용(객체/배열 재귀, number/bool/null·키 보존). 하위 호환(`{{}}` 없으면 출력 불변).
**근거**: 현재 form/JSON body는 치환 없이 전송됨(`executor.rs:69-78` — Raw만 render). data-driven 대표 시나리오(로그인 form/JSON body)가 이게 없으면 무용지물. **데이터셋과 독립적으로 가치 있고 먼저 출하 가능.**

### 8b — 데이터셋 리소스 (백엔드 + 관리 UI)
**IN**: 새 `datasets`/`dataset_rows` 테이블(migration 0004). `POST/GET/DELETE /api/datasets`(multipart 업로드). Rust 파싱(`csv`+`calamine`+`encoding_rs`, 자동감지 + 얇은 override). Datasets 페이지(목록·드래그드롭 업로드·미리보기). **이 슬라이스만으로는 데이터가 run에 주입되지 않음** — 데이터셋을 만들고 보는 것까지.

### 8c — 바인딩 + 전송 + 엔진 주입 + RunDialog (실제 기능, 최고 위험)
**IN**: 바인딩 정책 3종(`per_vu` 기본/`iter_sequential`/`iter_random`). run config(`profile_json`) `data_binding` 스냅샷. proto `DataBinding`+`DatasetBatch`. **워커 로딩 단계**(§7). 컨트롤러 정책별 슬라이싱 + DB→proto 배선. 엔진 인덱싱·overlay. UI `{{var}}` 스캐너 + RunDialog 바인딩 섹션 + 검증.

### 공유 OUT — 명시적 연기 (§12)
- `unique`(1회성 소진) 정책 / 민감정보 마스킹(별도 보안 슬라이스) / JSON 숫자·타입 주입 / 멀티워커 전역 커서 / 데이터셋 버전·diff·편집.

---

## 2. 아키텍처 결정 (공유)

**독립 Dataset 리소스 (채택).** 데이터는 별도 DB 리소스, run config가 `dataset_id`+매핑+정책 참조. ADR-0013 정합(데이터는 run-specific, 자격증명 git 밖). 거절: scenario YAML inline(ADR-0013 위반) / run-only ephemeral(재사용 불가).

**워커는 컬럼·매핑 비인지, 정책은 인지 (채택).** 컨트롤러가 매핑을 **선적용**해 "변수명→값" 행만 전송 → 워커는 컬럼명·매핑 규칙을 모른다. 단, 워커는 **정책·시드·행 배열을 갖고 인덱스를 계산**한다(per-VU 모듈로 / 순차 카운터 / 랜덤). 즉 "mapping-agnostic worker"이지 "policy-agnostic"은 아니다. 매핑·슬라이싱·정책→proto 변환 지식은 컨트롤러에 집중.

**정책 인지 슬라이싱 (채택).** per-VU는 컨트롤러가 `min(vus, rows)`행만 전송(데이터 1000만·VU 500 → 500행). per-iteration만 전체 전송. 거절: 항상 전체 스트리밍(per-VU 낭비) / 워커 lazy fetch(hot-path 왕복).

**Rust 서버 파싱 (채택).** 거절: 브라우저 SheetJS(오프라인 번들·파서 불일치·대용량 약함).

## 3. 데이터 모델 / 저장 — 8b (migration 0004)

`CREATE TABLE IF NOT EXISTS`(Slice 6/7-1 멱등 패턴, ALTER 회피):

```sql
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  columns_json TEXT NOT NULL,     -- ["email","pw",...] 순서 보존
  row_count INTEGER NOT NULL, byte_size INTEGER NOT NULL,  -- byte_size=원본 파일 바이트
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_rows (
  dataset_id TEXT NOT NULL, idx INTEGER NOT NULL,   -- 0-based
  row_json TEXT NOT NULL,                            -- {"email":"a@ex.com",...}
  PRIMARY KEY (dataset_id, idx)
);
```
- 행당 JSON → 컬럼 이질성·매핑 적용 용이. PK(dataset_id, idx)로 슬라이스 조회(`WHERE dataset_id=? AND idx<?` / `ORDER BY idx LIMIT`)가 인덱스 탄다.
- cascade 삭제는 앱 레벨(`DELETE FROM dataset_rows WHERE dataset_id=?`).
- **`runs` 무변경** — 바인딩은 `profile_json` 새 필드(`#[serde(default)]`)라 기존 행 호환(8c, §4·F5 확인됨).

## 4. 바인딩 정책 — 8c

**(주의) 두 개의 enum이 존재한다** — Rust run-config enum과 proto enum. 컨트롤러가 변환하며 `unique`를 여기서 거부.

run config `profile_json`(serde_json, **YAML 아님 → serde enum round-trip 함정 무관**):
```jsonc
"data_binding": {
  "dataset_id": "01J...",
  "policy": "per_vu",                 // Rust enum: per_vu|iter_sequential|iter_random|unique(예약·거부)
  "mappings": [ { "var": "username", "column": "email" }, { "var": "password", "column": "pw" } ]
}
```
- `data_binding` 없으면(`None`) 기존 동작(전부 하위 호환).
- **Rust enum**은 `unique` variant를 **예약**(파싱은 받되 컨트롤러 dispatch 검증에서 거부, "다음 슬라이스" 안내). **proto enum**(§7)은 `PER_VU|ITER_SEQUENTIAL|ITER_RANDOM`만. 변환·거부 지점 = `api/runs.rs` dispatch 빌드(여기서 Rust policy → proto Policy 매핑, `unique`면 400).
- 매핑은 run마다 다를 수 있어 run config에 둔다. 업로드 시 컬럼명=변수명 자동 추천이 UI 초기값.

**인덱싱 의미 (loop 기능과의 관계 명시)**:
- 행은 **VU의 외부 iteration 단위**로 바뀐다(`run_vu`의 while 루프). **loop 노드의 body repeat 단위가 아니다** — 한 iteration 안의 loop 반복은 같은 행을 본다.
- `per_vu`: `idx = vu_id % rows.len()` — VU별 고정(while 루프 내내 동일).
- `iter_sequential`: 워커-로컬 `Arc<AtomicU64>`(`run_scenario`에서 생성→각 `run_vu`에 clone), iteration마다 `idx = counter.fetch_add(1, Relaxed) % rows.len()`. 증가 지점 = `run_vu` while 루프 진입(§8).
- `iter_random`: **결정적 PRNG** — iteration마다 `StdRng::seed_from_u64(splitmix64(seed, vu_id, iter_id))`로 1개 뽑아 `idx = rng.gen_range(0..rows.len())`. seed는 run_id(ULID 128bit)를 `u32`로 fold(재현엔 결정성만 필요, 유일성 불필요). XOR-직접-모듈로 금지(스트라이핑). `rand` 의존성 명시 추가(§14).

## 5. API — 8b (controller)

- `POST /api/datasets` — `multipart/form-data`(파일 + 선택 옵션 `header`,`delimiter`,`encoding`,`sheet`). **`axum` `multipart` feature 추가 필요**(현재 `features=["macros"]`만). 파싱→저장→`{id,name,columns,row_count,sample:[..20행..]}` 반환.
- `GET /api/datasets`(목록) / `GET /api/datasets/{id}`(메타+샘플 20행) / `DELETE /api/datasets/{id}`(과거 run 리포트 무영향 — 메트릭 step_id 집계; non-terminal run 참조 시 409).
- axum 0.8 path는 `{id}`(확인됨).

## 6. 파싱 — 8b (`csv` + `calamine` + `encoding_rs`)

- **CSV**: `csv` crate — **행 단위 스트리밍 insert 가능**(전체를 메모리에 안 올림). 자동감지: 첫 행=헤더(override), 구분자(`,` 기본, `;`/`\t` 감지·override), 인코딩(UTF-8/BOM, **CP949** `encoding_rs` 디코드, 실패 시 override).
- **XLSX**: `calamine` — **전체 워크북을 메모리에 로드(스트리밍 불가)**. 따라서 "스트리밍→대용량 견고"는 **CSV 한정**; 매우 큰 XLSX는 파싱 시 메모리 큼(업로드 시 안내). 다중 시트면 시트 목록 반환→선택(기본 첫 시트). 셀은 표시 문자열화.
- 빈 셀→빈 문자열. 컬럼명 중복/공백→정규화(`col`,`col_2`). 헤더 없으면 `col1`…
- 단위 테스트: CSV(`,`/`;`/`\t`), CP949, BOM, XLSX 단일/다중 시트, 빈 셀, 헤더 없음, 중복 컬럼명.

## 7. 전송 + 배선 — 8c (리뷰 F1/F2/R1/R4 수정)

### 7.1 proto (실제 이름 확인 — `oneof payload`)
```proto
message DataBinding {
  Policy policy = 1; uint32 seed = 2; uint64 row_count = 3;  // row_count = 슬라이스 후 워커가 받을 행 수
  enum Policy { PER_VU = 0; ITER_SEQUENTIAL = 1; ITER_RANDOM = 2; }   // UNIQUE는 구현 슬라이스에서
}
message DatasetRow  { map<string,string> values = 1; }   // 변수명→값 (매핑 선적용)
message DatasetBatch{ repeated DatasetRow rows = 1; }
// RunAssignment: run_id=1, scenario_yaml=2, profile=3, env=4 → DataBinding data_binding = 5;
// ServerMessage.oneof **payload** (NOT "msg"): assignment=1, abort=2, ping=3 → DatasetBatch dataset_batch = 4;
```
- prost 구조체 exhaustive → `RunAssignment`/`ServerMessage`/`MetricBatch` literal 생성처 전부 수정: `grpc/coordinator.rs:113-123`, `api/runs.rs:74-79`, `worker/src/main.rs:149-156`(grep 필수).

### 7.2 배선 (DB → PendingAssignment → proto) — F2 수정
바인딩은 **세 표현**을 통과한다. 각각 명시:
1. **DB `Profile` 구조체**(`store`/`api/runs.rs`): `#[serde(default)] data_binding: Option<DataBinding>` 추가(profile_json 직렬화).
2. **`PendingAssignment`**(`grpc/coordinator.rs:22-27`): `data_binding: Option<DataBinding>` 필드 추가. **행 데이터는 여기 담지 않는다**(R4) — `dataset_id`+정책+매핑만. 행은 워커 Register 후 DB에서 스트리밍.
3. **proto `RunAssignment.data_binding`**: 컨트롤러가 `PendingAssignment`에서 채움(Rust policy→proto Policy 변환, `unique` 거부는 §4대로 dispatch 빌드 시점에 이미 끝남).

### 7.3 워커 로딩 단계 — R1 수정 (HIGH)
현재 `client.rs:62-74`는 Register 후 **첫 메시지를 무조건 `Assignment`로 강제**하고 `main.rs:182`는 데이터셋 대기 없이 `run_scenario` 시작. → **새 로딩 단계 도입**:
- 컨트롤러: Register 수신 후 `RunAssignment` 전송 → `data_binding.row_count`>0이면 DB에서 행을 **배치로 스트리밍**(`dataset_rows ORDER BY idx`, 매핑 적용한 `DatasetRow`로 변환, 배치당 예: 1000행) → `DatasetBatch` N개 전송. (R4: PendingAssignment에 행을 안 들고, send 시점 DB 스트림.)
- 워커(worker-core): `Assignment` 수신 후 `data_binding`이 있으면 **로딩 상태** 진입 — `DatasetBatch`를 누적해 `Vec<BTreeMap<String,String>>`이 `row_count`에 도달하면 `Arc<DataSet>` 빌드, **그 다음** `run_scenario` 시작. 로딩 중에도 `Abort`는 처리(취소 시 즉시 종료). `data_binding` 없으면 기존 즉시 시작 경로 그대로.
- 계약 테스트: row_count 도달까지 대기→시작 / 로딩 중 abort / batch 순서.

## 8. 엔진 (본문 템플릿팅 8a · 인덱싱/overlay 8c)

### 8a — 본문 템플릿팅 (`executor.rs:69-78`)
- `Body::Form(map)` → 각 값 `render`. `Body::Json(v)` → `serde_json::Value` walk, **문자열 leaf만** `render`(객체/배열 재귀, number/bool/null·키 보존). 하위 호환.
- 단위 테스트: form 값 치환, 중첩 JSON 문자열 leaf 치환+number 보존, 미바인딩 무변경. (`executor.rs`에 인라인 `#[cfg(test)]` 이미 있음 → tdd-guard 통과.)

### 8c — 인덱싱 / overlay (`runner.rs`)
- `run_scenario`/`run_vu`에 `dataset: Option<Arc<DataSet>>` + (순차용) `Arc<AtomicU64>` 전달. `run_vu`/`execute_steps`는 이미 args 많음(`#[allow(clippy::too_many_arguments)]`) — 파라미터 묶음 struct 도입 고려.
- **overlay 지점 (F4 정밀)**: `runner.rs:197`이 **iteration마다** `iter_vars = scenario.variables.clone()` 재생성 → 데이터 overlay는 이 clone **직후, `execute_steps` 전**. per-VU는 같은 idx, per-iteration은 while 루프마다 idx 갱신. 우선순위: scenario.variables → **데이터** → extract(실행 중 `iter_vars.extend`).
- `${ENV}`(시스템/env)와 `{{var}}`(flow)는 별 네임스페이스 — 데이터는 `{{var}}`만 채움. 매핑 var가 `vu_id` 등 시스템명이어도 `${vu_id}`와 충돌 안 함(별 경로); 단 `{{vu_id}}`로 읽으면 데이터값(엣지, 문서화).
- `rows.is_empty()`는 검증 게이트(§11)에서 차단되어 도달 안 함(방어적 skip).

## 9. UI (Datasets 페이지 8b · RunDialog 바인딩 8c)

### 8b — Datasets 페이지
목록 + 드래그드롭 업로드 → 서버 파싱 결과(컬럼·미리보기 표) → 이름 확인·저장. 얇은 override 패널(헤더·구분자·인코딩·시트) 미리보기 위, 오감지 시 즉시 재파싱.

### 8c — RunDialog 바인딩 섹션 (M1/M2 수정 — 신규 surface 큼)
- **신규 `{{var}}` 스캐너** (현재 없음 — `template.ts::resolveForDisplay`는 `${ENV}`만): 시나리오에서 `{{var}}`를 url·headers·**body form/json 문자열 leaf**까지 추출, `flattenHttpSteps`(`model.ts:104`)로 loop `do:` 재귀. **body 스캔 필수**(기능 핵심이 body 주입).
- **RunDialog는 현재 시나리오 YAML을 안 가짐**(`scenarioId`+`hasLoop`만) → 바인딩 섹션은 **시나리오 YAML·데이터셋 목록·샘플 행을 fetch하는 신규 서브컴포넌트**.
- 표(확정 목업 `mapping-hybrid-v2`): 행=변수, 자동 스캔으로 생성, 모든 행 ✕ 삭제 가능, 컬럼/리터럴 선택, "+ 추가"·"감지됨(미사용)" 칩, 정책 드롭다운, row 0 샘플.
- per-iteration 선택 시 **항상 경고 배너**: "전체 N행(~X MB) 워커 메모리 적재. 상한은 controller `--dataset-max-rows`(Helm `controller.datasetMaxRows`)로 조정." per-VU 경고 없음.
- **검증(차단)**: 시나리오가 쓰는 `{{var}}`가 데이터·시나리오기본값·env 어디에도 없으면 빨간불+차단(엔진 `UnknownVar` 일치). 리터럴 사용은 정상. `unique` 선택 시 "다음 슬라이스" 안내 차단.
- flex `min-w-0`/`shrink-0`(RunDialog 함정), Zod 검증, `pnpm build` 게이트. RTL: 자동행·추가/삭제·자동매칭·미해결 차단·정책 경고.

## 10. 성능

- per-VU: 데이터 크기 무관 가벼움(슬라이스). per-iteration: 메모리 ∝ 행수(100만≈200MB), 상한 기본 100만(조정 가능).
- 인덱싱: per-VU 모듈로 / 순차 `AtomicU64::fetch_add`(Relaxed, 락 없음) / 랜덤 PRNG 1회 — 모두 HTTP RTT 대비 무시 가능.
- body 템플릿팅(JSON walk)은 요청당 1회 — 8a에서 A/B 측정(미바인딩 vs 바인딩, 200VU×20s, 1KB body), run-to-run 변동 범위 내 확인.
  - **8a 구현 후 측정**: `just bench-throughput`(flat GET, body 없음, 200VU×30s, 1KB resp)는 **20,320 RPS / p50 8 / p95 17 / p99 24ms** — post-Slice-6 baseline(20,389 RPS / p95 17 / p99 24) 대비 ~0.3% 차로 변동 범위 내. 단 이 bench 시나리오는 **요청 body가 없어** 8a 코드 경로(form 맵 재구성 / JSON walk)를 타지 않는다 — `Body` arm 자체가 스킵되므로 8a는 이 경로에서 구조적 no-op. 실제 8a 비용은 body 보유 요청에만, body 크기에 비례해 요청당 1회 발생하고 직렬화 + HTTP RTT에 묻힌다(현 bench 하네스는 body 시나리오 미지원 — 별도 측정은 8c 데이터 주입에서).

## 11. 에러·경계·재현성 (단일 검증 게이트 — C2)

- **단일 검증 게이트 = `POST /api/runs`(=bind/run-create 시점)**: (a) 매핑 컬럼이 데이터셋에 존재? (b) 빈 데이터셋 거부 (c) `unique` 거부 (d) per-iteration이면 행수 ≤ `--dataset-max-rows`. 업로드(8b)는 빈/대용량 허용(저장은 무제한). per-VU는 상한 안 막음.
- 행<VU(per-VU): wrap(`vu_id%rows`) 정상. per-iteration wrap: 순환(소진 아님; `unique`만 소진=종료, 연기).
- iter_random 재현성: seed=run_id fold → 같은 run 재생/리포트 동일 시퀀스.
- **멀티워커(이후)**: `iter_sequential`/`iter_random`은 **워커-로컬**(워커마다 독립 카운터/시드 → 행 재사용; wrap이라 허용). `unique`는 전역 조율 필요 → 그 슬라이스에서 컨트롤러가 워커별 행 파티션. ADR-0022 기록.
- 데이터셋 삭제 후 과거 run: 리포트 무영향(step_id 집계), dataset_id는 run config 스냅샷에 잔존(식별 가능).
- **로그 위생**: 워커/컨트롤러 로그에 데이터 행 값 미출력(마스킹 슬라이스 전 기본).
- **워커 재빌드 함정**: 8a/8c는 엔진·워커 변경 → `cargo run -p handicap-controller`는 `target/debug/worker`를 안 고침. 수동 점검 전 `cargo build -p handicap-worker` 필수(plan에 명시).

## 12. 명시적 연기 (Future)

- **`unique` 정책**: Rust enum variant 예약(API 거부). proto enum·엔진 인덱싱·run 종료 조건·멀티워커 파티션은 구현 슬라이스에서. 격리 지점 = 엔진 인덱싱 함수 + run 종료 + 컨트롤러 파티션.
- **민감정보 마스킹**: 별도 보안 슬라이스(컬럼별 토글, 미리보기/리포트 마스킹, 감사). 이번엔 로그 미출력만.
- **JSON 숫자/타입 주입**: 문자열 leaf만. number/bool는 표현 결정 후.
- **데이터셋 버전·diff·편집** / **멀티워커 행 파티션**.

## 13. 완료 기준 (하위 슬라이스별)

- **8a**: form/JSON-leaf 템플릿팅 단위 테스트 통과, 미바인딩 무변경, A/B 회귀 없음. 독립 출하 가능.
- **8b**: 파싱 단위(CSV/CP949/BOM/XLSX/시트/경계 8+), `/api/datasets` CRUD+multipart, Datasets 페이지 RTL, `pnpm build`. 데이터셋 생성·조회·삭제 e2e.
- **8c**: proto `DataBinding`/`DatasetBatch`, 워커 로딩 단계 계약 테스트(누적·abort·순서), 컨트롤러 슬라이싱+배선+`unique` 거부, 엔진 인덱싱·overlay 단위, wiremock 통합(per-VU가 VU마다 다른 값 도달; iter_sequential 순회), `{{var}}` 스캐너+RunDialog RTL, 업로드→per-VU run→리포트 e2e.
- 공통: ADR-0022, CLAUDE.md "알아둘 결정들"·상태·함정 갱신.

## 14. 의존성 & 호환성 검사 (R6 — 8b/8c plan Task 0에서 검증)

- **8b**: `csv`, `calamine`, `encoding_rs` + `axum` `multipart` feature. **버전 핀 + MSRV 1.85 / edition 2024 `cargo build` 검증을 plan 첫 task로**(calamine은 zip/quick-xml 등 트리 큼 → Docker 이미지 크기·오프라인 vendoring 확인, ADR-0001).
- **8c**: `rand`(현재 transitive lockfile만 — 명시 의존성 추가) + MSRV 검증.
- 새 deps는 추가 후 `just build && just lint && just test` 통과 확인하고 lockfile 커밋.

## 15. 추가되는 ADR

- **ADR-0022 — Data-driven 데이터셋**: 독립 Dataset 리소스 + mapping-agnostic/policy-aware worker + 정책 인지 슬라이싱 + 3 정책(per-VU 기본) + 워커 로딩 단계 + 멀티워커 워커-로컬 wrap invariant. 거절 대안(inline/ephemeral/전체스트리밍/lazy-fetch). `unique`·마스킹·타입주입 연기. 8a/8b/8c 분할 근거.
