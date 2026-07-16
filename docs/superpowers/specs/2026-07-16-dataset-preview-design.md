# 데이터셋 미리보기 — 저장된 데이터셋 행을 목록에서 페이징으로 열람 (§A12 도그푸딩 3호)

- **날짜**: 2026-07-16
- **상태**: 설계 승인(사용자 2026-07-16) → plan 대기
- **출처**: `roadmap.md §A12 도그푸딩 백로그` — "데이터셋 미리보기: 저장된 데이터셋 행 미리보기(페이징 — 대용량 대비). 컨트롤러 rows API + UI." 사용자 선택(2026-07-16, 병렬 세션 후보 중).
- **연관**: ADR-0022(데이터셋 리소스·8b), `2026-05-30-slice-8b-dataset-resource.md`(preview 엔드포인트·`get_rows_range` 도입), ADR-0035(ko 카탈로그).
- **ADR**: 신규 불필요 — ADR-0022의 데이터셋 리소스에 읽기 전용 엔드포인트 1개를 가산하는 additive 확장. 새 결정(정책·와이어 계약 변경) 없음.

---

## 1. 문제와 목표

저장된 데이터셋의 행 내용을 UI 어디서도 볼 수 없다. `DatasetsPage`는 이름/컬럼/행수 메타만 보여주고, 업로드-시점 미리보기(`POST /api/datasets/preview`)는 저장 전 1회용이다. QA가 "지난주 올린 그 데이터셋이 맞나", "unique 정책에서 VU #743이 받은 743번째 행이 뭔가", "50만 행이 끝까지 잘 파싱됐나"를 확인하려면 원본 파일을 다시 열어 대조하는 수밖에 없다.

- **목표**: `GET /api/datasets/{id}/rows`(offset/limit 페이징, 기존 `get_rows_range` 재사용) + DatasetsPage 인라인 확장 행 미리보기(행 번호·행 이동·페이징).
- **비목표(연기)**: §7 참조. RunDialog 바인딩 카드 연계·민감값 마스킹·행 검색/필터.

### 사용자 스토리 (설계 검증 기준 — 사용자 요청으로 명문화)

1. **업로드 내용 확인**: 앞 50행을 클릭 한 번으로 확인 → 미리보기 토글 + 첫 페이지(R4·R5).
2. **특정 행 추적**: unique/iter_sequential 진단에서 "N번째 행"을 바로 찾기 → 행 번호 열(R6) + 행 이동 입력(R7).
3. **대용량 끝부분 확인**: 총 행수를 행 이동에 넣어 마지막 페이지 도달(R7).
4. **넓은/긴 데이터**: 가로 스크롤 + 셀 truncate·title 툴팁으로 행 높이 안정(R9).

---

## 2. 요구사항 (정규 — R-id)

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST `GET /api/datasets/{id}/rows?offset=N&limit=M`이 idx 순서 행을 반환한다(기존 `store::datasets::get_rows_range` 재사용, offset 기본 0·limit 기본 50). | controller 통합 테스트: offset/limit 조합 페이징 | |
| R2 | MUST 파라미터 검증 — `offset < 0`·`limit < 1`·`limit > 200`은 400(BadRequest, 한국어 메시지), 없는 dataset id는 404. (타입 불일치 `?offset=abc`는 axum `Query` 추출기가 핸들러 전에 영어 400으로 거절 — 한국어 메시지·테스트 단언은 검증 3종에만 적용.) | 통합 테스트: 400 3종 + 404 | |
| R3 | MUST 응답 shape은 `{"rows":[{col:val,…}],"offset":N,"total":row_count}` — 전 필드 항상 직렬화(Option 없음), UI Zod는 plain 타입(`.nullish()`/`.default()` 불요·금지). | Rust Serialize 테스트 ↔ UI Zod `DatasetRowsSchema` parse 테스트 + 라이브 curl | ✅ wire: UI Zod ↔ controller serde |
| R4 | MUST DatasetsPage 각 행에 "미리보기" 토글 버튼(`aria-expanded`) — 클릭 시 그 행 아래 전폭 인라인 패널, **한 번에 하나만 확장**(다른 행 열면 이전 접힘), 접었다 펴면 offset 0으로 리셋. | RTL: 펼침/접힘/단일 확장/리셋 | |
| R5 | MUST 페이징 — 페이지 크기 50 고정, "이전/다음"은 `offset ∓ 50`(0 미만 clamp, 비경계 offset에서도 50씩 — 742→792), disabled 조건은 이전=`offset === 0`·다음=`offset + 50 >= total`, **`isPlaceholderData` 동안 둘 다 disabled**(연타로 stale total 대비 페이지 건너뜀 방지), "N–M / 총 T행" 표시(1-base). | RTL: 페이지 전환·경계/placeholder disabled·표기 | |
| R6 | MUST 미리보기 테이블 첫 열은 전역 행 번호(#) — 1-base, **응답의 `offset` 기준**(`response.offset + i + 1` — `keepPreviousData` 창에선 로컬 offset은 새 값·표시 행은 옛 페이지라, 로컬 기준이면 옛 행에 새 번호가 붙는 오라벨). 내부 offset은 0-base 유지. | RTL: offset 50 응답에서 첫 행 번호 51 (번호 소스가 응답 offset임을 단언) | |
| R7 | MUST "행 이동" 숫자 입력 + 이동 — n 입력 시 `offset = clamp(n-1, 0, max(total-1, 0))`으로 그 행부터 표시(페이지 경계 스냅 없음), 비숫자/빈 입력은 no-op. | RTL: 743 이동 → 첫 행 #743, 범위 밖 clamp | |
| R8 | MUST 컬럼 헤더·셀 순서는 목록 메타 `columns` 순서(행 객체의 키 순서(BTreeMap 알파벳) 아님). | RTL: columns 순서 ≠ 알파벳 fixture로 헤더 순서 단언 | |
| R9 | MUST 테이블은 `overflow-x-auto` 래퍼 + 셀 `max-w`·`truncate`·`title`(전체 값) — 긴 값이 행 높이를 키우지 않는다. | RTL: title 속성 단언 (시각은 라이브에서) | |
| R10 | MUST 패널 내 상태 표시 — 로딩·에러(`Callout variant="error"`, 404/네트워크)·0행 "행 없음" 빈 상태. | RTL: fetch mock 에러/빈 응답 | |
| R11 | MUST 신규 사용자 노출 문구(aria-label 포함)는 전부 `ko.dataset.*` 카탈로그 경유(ADR-0035). | grep: 신규 컴포넌트에 한글 하드코딩 0 (`"[^"]*[가-힣]` 패턴) | |
| R12 | MUST 무변경 — store/engine/proto/migration 0-diff, 기존 `GET /api/datasets/{id}`(sample)·`POST /api/datasets/preview`·UploadPanel byte-identical. | `git diff` 범위 확인 + 기존 테스트 전부 green | |
| R13 | MUST rows fetch는 패널이 펼쳐진 동안만(mount-게이팅, §4.3 — 훅에 별도 enabled 플래그를 배관하지 않는다), 페이지 전환 시 `placeholderData: keepPreviousData`(React Query v5)로 이전 페이지 유지. | RTL: 접힌 상태 fetch 0회 단언 | |

---

## 3. 핵심 통찰 (설계 근거)

1. **페이징 쿼리는 이미 있다** — `get_rows_range`(`store/datasets.rs:129`)는 워커 스트리밍용(8c spec §7.3)으로 구현·테스트돼 있어 R1은 REST 노출만 하면 된다. store 0-diff(R12)의 근거.
2. **전용 엔드포인트(접근 A)** — 기존 `GET /api/datasets/{id}`에 쿼리를 붙이는 안(B)은 `useDataset` 캐시 키가 페이지마다 갈라지고(DataBindingPanel 공유) `sample`의 "앞 20행" 의미가 오염돼 기각. 전체 다운로드(C)는 §A12의 "대용량 대비 페이징" 요구와 정면 충돌이라 기각. 라우트 `/datasets/{id}/rows`는 리터럴 세그먼트라 `{id}` 캡처와 무충돌(`/runs/{id}/report.csv` 선례, controller CLAUDE.md).
3. **행 번호·행 이동은 스토리 2·3이 요구** — 바인딩 정책(unique/iter_sequential)이 전부 idx 기반이라 "N번째 행"을 못 찾는 미리보기는 진단 가치가 반감된다. 행 이동은 offset 임의 값(비-페이지-경계)으로 구현해 "743 입력 → #743이 첫 행"의 직관을 지킨다(백엔드는 이미 임의 offset 지원 — UI 레벨 추가만).
4. **표시 1-base / 내부 0-base 분리** — QA에게 자연스러운 1-base("총 T행 중 N–M")로 통일 표시하되, offset 파라미터·store idx는 0-base 그대로(변환은 UI 렌더 경계 한 곳: R6의 `response.offset + i + 1`, R7의 `n - 1`).
5. **컬럼 순서는 메타가 권위** — 행 객체는 `BTreeMap` 직렬화라 키가 알파벳 순. 원본 파일의 컬럼 순서는 `datasets.columns_json`에만 보존돼 있으므로 UI는 목록 메타의 `columns`로 헤더·셀을 뽑는다(R8). rows 응답에 columns를 중복 포함하지 않는 이유(목록 페이지 안에서만 쓰이는 패널이라 메타가 항상 곁에 있다).
6. **limit 상한 200** — UI는 50 고정이지만 curl 직접 호출 대비 서버가 상한을 소유(400). 상한은 방어용이고 UI 계약은 50.

---

## 4. 변경 상세

### 4.1 `crates/controller/src/api/datasets.rs` — 충족 R: R1, R2, R3

- `RowsQuery { offset: Option<i64>, limit: Option<i64> }`(serde Deserialize) + `RowsResponse { rows: Vec<BTreeMap<String, String>>, offset: i64, total: i64 }`(Serialize).
- `pub async fn rows(State, Path(id), Query(q))`: 검증(R2, `ApiError::BadRequest` 한국어) → `get_meta`(없으면 `ApiError::NotFound`) → `get_rows_range(&state.db, &id, offset, limit)` → `RowsResponse { total: meta.row_count, … }`.

### 4.2 `crates/controller/src/app.rs` — 충족 R: R1

- `.route("/datasets/{id}/rows", get(datasets_api::rows))` 1줄(기존 `/datasets/{id}` 라우트(85–86) 옆). GET이라 body-limit layer 불요.

### 4.3 `ui/src/api/schemas.ts` · `client.ts` · `hooks.ts` — 충족 R: R3, R13

- `DatasetRowsSchema = z.object({ rows: z.array(z.record(z.string(), z.string())), offset: z.number(), total: z.number() })`(two-arg `z.record` 컨벤션, plain 타입).
- `client.ts`: `getDatasetRows(id, offset, limit)` → `request("/datasets/{id}/rows?offset=&limit=", GET, DatasetRowsSchema)`.
- `hooks.ts`: `useDatasetRows(id: string | undefined, offset: number)` — queryKey는 `queryKeys`에 helper 추가(`["datasets", id, "rows", offset]` 형태), `enabled: Boolean(id)`, `placeholderData: keepPreviousData`. **"펼쳐진 동안만 fetch"(R13)는 별도 enabled 플래그가 아니라 mount-게이팅으로 충족** — 패널(`DatasetRowsPreview`)이 접히면 조건부 렌더로 unmount돼 훅 자체가 사라진다.

### 4.4 `ui/src/components/datasets/DatasetRowsPreview.tsx` (신설) — 충족 R: R5–R10, R13

- props: `{ datasetId, name, columns, rowCount }`(목록 메타에서 — `name`은 패널 aria-label(`previewAria(name)`)용, `rowCount`는 첫 응답 도착 전 "총 T행" 표시와 행 이동 clamp의 초기값, 응답 `total` 도착 후엔 응답이 권위). 내부 state: `offset`(0 시작), 행 이동 draft(string).
- 렌더: 행 번호(#) 열 + `columns` 순서 셀(R8), `overflow-x-auto` + 셀 `max-w-xs truncate` + `title`(R9 — 폭 값은 plan에서 튜닝 가능), 페이징 컨트롤(R5) + 행 이동 입력(R7), 로딩/에러/빈 상태(R10). 테이블 시각은 UploadPanel 미리보기 테이블과 동일 톤(`min-w-full text-sm border …`).
- **placeholder 일관성(R5·R6)**: 행 번호·"N–M" 범위 표기는 **응답의 `offset`/`total`** 에서 도출(로컬 state 아님 — `keepPreviousData` 창에서 옛 행+새 번호 오라벨 방지), 이전/다음은 `isPlaceholderData` 동안 disabled. 행 이동 clamp의 total도 같은 우선순위(응답 total, 첫 응답 전엔 `rowCount` prop).

### 4.5 `ui/src/pages/DatasetsPage.tsx` — 충족 R: R4

- `expandedId: string | null` state + 행별 "미리보기" 토글 버튼(`aria-expanded`, `Button` variant 기존 컨벤션) → 확장 시 `<tr><td colSpan={4}><DatasetRowsPreview …/></td></tr>`. 다른 행 토글 시 교체(단일 확장). `DatasetRowsPreview`가 expandedId 변경으로 remount되며 offset 자연 리셋(R4).

### 4.6 `ui/src/i18n/ko.ts` — 충족 R: R11

- `ko.dataset.*`에 신규 키: 미리보기 토글, 이전/다음, 범위 표기 함수 `(from, to, total)`, 행 이동 라벨/버튼, 행 없음, 미리보기 패널 aria-label 등.

---

## 5. 무변경 / 불변식 (명시)

- **store 0-diff**: `get_rows_range`·`get_meta` 시그니처/동작 그대로(신규 쿼리 없음). migration 0.
- **engine/proto/worker 0-diff**: 요청 실행 경로 미접촉.
- **기존 엔드포인트 byte-identical**: `GET /api/datasets/{id}`(sample 20행)·`POST /api/datasets/preview`·upload·delete 무변경. UploadPanel·DataBindingPanel(`useDataset`) 무변경.
- **RunDialog/스케줄러 미접촉** — 병렬 슬라이스 graceful-ramp-down-cap(워크트리 graceful-grace-cap, engine·proto·RunDialog 계열 — 2026-07-16 master 머지 완료)과 파일 비충돌(ko.ts만 양쪽 append 가능 — 자잘한 머지).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1·R2 | controller 통합 테스트(기존 datasets api 테스트 파일에 추가): 페이징 3케이스·400 3종·404 | |
| R3 | Rust 응답 shape 테스트 + UI `DatasetRowsSchema.parse` 테스트 + **라이브 curl 1회**(실 직렬화 ↔ Zod 대조 — S-D 클래스 확인, Option 없어 위험 낮으나 rigor) | ✅ |
| R4–R10, R13 | RTL(`DatasetsPage.test.tsx`·`DatasetRowsPreview.test.tsx`): fetch mock 페이지별 응답 | |
| R9(시각) | 라이브 Playwright: 펼침 → 긴 값 truncate·가로 스크롤 실측(jsdom 레이아웃 0 한계) | ✅ |
| R11 | 신규 파일 한글 하드코딩 grep(`"[^"]*[가-힣]` — 따옴표 직후 비한글 시작 문구까지 잡는 패턴) | |
| R12 | `git diff --stat` 범위 검토 + `cargo nextest run --workspace` + `pnpm test` 전체 green | |

- 라이브 검증: run-생성/리포트/엔진 경로 비접촉이라 `/live-verify` 풀 스택은 불요 — 컨트롤러+빌드된 UI로 **curl(R3) + 브라우저 펼침·페이징·행 이동 1회(R9 포함)** 를 머지 전 수행.
- 보안 게이트: `api/datasets.rs` 편집이 finish-slice §0 grep(업로드파싱)에 매치할 가능성 높음 → `security-reviewer` 예상(읽기 전용 엔드포인트지만 grep이 지배).

---

## 7. 의도적 연기 (roadmap §A12/§B에 누적)

- **RunDialog 바인딩 카드에서 미리보기 진입**: 사용자 결정(2026-07-16)으로 v1 제외 — RunDialog 복잡도·모달-안-패널 공간 문제. 수요 확인 후 후속.
- **민감값 마스킹**: 데이터셋 값 노출은 기존 업로드 미리보기·`sample`과 동일 클래스(신규 노출 클래스 아님). 일관 마스킹은 §B1 트랙 소유.
- **행 검색/필터·컬럼 정렬**: 스토리에 없고(행 번호 추적이 핵심 진단) 서버 쿼리 확장 필요 — 수요 시 별도.
- **페이지 크기 선택 UI**: 50 고정으로 충분(YAGNI). limit 파라미터는 서버에 이미 있어 후속 시 UI만.

---

## 8. 구현 순서 (plan 입력)

1. **Task 1 (backend)**: `rows` 핸들러 + 라우트 + 통합 테스트(R1·R2·R3 서버 절반) — green 커밋.
2. **Task 2 (UI 계약+훅)**: `DatasetRowsSchema`(R3 클라 절반)·`getDatasetRows`·`useDatasetRows`(R13) + 스키마 테스트 — green 커밋. seam(R3) 양쪽이 1·2에서 연달아 머지되므로 같은 브랜치 내 드리프트 없음.
3. **Task 3 (UI 컴포넌트)**: `DatasetRowsPreview` + DatasetsPage 배선 + ko 키(R4–R11) + RTL — green 커밋.
4. **최종**: handicap-reviewer(+ 보안 게이트 grep 매치 시 security-reviewer) → 라이브 curl+Playwright(§6) → finish-slice.
