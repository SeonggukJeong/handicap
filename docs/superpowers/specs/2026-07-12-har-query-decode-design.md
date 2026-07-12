# HAR 가져오기 — URL 경로·쿼리 안전 디코딩 (HAR import 정밀화, UI-only)

- **날짜**: 2026-07-12
- **상태**: 설계 승인(사용자 2026-07-12, 프로토타입 전/후 실측 확인) → spec-plan-reviewer 1R 반영(unreserved 디코딩 제거로 와이어 불변식 강화)
- **출처**: 사용자 요청(도그푸딩) — HAR 가져오기 시 URL의 쿼리스트링(및 경로)이 percent-인코딩된 채(`%ED%95%9C%EA%B8%80`, `%3A%2F%2F` 등) 시나리오에 박혀 가독성이 나쁘다.
- **연관**: HAR→시나리오 가져오기(`ui/src/import/harToScenario.ts`·`filters.ts`·`ScenarioImportPage.tsx`), 선행 spec `2026-06-15-har-scenario-import-design.md`·`2026-06-26-har-import-ux-design.md`·`2026-07-06-har-import-referer-origin-design.md`.
- **ADR**: 신규 불필요 — 기존 HAR import의 additive 정밀화(아키텍처 결정 없음).
- **범위 확정(사용자)**: 쿼리 + 경로 둘 다 디코딩(2026-07-12). 접근 = "가져오기 시 안전 디코딩"(표시-전용·무조건 전체 디코딩 기각).

---

## 1. 문제와 목표

HAR `request.url`은 캡처 원문 그대로 percent-인코딩돼 있다. 변환(`wireStep`/`parameterizeUrl`)이 이를 그대로 시나리오 스텝 URL·스텝 이름에 넣고, 가져오기 미리보기 목록도 원문을 표시한다 → 한글 경로/쿼리·공백이 전부 `%XX` 범벅이라 QA가 어떤 요청인지 알아볼 수 없고, 에디터/YAML 편집 시에도 그대로다. form 바디는 이미 `URLSearchParams`로 디코딩 저장 중(`formRecord`)이라 URL만 비일관.

- **목표**: 가져오기 시점에 URL의 경로·쿼리에서 **전송 의미가 바뀌지 않는 문자만** 디코딩해 사람이 읽는 형태로 저장·표시한다.
- **비목표(연기)**: §7 참조. 헤더 값 디코딩·기존 시나리오 소급 변환·`+`→공백 해석은 안 한다.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST — `safeDecodeUrl(url)`은 URL의 경로·쿼리 구간에서 연속 `%XX` run을 UTF-8로 디코딩하되, **허용 집합**(① 비ASCII 가시 문자 = `\p{C}`·`\p{Z}` 제외, ② 공백 0x20 — **ASCII unreserved는 디코딩하지 않음**, 리뷰 1R: 유일한 와이어-바이트 변경 클래스인데 실익 없음)에 드는 문자만 디코딩 확정 | unit: 한글 경로/쿼리·`%20` 디코딩 + `%41%42%43` **불변** golden | 순수 함수 |
| R2 | MUST — 허용 외로 디코딩되는 escape(공백 0x20을 제외한 ASCII 전부 — 구조 `%25 %26 %3D %2B %23 %2F %3F`·unreserved `%41`류·템플릿 `%7B %7D %24` — 및 제어/비가시 문자)는 **원문 escape 텍스트 그대로 보존**(run에서 해당 문자의 UTF-8 바이트 수×3 만큼 원문 슬라이스 — hex 케이스 재작성 없음)하며, 판정은 run 내 **문자 단위**(혼합 run은 부분 디코딩: `%EA%B9%80%26%EC%9D%B4`→`김%26이`) | unit: 중첩 URL(`redirect=https%3A%2F%2F…`) 불변·템플릿 문자 불변·혼합 run·소문자 `%2f` 케이스 보존 golden | |
| R3 | MUST — `scheme://authority` 프리픽스와 `#fragment`는 불변이고, `new URL` 재직렬화를 쓰지 않는다(호스트 소문자화·기본포트 제거 등 부수효과 금지); 상대 URL·`${VAR}` 프리픽스 입력도 그대로 동작 | unit: authority 내 escape 불변·`${BASE_URL}/…?tab=%ED%99%88`→`…tab=홈`·fragment 불변 | |
| R4 | MUST — 깨진 escape(`%2`, `%GG`)와 유효하지 않은 UTF-8 run(`%FF%FE`)은 원문 유지, 함수 전체 no-throw | unit: 해당 입력 불변·no-throw | |
| R5 | MUST — 멱등: `safeDecodeUrl(safeDecodeUrl(x)) === safeDecodeUrl(x)` | unit: 디코딩 결과 재적용 불변(대표 케이스 + property) | |
| R6 | MUST — 적용 3지점: ① `wireStep` 스텝 URL = `safeDecodeUrl(parameterizeUrl(rawUrl, hostVars))`(hostVars on/off 모두), ② 스텝 이름 = `` `${method} ${safeDecodeUrl(pathOf(rawUrl))}` ``, ③ 미리보기 행 표시 텍스트·aria-label(표시만 — `previewEntries` 데이터는 원문 유지) | golden: 인코딩 HAR→디코딩 URL/이름(on/off), RTL: 미리보기 디코딩 표시 | |
| R7 | MUST — Referer/Origin 헤더 값(`parameterizeRefHeaders`)·form/JSON 바디·`filters.ts`(dedupKey/isStaticAsset/entryHost — 원문 기준)는 무변경 | 기존 테스트 green + **`%XX` escape가 든 Referer 값이 인코딩 그대로 남는** 신규 단언(ASCII-only fixture는 vacuous — 리뷰 1R #1) | |
| R8 | MUST — 디코딩된 URL(한글·공백 포함)이 든 생성 YAML은 `parseScenarioDoc` green(에디터 게이트 통과)이며, YAML 자동 인용 분기를 golden으로 고정: ⓐ 디코딩 결과에 `: `(콜론+공백)가 생기는 URL, ⓑ 보존된 `#fragment` 직전에 디코딩된 공백이 오는 URL | golden: ⓐⓑ 포함 생성 YAML round-trip + `parseScenarioDoc` 단언(리뷰 1R #2) | |

---

## 3. 핵심 통찰 (설계 근거)

1. **엔진 실측 — 전송 바이트 동일의 근거**: `crates/engine/src/executor.rs:137-158`은 렌더된 URL 문자열을 reqwest(`url` crate = WHATWG URL 파싱)에 그대로 넘긴다. WHATWG 파서는 경로·쿼리의 비ASCII(C0-control 인코딩 집합이 U+007E 초과 전부 커버)를 UTF-8 percent-이스케이프로, 공백을 `%20`으로 재인코딩한다 → 허용 집합(비ASCII 가시 문자·공백)은 **와이어 바이트가 디코딩 전과 동일**(유일 예외: 원문이 소문자 hex였던 escape를 디코딩한 경우 재인코딩이 대문자 — RFC 3986 §2.1이 hex 케이스 무관 동등 규정). 리뷰 1R에서 unreserved 디코딩(유일한 raw-전송 클래스)을 제거해 이 불변식을 전 클래스로 강화했다. 설계 승인 시 Node WHATWG `new URL`(같은 스펙)로 10케이스 전/후 `href` 동일을 실측(스크래치 프로토타입, 2026-07-12) — 단 Node와 Rust `url` crate는 별개 구현이므로 최종 근거는 §6-3 라이브 검증(필수, "UI-only라 생략" 불가)이다.
2. **allow-list여서 안전이 구조적**: 구조 문자(`&`/`=`/`%`/`+`/`#`/`%2F`)와 템플릿 토큰 문자(`{`/`}`/`$`)는 허용 집합에 없어 **by-construction 보존** — 중첩 URL이 안 깨지고, 디코딩이 `{{`/`${` 토큰을 만들어 엔진 `render()`/cast 검증/`resolveForDisplay`와 상호작용할 경로 자체가 없다(신규 토큰 문법 아님 → ui/CLAUDE.md의 resolver 동시수정 규칙 비발동). 무조건 전체 `decodeURIComponent`(접근 C)를 기각한 이유.
3. **`new URL` 재직렬화 대신 텍스트 3분할**: `new URL(url)`로 파싱→재조립하면 호스트 소문자화·기본포트 제거·경로 정규화 같은 의도 밖 변형이 섞인다. 정규식으로 `scheme://authority` 프리픽스와 `#fragment`를 잘라내고 나머지(경로+쿼리)에만 escape-run 치환을 적용하면 절대/상대/`${VAR}` URL이 균일하게 처리되고 변형 표면이 `%XX` run으로 한정된다.
4. **form 바디 선례와 일관**: `formRecord`는 이미 `URLSearchParams`로 디코딩해 저장하고 엔진이 전송 시 재인코딩한다 — 같은 "저장은 사람이 읽는 형태, 전송은 표준 재인코딩" 모델을 URL에도 적용하는 것.
5. **Referer/Origin 값은 제외**: 헤더 값은 엔진이 URL 파싱 없이 verbatim 전송하므로 디코딩하면 실제 와이어 바이트가 바뀐다(referer 검사 서버에서 캡처와 다른 동작 위험). 스텝 URL과 달리 재인코딩 안전망이 없다.
6. **비가시 문자(`\p{C}`·`\p{Z}` 비ASCII) 보존**: nbsp·zero-width 류를 풀면 YAML에 보이지 않는 문자가 들어가 편집 시 조용히 깨지는 함정이 된다 — 가독성 목적에 반하므로 인코딩 유지.
7. **R2×R4 상호작용(의도된 동작)**: 부분 디코딩(문자 단위 판정)은 run **전체**가 유효 UTF-8로 디코딩될 때만 일어난다. 유효 한글 escape에 깨진 바이트가 인접한 run(`%EA%B9%80%FF`)은 `TextDecoder(fatal)` 실패로 **run 전체가 원문 보존**된다(김만 살리는 바이트-레벨 분할은 하지 않음 — 구현 단순성·보수성 우선, 리뷰 1R 노트).

---

## 4. 변경 상세

### 4.1 신규 `ui/src/import/urlDecode.ts` — 충족 R: R1–R5

순수 모듈, 외부 의존 없음:

```ts
// escape-run 단위 안전 디코딩. 문자열 어디에도 throw 없음.
export function safeDecodeComponent(s: string): string; // %XX run만 치환
export function safeDecodeUrl(url: string): string;     // authority/fragment 보존 후 나머지에 적용
```

- `ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g` — 연속 escape를 한 run으로.
- run → 바이트 배열 → `TextDecoder("utf-8", { fatal: true })`; 실패 시 run 원문 반환(R4·통찰 #7 — run 전체 보존).
- 문자별 판정: 허용 = 공백(0x20) 또는 비ASCII 가시 문자(`cp >= 0x80 && !/[\p{C}\p{Z}]/u`)(R1). 비허용 문자는 run 원문에서 **해당 문자의 UTF-8 바이트 수 × 3 만큼 슬라이스해 그대로 출력**(escape당 3문자 고정 폭이라 문자↔원문 구간이 1:1 — hex 케이스 재작성 없음, R2).
- `AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/` 프리픽스와 첫 `#` 이후를 잘라 보존(R3).

### 4.2 `ui/src/import/harToScenario.ts` — 충족 R: R6(①②)·R7

- `wireStep`: `const url = safeDecodeUrl(parameterizeUrl(rawUrl, opts.hostVars));` — `${VAR}` 프리픽스엔 `%XX`가 없어 불변, 매핑/미매핑/상대 URL 모두 한 경로.
- 스텝 이름: `` name: `${method} ${safeDecodeUrl(pathOf(rawUrl))}` ``(pathname엔 `?`가 없어 전부 경로로 취급; 파싱불가 fallback(raw url)도 동일 규칙).
- `foldHeaders`/`parameterizeRefHeaders`/`wireBody`/`formRecord`는 무변경(R7).

### 4.3 `ui/src/pages/ScenarioImportPage.tsx` — 충족 R: R6(③)

- 미리보기 행: `{p.method} {safeDecodeUrl(p.url)}` + `aria-label` 동일 값으로 — 렌더-시 순수 호출(표시 전용). `previewEntries`/`dedupSet`/`hostsOrdered`/`buildEnvInput` 입력은 원문 유지(R7).

### 4.4 테스트 — 충족 R: 전부

- 신규 `ui/src/import/__tests__/urlDecode.test.ts`: §2 acceptance의 unit 전부(한글/공백 디코딩·unreserved `%41` 불변·중첩 URL·템플릿 문자·혼합 run·소문자 hex 보존·깨진 입력/UTF-8 run 전체 보존·authority/fragment·`${VAR}`·멱등).
- `harToScenario.test.ts`: 인코딩 entry golden(디코딩 URL·이름, hostVars on/off)·**`%XX` 든 Referer 값 인코딩 유지**(리뷰 1R #1 — ASCII-only fixture는 vacuous)·생성 YAML `parseScenarioDoc` green + R8 ⓐⓑ 인용 분기 golden(ⓐ 구성 주의: `%3A`(콜론)는 ASCII라 보존되므로 `%3A%20`으론 `: `를 못 만든다 — raw `:`(쿼리에서 RFC 3986 합법) + `%20` 조합, 예 `?q=key:%20val` → `?q=key: val`).
- `ScenarioImportPage.test.tsx`: 인코딩 HAR 업로드 → 미리보기 행이 디코딩 표시. (참고: 표시·aria-label이 함께 디코딩되므로 쿼리는 인덱스/행 스코프 사용 — 서로 다른 원문이 같은 디코딩 표시로 수렴할 수 있는 이론적 케이스는 무해.)

---

## 5. 무변경 / 불변식 (명시)

- `crates/**`·proto·migration·`ui/src/api/**`(Zod 스키마)·와이어 포맷 0-diff — UI-only.
- Referer/Origin 헤더 값 경로(`parameterizeRefHeaders`) byte-identical.
- `filters.ts` 전체(정적 필터·dedup·호스트 추출) byte-identical — 원문 URL 기준 로직 유지.
- form/JSON 바디 변환(`wireBody`/`formRecord`) byte-identical.
- escape가 없는 URL 입력엔 출력 byte-identical(기존 ASCII-only HAR golden 전부 불변).
- 디코딩은 hostVars on/off·헤더 모드와 직교(항상 적용, 토글 없음 — 안전 집합이라 옵션 불요).

---

## 6. 테스트 / 검증

1. **unit/golden/RTL**: §4.4. TDD 순서(테스트 먼저 — tdd-guard).
2. **게이트**: `pnpm lint && pnpm test && pnpm build`(전체).
3. **라이브 검증(필수 — "UI-only라 생략" 불가, 통찰 #1의 Node≠Rust 구현 갭 봉합)**: 엔진 코드는 0-diff지만 엔진이 소비하는 URL 데이터 형태가 바뀌므로 와이어 실증 1회 — 한글 쿼리·경로가 든 HAR을 UI로 가져와 시나리오 생성 → 로깅 echo responder(`print(f"REQ {self.command} {self.path}")` 변형 — 루트 CLAUDE.md: 번들 responder는 no-op)로 test-run 또는 run 실행 → ① 와이어 REQ 라인에 `%ED%95%9C%EA%B8%80` 등 **재인코딩된 바이트 도달** grep, ② **같은 HAR의 디코딩-전 형태 시나리오(인코딩 URL을 직접 넣은 대조군)와 REQ 라인 동일 비교(필수** — hex 케이스 무관 비교, 리뷰 1R #3).

---

## 7. 의도적 연기 (roadmap에 누적 안 함 — 재요청 시 재평가)

- 기존 저장된 시나리오의 소급 디코딩(재가져오기로 해결 가능).
- ASCII unreserved(`%41`→`A`) 디코딩 — 리뷰 1R에서 제거: 유일한 와이어-바이트 변경 클래스(RFC 3986 §2.3 동등이긴 함)인데 브라우저 HAR엔 사실상 안 나와 실익 없음.
- 쿼리 `+`→공백 해석(원문 `+`는 형태 보존 — form-스타일인지 리터럴인지 판별 불가).
- Referer 등 헤더 값 디코딩(§3-5 — 와이어 변경이라 별개 문제).
- 에디터 일반 URL 필드의 디코딩 도우미(가져오기 외 입력 경로).
- `#fragment` 디코딩(HAR 요청 URL에 사실상 없음).

---

## 8. 구현 순서 (plan 입력)

1. `urlDecode.ts` + unit 테스트(TDD, 순수 함수 — 테스트 먼저).
2. `harToScenario.ts` 배선 + golden 갱신/신규.
3. `ScenarioImportPage.tsx` 미리보기 표시 + RTL.
4. 전체 게이트 스윕(`pnpm lint && pnpm test && pnpm build`).
5. 라이브 검증(§6-3).
