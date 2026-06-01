# Header / Form-Body 편집 UX 개선 (2열 그리드 + Bulk Edit + 자주 쓰는 헤더 피커)

* Status: 설계 (구현 전). 신규 ADR 없음 — 순수 UI, 와이어/모델 무변경.
* Date: 2026-06-01
* 관련 ADR: ADR-0003(GUI↔Code 양방향 sync), ADR-0005(UI 스택 TS/React), ADR-0014(변수 표기 `{{var}}`/`${ENV}`), ADR-0015(양방향 sync = Zustand + Zod + YAML AST round-trip), ADR-0018(VU별 자동 cookie jar)
* 로드맵: A3(멀티 워커 fan-out) 착수 **전** 끼워넣는 독립 UI 개선. 범위가 `ui/src/components/scenario/`에 갇혀 A3와 충돌 없음.
* 원천: 사용자 요청(2026-06-01) — "Header와 Body가 Form일 때 하나하나 입력하는 게 귀찮다. 여러 개를 한 번에 편하게 입력하는 방법 + 자주 쓰는 Header 선택 기능."

## 1. 개요 · 목표

**문제**: 시나리오 에디터 Inspector에서 HTTP 스텝의 **Headers**(`Inspector.tsx:181` `HeadersEditor`)와 **Form body**(`Inspector.tsx:324` `FormBodyField`)는 둘 다 거의 동일한 KV 편집기로, **한 번에 한 행씩** 입력한다 — key 텍스트 입력 → "Add" 클릭 → 그 다음 value 채우기. 헤더/폼 필드가 여러 개면 클릭 왕복이 많아 번거롭다. 또 매번 `Content-Type`·`Authorization` 같은 흔한 헤더 이름을 손으로 친다.

**목표**:
1. **여러 쌍을 한 번에 입력** — "Bulk Edit" 토글로 textarea를 열어 `Key: Value`(헤더) / `key=value`(폼) 여러 줄을 붙여넣고 한 번에 반영. Header·Form body 둘 다.
2. **자주 쓰는 헤더 선택** — 큐레이션된 헤더 목록을 **메뉴 버튼 + Key 칸 자동완성** 둘 다로 제공, 선택 시 추천 값까지 시드.
3. 기존 행 편집 자체도 개선 — 깔끔한 2열 그리드, **key·value 둘 다 인라인 편집**(현재는 key가 불변).

**핵심 결정** (brainstorming 2026-06-01 확정):

- **편집 UI = 2열 그리드(기본) + Bulk Edit 토글(보조).** Postman/Bruno의 실제 모델(그리드 primary + bulk-text secondary)을 따른다. 순수 textarea-only는 ① 콜론/등호 split 엣지, ② 엔진 `BTreeMap` 정렬로 인한 순서 round-trip 마찰, ③ 매 키스트로크 파싱+검증, ④ 이미 존재하는 전체-시나리오 YAML/Monaco 탭과 역할 중복 — 때문에 기각.
- **공유 컴포넌트로 추출.** 거의 동일한 `HeadersEditor`/`FormBodyField`의 중복을 `KeyValueGrid` 하나로 통합(작업하는 김에 정리 — 두 곳에 같은 버그/개선을 두 번 안 하도록).
- **Bulk Edit = Postman 방식(전체 교체).** 토글을 열면 **현재 entries가 텍스트로 채워져** 열리고, 자유 편집 후 Apply하면 그 텍스트가 **전체 집합을 교체**(WYSIWYG, 텍스트에서 지운 줄 = 삭제).
- **자주 쓰는 헤더 = 메뉴 + 자동완성 둘 다, 값 시드 포함.** Headers 전용. Form body엔 공통 필드명이 없어 피커 미제공(그리드 + Bulk만).
- **Form 벌크는 urlencoded 의미.** 쌍 구분자 `\n`과 `&` 둘 다, 각 쌍 첫 `=` split, **퍼센트 디코딩(`%20`·`+`→공백)**. 엔진이 `req.form()`으로 재인코딩하므로 디코딩된 raw 값이 맞다(§2). Form 벌크 영역에 *"urlencoded 값은 자동으로 디코딩됩니다"* 안내 문구를 표시.
- **순수 UI 변경 — 와이어/모델/백엔드 무변경.** 모델은 그대로 `Record<string,string>` → YAML map → 엔진 `BTreeMap`. 기존 `setStepField` 경로 재사용, 새 `yamlDoc.ts` Edit variant·proto·migration·엔진 코드 전부 불필요.

## 2. 기존 코드 사실 확인 (구현 전 코드 대조)

- ✅ **Headers·Form body 둘 다 `Record<string,string>` 맵.** `ui/src/scenario/model.ts`: `RequestModel.headers = z.record(z.string(), z.string()).default({})`; `BodyModel`의 form 변형 = `{ kind: "form", value: z.record(z.string(), z.string()) }`(discriminated union). 둘 다 string→string, 중첩 없음.
- ✅ **현재 편집기 = 단일-입력 add-row 패턴.** `HeadersEditor`(`Inspector.tsx:181–247`)·`FormBodyField`(`Inspector.tsx:324–385`)는 거의 동일: `Object.entries(map)`로 행 렌더, key는 불변 `<span>` + value `<input>` + 행별 `×`, 하단에 "새 key 입력 + Add" 한 칸. 둘 다 `setStepField(step.id, path, next)`로 커밋(헤더는 `["request","headers"]`, 폼은 `["request","body"]`에 `{form: next}`).
- ✅ **재사용할 KV 편집 패턴이 이미 있음.** `EnvironmentPicker.tsx`는 **2-필드(key+value 동시) 행** + 하단 2-필드 add-row 패턴; `VariablesPanel.tsx`는 key 라벨+value 입력+삭제 + 2-필드 add-row; `ExtractEditor`(Inspector 내)는 **로컬 draft + onBlur 커밋 / 구조변경 즉시 커밋** 패턴. → `KeyValueGrid`는 이 커밋 패턴(로컬 draft 리스트 → onBlur·구조변경 시 map 커밋)을 채택해 포커스 유실·key rename·재렌더 마찰을 회피.
- ✅ **엔진이 form 값을 재인코딩.** `crates/engine/src/executor.rs:104–110` `Body::Form(map)` → 각 값 `render(v, ctx)` 후 `req.form(&rendered)`(reqwest). reqwest가 요청 시점에 `application/x-www-form-urlencoded`로 **percent-encode** 한다. → map에는 **디코딩된 raw 값**이 저장돼야 이중 인코딩이 안 난다 ⇒ Form 벌크 파싱 시 urlencoded 디코딩이 옳다.
- ✅ **엔진 와이어 = `BTreeMap<String,String>`.** `crates/engine/src/scenario.rs`: `Request.headers: BTreeMap<String,String>`, `Body::Form(BTreeMap<String,String>)`. 직렬화 시 키 알파벳 정렬 → UI가 YAML에 쓴 순서는 **런타임엔 cosmetic**(엔진이 정렬). YAML 문서 자체는 authored 순서 보존.
- ✅ **편집 반영 경로 = `setStepField` 그대로.** `store.ts:49` `setStepField(stepId, path, value)` → `yamlDoc.ts` `applyEdit`의 `setStepField` 핸들러(`doc.setIn`, `~293–309`)가 targeted edit → 재파싱 + Zod 검증 → store 갱신. 본 기능은 **map 전체를 새 객체로 한 번 set** 하므로 새 Edit variant 불필요. `normalizeBody`(`yamlDoc.ts ~480–487`)가 YAML `{form:{…}}` ↔ TS `{kind:"form",value:{…}}` 변환을 이미 담당.
- ✅ **게이트.** UI는 `pnpm test`(vitest+RTL) + `pnpm build`(`tsc -b && vite build`)가 최종 게이트. pre-commit hook은 cargo만 돌리므로 UI 변경은 수동으로 `cd ui && pnpm test && pnpm build`(`ui/CLAUDE.md`).
- ⚠️ **`<datalist>` 자동완성 + 값 시드.** 네이티브 `<datalist>`는 선택 시 side-effect 콜백이 없다 — 대신 `<input>` onChange에서 "현재 값이 알려진 헤더 이름과 정확히 일치 && value 칸이 비어 있음"을 감지해 추천 값을 시드한다. (커스텀 콤보박스 승급은 후속 여지.)

## 3. 컴포넌트 설계

모두 `ui/src/components/scenario/` 아래. 새 데이터 모듈은 `ui/src/scenario/`.

### 3-1. `KeyValueGrid` (신규, 공유)

2열 그리드 본체 + Bulk 토글 진입점. `HeadersEditor`/`FormBodyField`가 이걸 감싼다.

```
props:
  entries: Record<string, string>
  onChange(next: Record<string, string>): void
  keyPlaceholder?: string          // 예: "Header" / "field"
  valuePlaceholder?: string
  bulkFormat: "header" | "form"    // 파싱/포맷 규칙 + Bulk 안내문구 선택
  commonKeys?: CommonHeader[]       // 주어지면 메뉴+자동완성+값시드 활성 (Headers만)
```

- **로컬 draft 모델**: 내부 state는 `Array<{ key: string; value: string }>`(insertion order 유지). 행 추가/삭제·key rename·value 편집을 draft에서 자유롭게 하고, **onBlur / 구조변경(추가·삭제·피커 insert·Bulk apply) 시 `toRecord(draft)`로 map을 만들어 `onChange`** (ExtractEditor 패턴). `entries` prop이 외부에서 바뀌면(YAML 탭 편집 등) draft를 재동기화(useEffect, 깊은 비교 또는 직렬화 비교).
- **`toRecord`**: dedupe(같은 key는 **last-wins**), 빈 key 행은 제외. 순서는 draft 순서대로 YAML에 기록(엔진은 정렬하므로 cosmetic).
- **기존 행**: `[ key input ] = [ value input ] [×]`. key·value 둘 다 편집 가능(현재 불변 span에서 개선). key rename은 draft에서 자연 처리.
- **add-row**: 하단 `[ key ] = [ value ] [Add]`, key 비면 Add 비활성, Enter로 추가하고 포커스 다음 행 key로(EnvironmentPicker UX).
- **상단 우측 액션**: `[ Bulk Edit ]` 토글. `commonKeys` 있으면 `[ 자주 쓰는 헤더 ▾ ]` 메뉴 버튼도.

### 3-2. `BulkEditPanel` (신규)

`KeyValueGrid` 안에서 토글로 열리는 textarea 패널.

```
props:
  entries: Record<string, string>   // 열 때 텍스트로 채울 현재 값
  format: "header" | "form"
  onApply(next: Record<string, string>): void
  onCancel(): void
```

- 열릴 때 `formatEntries(entries, format)`로 textarea 초기값을 채운다(Postman 방식 — 현재 값 prepopulate).
- `[ Apply ]` → `parseBulk(text, format)` 결과로 **map 전체 교체**(`onApply`). `[ Cancel ]` → 닫기.
- 파싱 중 **무시된 줄 수**를 라이브 힌트로 표시("구분자 없는 줄 N개 건너뜀").
- Form일 때 안내문구: *"한 줄에 `key=value`, 또는 `a=1&b=2`처럼 `&`로 연결. urlencoded 값은 자동으로 디코딩됩니다."*
- Header일 때 안내문구: *"한 줄에 `Header: Value`."*

### 3-3. `commonHeaders.ts` (신규 데이터 모듈)

```
export interface CommonHeader { name: string; value: string }
export const COMMON_HEADERS: CommonHeader[] = [ … ]   // §5 큐레이션 (사용자 최종본 대기)
```

순수 데이터 + 부수 헬퍼(`findCommonHeader(name): CommonHeader | undefined`, 대소문자 무시 매칭 — 자동완성 시드용. 단 저장되는 key는 사용자가 친/선택한 literal 그대로, 케이스 정규화 안 함 §7).

### 3-4. `HeadersEditor` / `FormBodyField` 재작성

```
HeadersEditor   = <KeyValueGrid entries={headers} onChange={…setStepField(["request","headers"])}
                    bulkFormat="header" commonKeys={COMMON_HEADERS} keyPlaceholder="Header" />
FormBodyField   = <KeyValueGrid entries={form}    onChange={…setStepField(["request","body"], {form: next})}
                    bulkFormat="form" keyPlaceholder="field" />   // commonKeys 없음 → 피커 없음
```

기존 onChange 커밋 경로(§2)는 그대로 — 행 편집·Bulk apply·피커 insert 전부 같은 `setStepField`로 수렴.

## 4. 파싱 / 포맷 규칙 (`ui/src/scenario/kvBulk.ts`, 순수 함수 — 단위 테스트 핵심)

```
parseBulk(text: string, format: "header" | "form"): { entries: Record<string,string>; skipped: number }
formatEntries(entries: Record<string,string>, format): string
```

**공통**
- key/value 각각 `trim`. 빈 줄 skip. 구분자 없는 줄·trim 후 빈 key 줄은 **skip(카운트해서 힌트)**. dedupe last-wins.
- `{{var}}`/`${ENV}` 토큰은 평범한 문자열로 통과(특별 처리 없음 — 엔진이 런타임 렌더).

**Header (`format: "header"`)**
- 쌍 구분자: 줄바꿈만. 각 줄 **첫 `:`** 기준 split(값에 `:` 포함 안전, 예 `X-Url: http://x` → 값 `http://x`).
- 값 디코딩 **없음**(HTTP 헤더 값은 리터럴).
- `formatEntries`: `key: value` 줄들을 `\n`으로 join.

**Form (`format: "form"`)**
- 쌍 구분자: **`\n`과 `&` 둘 다**. 각 쌍 **첫 `=`** 기준 split(base64 `==` 패딩 안전).
- key·value 둘 다 **percent-decode + `+`→공백**(urlencoded). 디코딩 실패(잘못된 `%` 시퀀스)는 해당 토큰을 **원문 그대로** 보존(throw 금지).
- `formatEntries`: raw 값을 `key=value`로 join(`\n`). 단 값/키에 **구조 문자**(`&`, `=`, 줄바꿈, `%`, `+`, 선행/후행 공백)가 있으면 그 쌍만 최소 percent-encode 해서 re-parse가 깨지지 않게 한다. 그 외엔 raw 표시(가독성).

## 5. 큐레이션된 자주 쓰는 헤더 (사용자 최종본 대기)

아래는 **placeholder 기본값**이다. 사용자가 사내에서 자주 쓰는 헤더를 추후 별도로 전달하면 `commonHeaders.ts`를 그 목록으로 교체/확장한다(구현 task에서 한 줄 수정).

| Header | 시드 값 |
|---|---|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Authorization` | `Bearer {{token}}` |
| `Accept-Encoding` | `gzip, deflate` |
| `Accept-Language` | `en-US` |
| `Cache-Control` | `no-cache` |
| `User-Agent` | `handicap-loadtest` |
| `X-Request-Id` | `{{requestId}}` |
| `Origin` | (빈값) |
| `Referer` | (빈값) |

> `Cookie`는 **일부러 제외** — ADR-0018에 따라 VU별 쿠키 jar가 세션을 자동 관리하므로, 수동 `Cookie` 헤더를 권하면 오해 소지.

## 6. 자주 쓰는 헤더 피커 동작 (Headers 전용)

- **메뉴 버튼** `자주 쓰는 헤더 ▾`: 클릭 → `COMMON_HEADERS` 목록 → 항목 선택 시 draft에 행 추가(`{name, value}`). 같은 key가 이미 있으면 그 행의 value를 추천 값으로 갱신(중복 행 안 만듦). 선택 후 메뉴 닫고 그 value 칸 포커스.
- **Key 칸 자동완성**: add-row와 기존 행의 key `<input>`에 `list={datalistId}` 부착, `<datalist>`가 `COMMON_HEADERS[].name` 제안. onChange에서 `findCommonHeader(typed)`가 일치 && 같은 행 value가 비어 있으면 추천 값 시드(사용자가 곧바로 덮어쓸 수 있음).

## 7. 비목표 (non-goals)

- **사용자 정의 헤더 목록 저장/공유** — 큐레이션은 하드코딩 `commonHeaders.ts`로 충분. 팀 공유/서버 저장은 후속.
- **JSON/raw body 편집기 변경** — 이번엔 Form 변형만 대상. JSON/raw는 기존 그대로.
- **헤더 이름 대소문자 정규화** — 와이어 1:1 유지(엔진 `BTreeMap`은 literal 키). 자동완성 매칭만 대소문자 무시.
- **멀티값 헤더(같은 key 여러 번)·disabled 행 토글** — `Record<string,string>` 모델 밖. 필요 시 모델 확장이 선행돼야 함(별도 spec).
- **백엔드/proto/migration 변경** — 전무.

## 8. 테스트 전략 (vitest + RTL, `tsc -b` 게이트)

- **`kvBulk.ts` 순수 함수**(가장 가치 큼):
  - `parseBulk` header: `Key: Value` 멀티라인, 첫 `:` split(값 내 `:`), 빈/무효 줄 skip + count, dedupe last-wins.
  - `parseBulk` form: `\n`/`&`/혼합 구분, 첫 `=` split(base64 `==`), **urlencoded 디코딩**(`%20`·`+`→공백), 잘못된 `%` 보존.
  - `formatEntries` ↔ `parseBulk` **라운드트립**(header·form 각각), form 구조문자 re-escape 후 재파싱 동일성.
- **`KeyValueGrid`** (RTL): 행 추가/삭제, **key rename**, draft→map 커밋(onBlur), dedupe, `commonKeys` 유무에 따른 피커 노출/비노출.
- **`BulkEditPanel`** (RTL): 열 때 현재 값 prepopulate, Apply = **전체 교체**(지운 줄 삭제), skip 힌트, Cancel 무효과.
- **피커** (RTL): 메뉴 insert + 값 시드, 기존 key 중복 시 값 갱신, datalist 일치 시 value 자동 시드.
- **회귀**: 기존 `Inspector` 헤더/폼 테스트가 새 컴포넌트로도 그린.

## 9. 구현 순서 (개략 — 상세는 plan에서)

1. `kvBulk.ts` 순수 함수 + 단위 테스트(TDD). 
2. `commonHeaders.ts` 데이터 + `findCommonHeader`.
3. `KeyValueGrid`(+ draft/커밋) + 테스트.
4. `BulkEditPanel` + 테스트.
5. 피커(메뉴 + datalist 시드) 배선 + 테스트.
6. `HeadersEditor`/`FormBodyField`를 `KeyValueGrid`로 교체, 기존 테스트 그린 확인.
7. `cd ui && pnpm test && pnpm build` 게이트.

함정 노트(새로 배운 것)는 `ui/CLAUDE.md`에 기록.
