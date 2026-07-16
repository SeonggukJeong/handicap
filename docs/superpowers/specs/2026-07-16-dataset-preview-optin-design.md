# 데이터셋 미리보기 opt-in·페이지 크기·sequential 행 선택 (dataset-preview-optin)

- **날짜**: 2026-07-16
- **유형**: user-path (UI-only 소형 — 와이어/서버/store/proto 0-diff)
- **출처**: `roadmap.md §B23` "미리보기 UX 후속 3건 (사용자 피드백 2026-07-16, editor-dataset-testrun 머지 직후)" — 원문 앵커: "데이터셋 선택만 해도 미리보기 테이블이 자동 노출되는 현재 동작이 **원하지도 않는 많은 데이터가 나와 시각적으로 피곤**". 메모리 [[ui-optional-sections-collapsible]]의 "대량 데이터 테이블/미리보기도 자동 노출 금지(명시 버튼 뒤 opt-in·페이지 크기 선택)" 축의 구현.
- **선행**: editor-dataset-testrun (ADR-0047, 머지 `1ea9e81`) · dataset-preview (머지 `32556c7`)

## 사용자 스토리 (US)

- **US1**: QA가 에디터 test-run에서 데이터셋을 선택할 때 원하지 않는 행 데이터에 시달리지 않는다 — 성공하면 데이터셋 선택 직후 화면에 행 테이블이 없고, "데이터 확인" 버튼을 누른 뒤에만 미리보기가 나타난다.
- **US2**: QA가 행 미리보기에서 한 번에 볼 행 수를 스스로 고른다 — 성공하면 선택지(10/25/50/100, 기본 10)에서 고른 개수만큼만 행이 렌더되고, 다음에 미리보기를 열어도 그 선택이 유지된다(에디터·데이터셋 페이지 동일 적용).
- **US3**: QA가 sequential 검증의 시작 행을 지정할 때 행 번호를 외워 치는 대신 미리보기에서 눈으로 보고 고른다 — 성공하면 클릭한 행이 하이라이트되고 "시작 행" 입력에 그 번호가 채워진다.

(행위자 = QA · user-path 3건 · brainstorming에서 사용자 승인 2026-07-16)

## 배경 (현행 코드)

- `TestRunDatasetSection.tsx`(에디터 test-run 접이식 데이터셋 섹션): single_row 모드에서 데이터셋을 선택하면 `DatasetRowsPreview`가 **무조건 렌더**된다(§B23 ①의 문제 지점). sequential 모드엔 미리보기가 **아예 없다**(③).
- `DatasetsPage.tsx`: 이미 opt-in — 행별 "미리보기" 버튼(`aria-expanded`) 뒤에서만 `DatasetRowsPreview` 렌더. **①의 수정 대상이 아니다.**
- `DatasetRowsPreview.tsx`(공유): `DATASET_ROWS_PAGE_SIZE = 50` 고정(`hooks.ts`), `useDatasetRows(id, offset)`의 queryKey는 `["datasets", id, "rows", offset]`. 행 클릭 선택은 `onSelectRow`/`selectedRow` optional prop으로 이미 존재(R12, single_row에서 사용 중).
- 서버 `GET /api/datasets/{id}/rows`는 이미 `limit` 쿼리 파라미터를 받는다(`datasets.rs`: default 50, **1–200 검증**) — ②는 클라이언트만 바꾸면 된다.

## 범위 / 비목표

**범위**: `ui/src`의 3파일 중심 — `TestRunDatasetSection.tsx`(①③), `DatasetRowsPreview.tsx`+`hooks.ts`(②), `ko.ts`(문구), + 신규 소형 prefs 모듈, 테스트.

**비목표**:
- 서버/컨트롤러 변경 없음(limit 1–200 기존 그대로), proto/store/migration 0-diff.
- DatasetsPage의 자체 "미리보기" 토글 동작 변경 없음(이미 opt-in — ②의 페이지 크기 UI만 공유 컴포넌트를 통해 자동 획득).
- §B23의 N1–N4 nit(빈 var 매핑·seqTruncated 카피·중복 var 422 문구·하드코딩 사본)·spec §7 연기 항목은 **이 슬라이스에 포함하지 않는다**.
- sequential 실행 결과(RowsTrace)·test-run payload 형태 변경 없음 — ③은 시작 행 *입력 방법*만 추가.

## 요구사항

### R1 — 에디터 test-run 미리보기 opt-in (US1)

1. `TestRunDatasetSection`의 `DatasetRowsPreview`는 기본 **미렌더**. 데이터셋 선택(`selected != null`) 시 토글 버튼 **"데이터 확인"**(`ko.editor.dsPreviewToggle`, `aria-expanded` — `DatasetsPage`의 "미리보기" 버튼과 같은 이디엄)을 렌더하고, 눌렀을 때만 그 바로 아래에 미리보기를 렌더한다. 버튼+미리보기는 **모드별 입력 블록 뒤, 매핑 편집기 앞**의 두 모드 공통 위치 한 곳(single_row 분기 안의 현행 미리보기는 이 공통 위치로 이동). 렌더 사이트는 하나지만 **`onSelectRow`/`selectedRow` prop은 모드별로 계산**한다(삼항): single_row = `onRowIndexChange` / `rowIndex ?? undefined`(현행), sequential = R3.2/R3.3의 startRowDraft 기반 — "공통 위치"가 고정 prop을 뜻하지 않는다.
2. `previewOpen` state는 `DatasetBody`가 아니라 **`TestRunDatasetSection`(부모)에** 둔다 — 섹션 접기/펴기(`open`)로 `DatasetBody`가 unmount돼도 상태가 유지되는 기존 state 배치(mode·rowIndex 등)와 일관.
3. **single_row·sequential 두 모드 공통** — 버튼·열림 상태는 모드 전환에도 유지된다(같은 데이터셋의 같은 데이터라 리셋 이유 없음).
4. **데이터셋 변경/해제 시 `previewOpen = false` 리셋** — `handleSelectDataset`의 기존 리셋(rowIndex·start/limit draft·mappings)과 같은 자리.
5. 접힌(=버튼 안 누른) 상태에서 rows fetch **0회** — `DatasetRowsPreview` 자체를 조건부 마운트(`{previewOpen && …}`)해서 `useDatasetRows`가 아예 안 불리게 한다(기존 "접힘 중 fetch 0" 지연-마운트 계약의 확장).
6. 행 번호 직접 입력 경로(기존 Input)와 `dsIncompleteRow` 안내 문구("행 번호를 선택하세요 — 미리보기에서 행을 클릭하거나 직접 입력")는 불변 — 미리보기를 열지 않아도 single_row 구성은 완결 가능.

### R2 — 페이지 크기 선택 (US2, 와이어 무변경)

1. `DatasetRowsPreview` 툴바(행 범위 표시와 같은 행)에 페이지 크기 `Select`(`size="sm"`, `aria-label=ko.dataset.pageSizeLabel`)를 추가한다. 옵션 **10 / 25 / 50 / 100**, 기본 **10**. **`Select`는 BASE가 `block w-full`이라 폭 제한은 반드시 래퍼 `<div className="w-NN">`으로**(직전 dataset-preview 슬라이스가 물린 문서화 함정 — `ui/src/components/ui/CLAUDE.md`, jsdom/tsc 미검출).
2. `hooks.ts`: `DATASET_ROWS_PAGE_SIZE`(50 고정) 상수를 `DATASET_ROWS_PAGE_SIZES = [10, 25, 50, 100] as const` + `DATASET_ROWS_DEFAULT_PAGE_SIZE = 10`으로 대체한다. `useDatasetRows(id, offset)` → `useDatasetRows(id, offset, limit)`으로 확장하고 **queryKey에 limit 포함**(`queryKeys.datasetRows(id, offset, limit)`) — limit이 키에 없으면 크기 변경이 stale 캐시를 그대로 보여준다.
3. **localStorage 영속**: 신규 모듈 `ui/src/components/datasets/previewPrefs.ts` — `loadPreviewPageSize(): number` / `savePreviewPageSize(n): void`, 키 `handicap:dataset:preview-page-size:v1`. `editorPrefs.ts` fail-soft 이디엄: localStorage 불가/파싱 실패/**옵션 목록에 없는 값**(예: 예전 저장값·오염) → 기본 10, save 실패는 조용히 무시. `DatasetRowsPreview`가 `useState(loadPreviewPageSize)`로 시드하고 변경 시 save — 공유 컴포넌트 내부 state라 에디터·DatasetsPage 두 사용처에 자동 적용된다.
4. 크기 변경 시 **offset 유지**(offset은 행 단위라 새 limit에서도 유효 — 페이지 번호가 아님), 이전/다음 버튼 보폭과 `nextDisabled` 판정(`offset + limit >= total`)은 현재 limit 기준. `jump()`의 clamp(총 행 기준)는 불변.
5. 서버는 이미 `limit` 1–200을 검증하므로(range 밖 400) 클라 옵션 4종은 전부 유효 — 서버 diff 0.

### R3 — sequential 미리보기: 클릭 = 시작 행 (US3)

1. sequential 모드에서도 R1의 공통 위치 opt-in 미리보기가 그대로 보인다(별도 렌더 분기 없음 — R1.1의 이동으로 자동 획득).
2. `onSelectRow={(idx) => onStartRowDraftChange(String(idx + 1))}` — 클릭한 행의 1-based 번호를 시작 행 draft에 쓴다(기존 draft→`start_row` 0-based 변환 로직 그대로 통과).
3. `selectedRow`는 **startRowDraft에서 파생**: draft가 유효한 정수 ≥ 1이면 `n - 1`, 아니면(빈 값·비수치) `undefined` — 직접 입력과 클릭이 양방향으로 일치(입력을 치면 하이라이트가 따라온다).
4. `row_limit`·mappings·payload 형태에는 영향 없음.

### R4 — 문구 (ADR-0035)

신규 사용자 노출 문구는 전부 `ko.ts` 경유:
- `ko.editor.dsPreviewToggle = "데이터 확인"` (사용자 원문 카피 유지 — DatasetsPage의 "미리보기"는 리소스 자체 탐색, 에디터 쪽은 "test-run에 넣을 데이터를 확인"이라 의도가 달라 별도 키).
- `ko.dataset.pageSizeLabel = "표시 행 수"` (Select aria-label 겸 인접 라벨).

## 테스트 계획

**`TestRunSection.dataset.test.tsx`** (기존 파일 확장 — localStorage 만지는 파일이므로 `beforeEach(() => window.localStorage.clear())` 확인/추가):
- T1: 데이터셋 선택 직후 — 미리보기 테이블 부재 + rows fetch 미발생("데이터 확인" 버튼은 존재, `aria-expanded=false`).
- T2: "데이터 확인" 클릭 → 미리보기 렌더 + rows fetch 발생(limit=10). 재클릭 → 닫힘.
- T3: 미리보기 연 채 데이터셋 변경 → 닫힘 리셋(`aria-expanded=false`·테이블 부재).
- T4: sequential 모드 — 미리보기 열고 행 클릭 → 시작 행 input에 1-based 번호 채워짐 + payload `start_row` 0-based 반영(기존 R11 payload 테스트 이디엄).
- T5: sequential — 시작 행 직접 입력 시 해당 행 하이라이트(`aria-pressed`) / 빈 draft면 하이라이트 없음.
- **기존 10개 케이스에는 미리보기 의존 단언이 없다**(전부 행 번호/시작 행 Input 직접 입력 — 리뷰어 실증). R1은 이 파일의 기존 케이스를 깨지 않으므로 토글-선행 수정 불요; 신규 T1–T5만 추가.

**`DatasetRowsPreview.test.tsx`** (기존 파일 **마이그레이션 + 확장** — 이 파일이 이번 테스트 작업의 본체):
- **기존 15개 중 ~13개가 페이지 크기 50을 하드코딩**(`rowsRange(1, 50, 1000)`·`rowsRange(51, 100, …)`·`rowsRange(743, 792, …)` 등) — 기본값 10 전환으로 전부 깨진다. **마이그레이션 전략 = 기본 10 기준으로 재작성**(localStorage에 50을 시드해 보존하는 대안은 기각 — 기존 스위트가 새 기본 경로를 커버하는 쪽이 회귀 이빨이 있고, 매 테스트 시드 결합도 피함): 범위 단언을 10 보폭으로 기계적 치환(`rowsRange(1, 10, 1000)`·jump 743 → `rowsRange(743, 752, 1000)` 등).
- **경계 테스트(총 30행 = "1페이지" 전제, `nextPage` disabled 단언)는 전제 자체가 깨진다**(크기 10에선 3페이지) — fixture를 총 8행 등 "10 이하 = 1페이지"로 바꿔 같은 경계(마지막 페이지 `nextDisabled`)를 유지.
- 신규: T6: 기본 크기 10 — 첫 fetch가 `limit=10`.
- T7: 크기 select 변경(25) → `limit=25` refetch + localStorage 저장.
- T8: localStorage에 저장된 25로 재마운트 시 초기 크기 25 / 오염값(비옵션·malformed)은 기본 10.
- T9: 크기 변경 시 offset 유지(offset>0 상태에서 크기 변경 → fetch offset 불변) + 이전/다음 보폭 = 현재 크기.

**게이트**: `pnpm lint && pnpm test && pnpm build` (파이프 없이 `; echo exit=$?`로 종료코드 확인). `findLast` 등 ES2023 금지(tsconfig lib ES2022).

## 라이브 검증 (US 척추 — user-path 필수)

vite dev(`localhost`) + 워크트리 자체 controller 바이너리 + 격리 DB + 행 30+개 데이터셋 업로드 후 Playwright:

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 에디터 test-run 섹션 펼침 → 데이터셋 선택 | 행 테이블 **부재**(DOM에 table 없음) + network에 `/rows` 요청 0 → "데이터 확인" 클릭 후 테이블 등장 |
| US2 | 미리보기에서 크기 25 선택 → 페이지 새로고침 후 재열기 | `/rows?…limit=25` 요청 실측 + 렌더 행 수 25 + 재열기 시 25 유지 |
| US2' | DatasetsPage "미리보기" | 같은 크기 select 존재·기본 10(또는 저장값) 동작 |
| US3 | sequential 모드 → 미리보기 → 행 7 클릭 | "시작 행" input 값 `7` + 행 7 하이라이트(`aria-pressed=true`) |

콘솔 에러 0 확인. 시각 표면(테이블 렌더 행 수)은 DOM 카운트로 단언(#5 false-PASS 클래스 회피 — 존재만이 아니라 개수).

## 리스크 / 함정 메모 (plan이 상속할 것)

- `keepPreviousData`: limit 변경 시 placeholder가 이전 크기 데이터를 잠깐 보여줌(offset 변경과 동일한 기존 수용 동작) — `isPlaceholderData` 동안 버튼 disable 기존 로직 그대로.
- tdd-guard: 테스트 파일 편집을 src 편집보다 먼저(ui/CLAUDE.md).
- localStorage 폴리필/격리: `setup.ts` 글로벌 `afterEach(cleanup+clear)` 존재 — 파일 내 케이스 간 오염은 beforeEach clear로 이중 방어.
- `DATASET_ROWS_PAGE_SIZE` 소비처 전수 치환(`grep -rn DATASET_ROWS_PAGE_SIZE ui/src`) — prev/next 보폭·nextDisabled가 남은 50을 참조하면 보폭 불일치.
- 페이지 크기 `Select`의 폭은 래퍼 `<div className="w-NN">`으로만 제한 가능(BASE `block w-full`이 호출부 className을 이김 — `ui/src/components/ui/CLAUDE.md`, 직전 슬라이스 실물 함정·jsdom/tsc 미검출 → 라이브 검증에서 툴바 한 줄 레이아웃 확인).
