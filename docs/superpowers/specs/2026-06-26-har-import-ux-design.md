# HAR 가져오기 UX 개선 — 요청 선택·중복 처리 + 호스트→환경변수 등록 (사용성 묶음 A, UI-only)

- **날짜**: 2026-06-26
- **상태**: 설계 승인(사용자 2026-06-26) → plan 대기
- **출처**: 사용자 요청(사용성 개선 4종 중 A — roadmap §UX1). HAR을 올리면 모든 요청이 체크돼 있어 추리기 불편하고, 절대 URL이라 환경 이식이 안 됨 → 가져오기 단계에서 바로 해소.
- **연관**: `ui/src/pages/ScenarioImportPage.tsx`, `ui/src/import/filters.ts`, `ui/src/import/harToScenario.ts`, ADR-0025(Environments), ADR-0014(변수 표기 `${ENV}`), ADR-0035(ko 카탈로그). 함정: ui/CLAUDE.md "HAR import R2"(와이어-형 검증), "jsdom File.text 없음".
- **ADR**: 신규 불필요 — 기존 ADR-0025(Environments) 리소스를 기존 `POST /api/environments`로 소비하고, 출력은 기존 와이어-형 YAML. 새 결정 없음.

---

## 1. 문제와 목표

HAR 가져오기(`ScenarioImportPage`)는 전부 클라이언트 변환(`harToScenarioYaml` → `/scenarios/new` 핸드오프, 시나리오는 에디터 저장 시 생성)이다. 두 가지 마찰: ① 업로드 시 모든 요청이 체크된 채라(특히 폴링·캐시버스터로 같은 엔드포인트가 수십 번 잡힘) 추리기 번거롭고 어디가 중복인지 안 보인다. ② 변환기가 절대 URL(`https://api.example.com/path`)을 그대로 내보내 시나리오가 특정 환경에 박혀 재사용이 어렵다.

- **목표**: (②) 요청 목록에 전체 선택/해제·중복 해제 액션 + 중복 시각 표시 + 선택/중복 요약. (③) 옵트인으로 호스트를 `${변수}`로 치환하고 그 변수들을 담은 환경(Environment)을 등록(POST)할 수 있게.
- **비목표(연기)**: §7 참조. 서버측 import·기본 선택 상태 변경·호스트별 개별 환경 없음.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 요청 fieldset에 **[전체 선택]** 버튼 — 미리보기(필터 통과) 전 요청을 선택(=`excludedIndices` 비움). | `ScenarioImportPage.test.tsx` 클릭 후 전 체크박스 checked | |
| R2 | MUST **[전체 해제]** 버튼 — 미리보기 전 요청의 원본 인덱스를 `excludedIndices`에 추가(전부 해제). | RTL 클릭 후 전 체크박스 unchecked + YAML steps 0 | |
| R3 | MUST **[중복 해제]** 버튼 — `dedupKey` 그룹마다 HAR 순서상 첫 요청만 두고 2번째+를 `excludedIndices`에 *추가*(순수 subtractive — 어떤 행도 재선택하지 않음, 수동 해제와 합성). | RTL: 중복 있는 HAR에서 클릭 후 그룹당 1개만 checked·기존 수동 해제 보존 | |
| R4 | MUST 요청 fieldset에 요약 표기 **`선택 N / 전체 M · 중복 K (method+경로 기준)`** — N=현재 선택 수, M=미리보기 수, K=2번째+ 중복 수. 기준 문구 또는 HelpTip으로 "쿼리스트링 무시" 명시. | RTL: 셋 수치·"method+경로" 문구 단언 | |
| R5 | MUST 미리보기 각 행에서 그룹 내 **2번째+ 발생**(=[중복 해제]가 끌 대상)에 **`중복` 배지** 표시. | RTL: 중복 행에 배지, 첫 발생엔 없음 | |
| R6 | MUST 중복 판정은 순수 헬퍼로: `dedupKey(method,url)` = `method(대문자) + URL.pathname`(쿼리·프래그먼트·호스트 무시), `duplicateIndices(previewEntries)` = 그룹 2번째+ 원본 인덱스 Set. 미리보기(static/host 필터 통과) 집합 위에서만 동작. | `filters.test.ts` 골든(쿼리 무시·method 구분·파싱불가 URL 처리) | |
| R7 | MUST 호스트 fieldset 아래 **옵트인 체크박스 "호스트를 `${변수}`로 바꾸기"**(기본 **off**). off면 기존과 동일. | RTL: 기본 off·토글 동작 | |
| R8 | MUST 체크 시 **포함된 각 호스트마다 편집 가능한 변수명 입력**. 기본값 = 호스트를 (요청 수 desc, 동률 시 first-seen) 정렬해 첫 호스트 `BASE_URL`, 이후 `BASE_URL_2`, `BASE_URL_3`…. 호스트 체크 해제 시 그 매핑 사라짐. | RTL: 2-호스트 HAR에서 두 입력·기본명·호스트 토글 연동 | |
| R9 | MUST 체크 시 URL 치환: 호스트가 매핑에 있는 URL의 `origin`(`scheme://host[:port]`) 접두사를 `${변수}`로 바꿔 `${BASE_URL}/path?q=1` 산출. 매핑에 없는 호스트·상대(파싱불가) URL은 **불변**. 출력은 여전히 **와이어-형**(엔진 `Request` 1:1). | `harToScenario.test.ts` 골든: `${BASE_URL}/path` 리터럴·미치환 케이스·와이어 구조 단언 | ✅ 엔진 `Request.url` 문자열 + `${ENV}` 토큰 해소 |
| R10 | MUST **[환경으로 등록]** — 치환 켜진 상태에서만 노출. `useCreateEnvironment`로 `{변수명: origin, …}` + 편집 가능한 환경 이름(기본=시나리오 이름)으로 `POST /api/environments`. 성공/실패(이름 UNIQUE 409 등) 배너(`role="alert"`/성공 표기). | RTL: `createEnvironment` mock 호출 페이로드·성공·409 배너 | ✅ 기존 `EnvironmentInput`↔서버(계약 무변경) |
| R11 | MUST 변수명 검증 — 빈 값·호스트 간 중복·식별자 패턴(`[A-Za-z_][A-Za-z0-9_]*`) 위반이면 [환경으로 등록] 비활성 + 인라인 경고. (패턴은 `${ENV}` 해소 가능 보장.) | RTL/단위: 빈·중복·`-` 포함 시 disabled+경고 | |
| R12 | MUST 치환 off = `harToScenarioYaml` 출력 **byte-identical**(기존 골든 그대로) · [환경으로 등록] 누르기 전엔 서버 mutation 0. | 기존 `harToScenario.test.ts` 전부 green + off-경로 단언 | |
| R13 | MUST 신규 사용자-노출 문구(버튼·배지·라벨·aria-label·배너) 전부 `ko.import.*` 카탈로그(ADR-0035, 한국어). | `grep`로 인라인 영어/한국어 리터럴 0 | |

- **seam(R9)**: 새 와이어 *계약*은 없음 — `url`은 엔진 `Request`의 `String`이라 `${BASE_URL}/path`도 유효 값. 단 생성 토큰이 **엔진 `${ENV}` 해소 패턴과 lockstep**이어야 함(R11의 식별자 패턴이 이를 보장) → 구현 시 엔진 template의 env-토큰 문법을 확인해 unresolvable 토큰을 만들지 않는다. golden은 와이어 구조(`name:`/`type: http`/`request.url`)를 단언(ui/CLAUDE.md "HAR import R2": 파싱 성공만으론 와이어-정확성 증명 불가).
- **seam(R10)**: 기존 `POST /api/environments`(EnvironmentsPage가 이미 사용) 재사용 — `EnvironmentInput`/`EnvironmentSchema` 계약 **무변경**, 새 엔드포인트 없음.

---

## 3. 핵심 통찰 (설계 근거)

1. **전부 클라이언트.** import은 서버 import 엔드포인트가 없고 YAML을 만들어 `/scenarios/new`로 넘긴다 → ②③ 전부 페이지 상태·순수 헬퍼로 가능. 유일한 서버 호출은 R10의 *기존* 환경 생성 POST. 엔진·proto·migration·런타임 schemas 무변경.
2. **중복은 "보이는 후보" 위에서.** `duplicateIndices`는 미리보기(static/host 필터 통과) 집합 위에서 그룹핑한다 — 끈 호스트·정적 리소스는 애초에 후보가 아니므로 중복 집계에서 빠진다(사용자가 보는 것과 일치). [중복 해제]는 **subtractive**(2번째+를 `excludedIndices`에 추가만)라 수동 해제·전체 해제와 자유 합성된다(R3).
3. **배지는 구조적 속성.** `중복` 배지는 선택 상태가 아니라 "그룹 내 2번째+ 발생"이라는 구조에서 온다 → 수동으로 다시 체크해도 배지는 유지(왜 [중복 해제] 대상인지 일관 표시, R5).
4. **치환은 url 문자열만 바꾼다.** origin 접두사만 `${VAR}`로 치환하므로 출력은 여전히 와이어-형(R9·R12). 변수 *값*은 `URL.origin`(끝 슬래시 없음), 나머지는 `pathname+search+hash` — `${VAR}` + 나머지로 재조립.
5. **변수명 식별자 제약은 안전장치.** `${ENV}` 토큰으로 해소되려면 변수명이 엔진 패턴에 맞아야 한다 → R11이 `[A-Za-z_][A-Za-z0-9_]*`를 강제해 "치환은 했는데 run에서 안 풀리는" 함정을 사전 차단.
6. **환경 등록은 시나리오 저장과 독립.** 환경은 별개 리소스라 import 시점에 만들어도 무방(R10). 시나리오는 나중에 에디터에서 저장되고, run 때 RunDialog가 그 환경을 선택해 `${BASE_URL}`을 해소한다 — 자동 선택은 비목표(§7).

---

## 4. 변경 상세

### 4.1 `import/filters.ts` — 충족 R: R6
- `export function dedupKey(method: string, url: string): string` — `method.toUpperCase() + " " + pathnameOf(url)`. `pathnameOf`는 기존 `pathOf`(파싱불가 시 url 원문) 재사용.
- `export function duplicateIndices(preview: {index:number; method:string; url:string}[]): ReadonlySet<number>` — 입력 순서대로 그룹 첫 발생을 기록, 2번째+의 `index`를 Set에 모음. (페이지의 `previewEntries`와 같은 shape를 받음 — 미리보기 위에서만.)

### 4.2 `import/harToScenario.ts` — 충족 R: R9, R12
- `ConvertOptions`에 `hostVars: Record<string, string>` 추가(host→변수명; 빈 객체=치환 없음).
- 순수 `parameterizeUrl(url: string, hostVars: Record<string,string>): string` — `new URL(url)` 성공 + `host`가 `hostVars`에 있으면 `"${"+varName+"}" + url.pathname + url.search + url.hash`, 아니면 원문.
- `wireStep`의 `url` 산출을 `parameterizeUrl(entry.request.url, opts.hostVars)` 경유. `name`(`METHOD path`)·`pathOf`는 원본 url 기준 유지(표시명은 절대경로 path가 명확).
- `harToScenarioYaml` 시그니처에 `hostVars` 포함(빈 객체 기본=byte-identical, R12).

### 4.3 `import/hostEnv.ts` (신규) — 충족 R: R8, R10, R11
- `defaultHostVars(hostsByCount: string[]): Record<string,string>` — 첫 `BASE_URL`, 이후 `BASE_URL_${i+1}`.
- `originOf(host, entries): string` — 그 호스트의 첫 entry의 `URL.origin`.
- `buildEnvInput(hostVars, originByHost, name): EnvironmentInput` — `{name, vars:{변수명: origin}}`.
- `validateVarNames(hostVars): { ok: boolean; emptyHosts: string[]; dupNames: string[]; invalidHosts: string[] }` — 빈값/호스트 간 중복/패턴(`/^[A-Za-z_][A-Za-z0-9_]*$/`) 위반을 분류해 인라인 경고에 사용.
- `hostsByRequestCount(previewEntries): string[]` — 요청 수 desc, 동률 first-seen.

### 4.4 `pages/ScenarioImportPage.tsx` — 충족 R: R1–R5, R7–R11, R13
- 요청 fieldset 상단: 요약(R4) + 툴바 버튼 3개(R1–R3). `previewEntries`로 `duplicateIndices` 메모, 배지 렌더(R5).
- 호스트→env 섹션: 옵트인 체크박스(R7) → 변수명 입력 목록(R8) + 환경 이름 입력 + [환경으로 등록](R10) + 검증/배너(R11). 치환 on이면 `harToScenarioYaml`에 `hostVars` 전달.
- `useCreateEnvironment` 배선(성공/에러 상태). 모든 문구 `ko.import.*`.

### 4.5 `i18n/ko.ts` — 충족 R: R13
- `ko.import`에 신규 키: `selectAll`/`deselectAll`/`dedup`/`selectionSummary(n,m,k)`/`dupBadge`/`dupCriteria`(HelpTip 본문)/`hostToEnv`/`hostToEnvHint`/`varNameLabel(host)`/`envNameLabel`/`registerEnv`/`envRegistered(name)`/`varNameEmpty`/`varNameDup`/`varNameInvalid` 등. 조사 병기형(ADR-0035, `(으)로`).

---

## 5. 무변경 / 불변식 (명시)

- **엔진·proto·migration·`schemas.ts`(run 와이어)·controller 0-diff.** 유일한 서버 상호작용은 기존 `POST /api/environments`(계약 무변경).
- 치환 off(R7 기본) → `harToScenarioYaml` 출력 byte-identical(R12), 기존 `harToScenario.test.ts` 골든 그대로 통과.
- 기본 선택 상태(전체 체크) 불변 — 툴바는 *액션*만 추가, 자동 해제 없음.
- 정적 제외·호스트 필터·헤더 모드·statusAssert·copy/편집기로 보내기 동선 불변.
- `import → /scenarios/new` 핸드오프(`importedYaml` state) 그대로 — 에디터/RunDialog 무변경.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 | 라이브? |
|---|---|---|
| R1,R2,R3 | `ScenarioImportPage.test.tsx`: 버튼 클릭 후 체크 상태·YAML steps 수 | |
| R4 | RTL: 요약 수치 N/M/K + "method+경로" 문구 | |
| R5 | RTL: 중복 행 배지 존재·첫 발생 부재 | |
| R6 | `filters.test.ts`: dedupKey(쿼리 무시·method 구분), duplicateIndices(그룹 2번째+) | |
| R7,R8 | RTL: 체크박스 기본 off·토글, 2-호스트 변수명 기본값·호스트 토글 연동 | |
| R9 | `harToScenario.test.ts`: 치환 골든(`${BASE_URL}/path`·미치환·와이어 구조 리터럴) | |
| R10 | RTL: `createEnvironment` mock 페이로드·성공/409 배너 | △(권장) |
| R11 | RTL/단위: 빈·중복·`-` 포함 변수명 → disabled+경고 | |
| R12 | 기존 `harToScenario.test.ts` green + 치환 off byte-identical 단언 | |
| R13 | `grep`로 인라인 영어/한국어 리터럴 0(R13 sweep) | |

- **라이브 검증(△ 권장, 머지 전 1회):** run-생성/리포트/엔진 경로는 무변경이라 S-D 갭 직접 해당 없음. 단 **환경 등록(POST)→해소**가 새 동선이므로: import에서 호스트 치환 on → [환경으로 등록] → `/environments`에 보이는지 → 그 시나리오를 저장 후 run에서 환경 선택 시 `${BASE_URL}`이 실제 해소(요청이 올바른 host로 나감)되는지 1회 확인. `createEnvironment`는 기존 엔드포인트(EnvironmentsPage가 이미 사용)라 응답-파싱 위험 낮음. finish 때 `/live-verify`로 최종 판단.

---

## 7. 의도적 연기 (roadmap §UX1·§B에 누적)

- **서버측 HAR import**: 현행 클라이언트 변환 유지. 대용량 HAR 성능·서버 저장은 별도.
- **기본 선택 상태 스마트화**(업로드 시 중복 자동 해제 등): 이번엔 버튼(수동)만. 자동 해제는 놀람 유발 가능 → 사용자 피드백 후 검토.
- **호스트별 개별 환경**: 한 환경에 전 호스트 변수를 모음(다중 환경 생성 아님).
- **생성한 환경의 자동 선택/시나리오 연결**: 시나리오는 나중 저장되므로 import이 run 환경을 미리 못 박지 않음 — 사용자가 RunDialog에서 선택.
- **경로(path) 변수화·동적 경로 토큰화**: 호스트만 변수화. 경로 내 id 등은 비목표.

---

## 8. 구현 순서 (plan 입력)

> 전부 UI 커밋(cargo 무영향 → pre-commit fast-path). 단 **테스트 파일을 먼저** 편집해 pending RED diff를 만든 뒤 src(ui/CLAUDE.md `tdd-guard` 함정) — plan이 src-먼저로 쓰면 첫 편집이 막힌다.

1. **②  선택+중복**: `filters.test.ts`(R6 RED) → `filters.ts` 헬퍼 → `ScenarioImportPage.test.tsx`(R1–R5 RED) → 페이지 툴바/배지/요약 + `ko.import` 키 → green 커밋.
2. **③ 호스트→env**: `harToScenario.test.ts`·`hostEnv.test.ts`(R9/R11 RED) → `parameterizeUrl`/`hostEnv.ts` 헬퍼 → 페이지 env 섹션 + `useCreateEnvironment` 배선(R10) + `ko.import` 키 → green 커밋.
3. (선택) R13 grep sweep 정리 커밋 + 머지 전 `pnpm lint && pnpm test && pnpm build` 전체 1회.
