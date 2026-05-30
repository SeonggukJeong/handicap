# ADR-0022 — Data-driven 데이터셋 (독립 리소스 + 서버 파싱)

* Status: Accepted
* Date: 2026-05-30
* Deciders: handicap maintainers
* Tags: dataset, csv, xlsx, parser, controller, ui

## Context

Slice 8(data-driven). 8b에서 리소스+파싱이 출하됨. 바인딩/주입은 8c.

QA 팀이 "사용자 ID 목록" 같은 외부 데이터를 시나리오에 주입해 데이터 다양성 테스트를 할 수
있어야 한다(ADR-0013 §4.5 데이터셋 확장). Slice 8a에서 body 템플릿팅을 먼저 완성했으므로,
8b는 템플릿 변수에 주입할 데이터셋을 독립 DB 리소스로 저장하는 기반을 만든다.

설계 명세: `docs/superpowers/specs/2026-05-29-slice-8-data-driven-design.md`.

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
    id        TEXT PRIMARY KEY,   -- ULID
    name      TEXT NOT NULL,
    file_name TEXT NOT NULL,
    columns_json TEXT NOT NULL,   -- JSON array of column names (순서 보존)
    row_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL   -- Unix ms
);

CREATE TABLE IF NOT EXISTS dataset_rows (
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    row_index  INTEGER NOT NULL,
    row_json   TEXT NOT NULL,     -- {"col":"value"} — 컬럼 이질성·매핑 용이
    PRIMARY KEY (dataset_id, row_index)
);
```

행은 `{"col":"value"}` JSON으로 저장. 컬럼 순서는 `columns_json`으로 별도 보존.

### 파싱 모듈

`crates/controller/src/datasets/parse.rs` — 순수 함수, no I/O:

- **CSV**: `csv` 1.4 크레이트. 구분자(`,`/`;`/`\t`) 자동감지(첫 4KiB 샘플링).
  `encoding_rs` 0.8로 UTF-8 BOM strip + CP949 fallback.
  헤더 없음→`col0`/`col1`/…, 빈/중복 컬럼명 정규화(`_2` suffix), 짧은 행 빈 문자열 패딩.
- **XLSX**: `calamine` 0.26 크레이트. 단일 시트(기본 첫 번째) + 다중 시트 이름 지정 지원.
  `ExcelDateTime` → ISO-8601 문자열, `Float`/`Int` → 소수점 없는 경우 정수 문자열.

### REST API (`/api/datasets`)

| 메서드 + 경로 | 기능 |
|---|---|
| `POST /api/datasets` | multipart 업로드 → 파싱 → DB 저장, 201 + DatasetMeta |
| `POST /api/datasets/preview` | 파싱만(저장 안 함), override options 포함, 200 + ParseResult |
| `GET /api/datasets` | 목록(메타만, 행 미포함) |
| `GET /api/datasets/{id}` | 메타 + sample 20행 |
| `DELETE /api/datasets/{id}` | 8b: 무조건 삭제. 비-terminal run 참조 409 가드는 8c |

업로드/preview POST 라우트에만 `DefaultBodyLimit::max(256 MiB)` — 기본 2MB로는 실제 데이터셋
업로드가 막힘. 전역 변경 금지(`/runs`·`/scenarios`는 소형 JSON).

### 데이터 바인딩·주입

**8c에서 결정.** `profile_json` 컬럼의 새 `data_binding` 필드(`#[serde(default)]`) + worker
로딩 단계 + 3 정책(per_vu 기본/iter_sequential/iter_random). 8b는 runs 테이블 무변경.

## Consequences

**Positive**
- 데이터셋 재사용: 여러 시나리오·run이 같은 dataset_id를 참조.
- 서버 파싱: 브라우저 번들 추가 없이 오프라인 UX 유지. 대용량(수만 행) XLSX 처리.
- `CREATE TABLE IF NOT EXISTS` migration: controller 재시작 무한히 안전.
- `runs` 테이블 무변경: 8c 바인딩 추가 시 `profile_json`의 `#[serde(default)]`만.

**Negative / Trade-offs**
- DELETE는 8b에서 무조건 삭제: non-terminal run이 참조하는 데이터셋 삭제 시 409 가드가
  없어 run 실행 중 데이터셋 사라질 수 있음 — 8c(`data_binding` 도입) 이전엔 실제 참조가
  없으므로 8b 범위에서 허용.
- calamine 0.26은 런타임 의존성에 codepage/quick-xml/zip/zopfli 4크레이트를 추가
  (이미지 크기 모니터링 권장).
- UploadPanel 라이브 미리보기는 응답 시퀀싱 없음(8b 알려진 한계) — 옵션 연속 변경 시
  stale 미리보기 가능. 8c 또는 후속에서 AbortController 가드 추가 가능.

## 명시적 연기 (Out of scope)

- **8c**: `data_binding` profile 필드, 3 정책 인지 슬라이싱, worker 로딩, per-VU 행 배분,
  DELETE 409 가드.
- **후속**: `unique` 정책 / 민감정보 마스킹 / JSON 숫자·타입 주입 / 멀티워커 전역 커서 /
  데이터셋 버전·diff·편집. (spec §12)

## Links

- ADR-0013 (Scenario/RunConfig 분리) — 독립 리소스 결정의 근거
- ADR-0021 (loop 메트릭 breakdown) — `CREATE TABLE IF NOT EXISTS` + `profile_json` 패턴 precedent
- ADR-0016 (VU 실행 모델) — worker lazy-fetch 거절 근거
- Spec `docs/superpowers/specs/2026-05-29-slice-8-data-driven-design.md`
