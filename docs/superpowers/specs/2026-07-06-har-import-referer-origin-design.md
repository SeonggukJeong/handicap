# HAR 가져오기 — Referer/Origin 헤더 호스트 치환 (HAR import 정밀화, UI-only)

- **날짜**: 2026-07-06
- **상태**: 설계 승인(사용자 2026-07-06) → plan 대기
- **출처**: 사용자 요청(도그푸딩) — HAR 가져오기에서 스텝 URL은 `${BASE_URL}`로 치환되는데 `Referer`/`Origin` 헤더엔 캡처 원본 호스트가 그대로 남아 환경 전환(스테이징→부하대상)이 불완전하다.
- **연관**: HAR→시나리오 가져오기 슬라이스(`docs/build-log.md`), `ui/src/import/harToScenario.ts`(기존 R9/R12 hostVars), `hostEnv.ts`.
- **ADR**: 신규 불필요 — 기존 HAR import 기능의 additive 정밀화(아키텍처 결정 없음).

---

## 1. 문제와 목표

HAR 변환 시 `hostVars`(호스트→환경변수 매핑, 가져오기 화면 체크박스)가 켜져 있으면 스텝 URL의 origin만 `${VAR}`로 치환된다(`parameterizeUrl`). 그러나 브라우저 캡처 HAR엔 거의 항상 `Referer`/`Origin` 헤더가 있고, 이 값들엔 캡처 당시 호스트가 리터럴로 남는다 → 생성된 시나리오를 다른 환경(`BASE_URL` 변경)으로 돌리면 Referer/Origin만 옛 호스트를 가리켜 CORS/referer 검사하는 서버에서 캡처와 다른 동작이 난다.

- **목표**: `hostVars` 켜짐 시 fold를 살아남은 `Referer`/`Origin` 헤더 값도 자기 host 기준으로 `${VAR}` 치환.
- **비목표(연기)**: §7 참조. Host 헤더·범용 URL-값 헤더 치환은 안 한다.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST — `hostVars` 주어질 때, fold를 살아남은 이름 `referer`(대소문자 무시) 헤더 값은 `parameterizeUrl`과 동일 규칙으로 치환(origin→`${VAR}`, path·query·hash 보존: `https://api.example.com/mypage?tab=1` → `${BASE_URL}/mypage?tab=1`) | unit golden: 신규 describe "Referer/Origin 호스트 치환" | |
| R2 | MUST — 이름 `origin`(대소문자 무시) 헤더 값은 host가 매핑돼 있으면 **정확히 `${VAR}`**(trailing slash·path 없음) | unit: `Origin: https://api.example.com` → `${BASE_URL}` (not `${BASE_URL}/`) | |
| R3 | MUST — 치환은 **값 자체의 host** 기준(요청 URL host와 독립): 각 헤더가 자기 host의 var로 치환되고, 매핑에 없는 host는 불변 | unit: 요청=`api.example.com`(→BASE_URL)·Referer=`www.example.com`(→BASE_URL_2)·외부 referrer(`google.com`) 불변 | |
| R4 | MUST — URL로 파싱 불가한 값(`Origin: null`, 상대·깨진 URL)은 불변이며 throw하지 않는다 | unit: `Origin: null` 원문 유지·변환 전체 no-throw | |
| R5 | MUST — `hostVars` 미지정(off)이면 헤더 출력 byte-identical(기존 경로 무변화) | 기존 R4(헤더 모드)·R12(off) 테스트 green 유지 + 신규 off 단언 | |
| R6 | MUST — 헤더 **이름의 원본 케이싱은 보존**하고 값만 교체(소문자 `referer`/`origin`도 매칭) | unit: 소문자 이름 입력 → 키 그대로·값만 치환 | |
| R7 | MUST — 출력은 계속 와이어-형 YAML(`parseScenarioDoc` green + 와이어 리터럴 단언); 치환된 `${VAR}` 헤더 값은 엔진의 기존 헤더 렌더링 계약 안(신규 토큰 문법 없음) | 신규 golden이 와이어 리터럴(`Referer: ${BASE_URL}/...`) 단언 + `parseScenarioDoc` green | |

---

## 3. 핵심 통찰 (설계 근거)

1. **엔진 실측 — 헤더 값 `${ENV}`는 이미 지원 계약**: `crates/engine/src/executor.rs:137-140`이 URL과 헤더 값을 똑같이 `render(v, ctx)`(`{{var}}`/`${ENV}` 해석)로 통과시킨다. 즉 `${BASE_URL}`을 헤더 값에 emit해도 런타임 신규 표면이 없고, 미바인딩 시 실패 모드도 스텝 URL의 `${BASE_URL}`과 동일(UnknownVar fail-fast). 신규 토큰 문법이 아니므로 `resolveForDisplay` 동시 수정 규칙(ui/CLAUDE.md)도 비발동.
2. **Origin의 trailing-slash 함정**: `parameterizeUrl`을 Origin에 그대로 쓰면 `new URL("https://x.com").pathname === "/"` 정규화 때문에 `${VAR}/`가 된다 — Origin 스펙(`scheme://host[:port]`, RFC 6454)에 어긋나 CORS 검사 서버에서 캡처와 다른 동작 위험. 그래서 R2는 별도 분기로 bare `${VAR}`.
3. **접근 선택 — fold 후 후처리(A)**: `foldHeaders`(모드 필터링 전용)는 무변경으로 두고, 접힌 맵을 받는 순수 헬퍼로 치환. 기각: (B) `foldHeaders`에 hostVars 주입 — 필터링·재작성 관심사가 한 함수에 섞이고 이득 없음; (C) "URL로 파싱되는 모든 헤더 값" 범용 치환 — 의도치 않은 커스텀 헤더(`X-Callback-Url` 등)까지 건드릴 위험, 요청 범위(Referer/Origin) 밖 YAGNI.
4. **Referer 값 전체 교체(경로 버림)는 기각**(사용자 논의 2026-07-06): 경로 보존이 스텝 URL 치환 규칙과 일관하고 원본 트래픽에 충실. Referer 경로 검사 서버에서도 캡처와 동일 동작.

---

## 4. 변경 상세

### 4.1 `ui/src/import/harToScenario.ts` — 충족 R: R1–R6

신규 순수 함수(테스트용 export):

```ts
export function parameterizeRefHeaders(
  headers: Record<string, string>,
  hostVars?: Record<string, string>,
): Record<string, string>
```

- `hostVars` 없으면 입력 그대로 반환(R5).
- 각 엔트리: `lower = name.toLowerCase()`가
  - `"referer"` → `parameterizeUrl(value, hostVars)` 재사용(R1 — 미매핑·파싱불가는 그 함수가 이미 불변 반환, R3/R4 충족),
  - `"origin"` → `new URL(value)` 파싱 성공 && `hostVars[parsed.host]` 존재 시 `` `\${${varName}}` `` (R2), 실패·미매핑은 원문(R3/R4). **비정형 Origin(path/query 포함, RFC 6454 위반)도 파싱·매핑되면 bare `${VAR}`** — 비정형 잔여는 의도적으로 소실(스펙상 Origin엔 path가 없어야 하므로 정규화가 올바른 방향),
  - 그 외 이름 → 그대로.
- 키(이름)는 원본 케이싱으로 보존, 값만 교체(R6).

`wireStep`: `headers: parameterizeRefHeaders(foldHeaders(entry.request.headers, opts.headerMode), opts.hostVars)`.

### 4.2 `ui/src/import/__tests__/harToScenario.test.ts` — 충족 R: R1–R7

신규 `describe("Referer/Origin 호스트 치환")`: R1 경로 보존 golden(와이어 리터럴), R2 bare `${VAR}`(no slash), R3 멀티호스트 각자 매핑+외부 referrer 불변, R4 `Origin: null` 불변, R5 off byte-identical, R6 소문자 이름, R7 `parseScenarioDoc` green. 기존 테스트 무수정 green(R5의 절반).

---

## 5. 무변경 / 불변식 (명시)

- 엔진·컨트롤러·proto·migration·Zod 스키마(`model.ts`/`schemas.ts`)·store·서버 **0-diff** — 변경은 `ui/src/import/` 변환기 1파일 + 테스트뿐.
- `foldHeaders`·`parameterizeUrl`·`ConvertOptions` 시그니처 무변경.
- `hostVars` off(체크박스 미체크·`undefined`) 출력 byte-identical(R5).
- `ScenarioImportPage` UI 무변경 — 치환 결과는 기존 YAML 미리보기에 자연 반영, 새 문구·컨트롤 없음(ko.ts 무접촉).
- semantic-only 헤더 모드에선 Referer/Origin이 기존대로 fold에서 탈락 — 치환 로직과 상호작용 없음(all/strip-volatile에서만 실질 동작).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | unit golden: Referer 경로 보존(`${BASE_URL}/mypage?tab=1` 와이어 리터럴) | |
| R2 | unit: Origin → 정확히 `${BASE_URL}`(`${BASE_URL}/` 부정 단언은 whole-YAML이 아니라 **`parameterizeRefHeaders` 직접 단위 테스트**로 — 스텝 `url: ${BASE_URL}/...`이 같은 YAML에 있으면 전체-문자열 부정 단언이 false-fail) | |
| R3 | unit: 멀티호스트(BASE_URL/BASE_URL_2) + 외부 referrer 불변 | |
| R4 | unit: `Origin: null`·깨진 URL 불변, no-throw | |
| R5 | 기존 스위트 무수정 green + off byte-identical 단언 | |
| R6 | unit: 소문자 `referer`/`origin` 이름 케이싱 보존 | |
| R7 | 신규 golden 전부 `parseScenarioDoc` green + 와이어 리터럴 단언 | |

- **라이브 검증**: run-생성·응답-파싱·엔진 경로 무접촉(순수 클라이언트 변환기 + 결정적 golden unit)이라 **필수 아님**. 선택 스모크로 가져오기 화면에서 HAR 업로드→미리보기 YAML에 `Referer: ${BASE_URL}/...` 확인 가능(머지 전 판단은 plan에서).

---

## 7. 의도적 연기 (roadmap에 누적 안 함 — 재요청 시 재평가)

- **Host 헤더 치환**: 값이 host-only(scheme 없음)라 `${VAR}`(origin=scheme 포함)로 대체 불가 — 별도 `${VAR_HOST}` 변수를 새로 만들어야 해 범위 초과. strip-volatile 기본 모드에선 어차피 탈락.
- **범용 URL-값 헤더 치환(접근 C)**: 커스텀 헤더 오치환 위험, 실요청 없음(YAGNI).

---

## 8. 구현 순서 (plan 입력)

1. 단일 task: 테스트 먼저(RED — tdd-guard: `__tests__/` 파일 편집이 pending test를 만든다) → `parameterizeRefHeaders` 구현 + `wireStep` 배선(GREEN) → `pnpm lint && pnpm test && pnpm build` → green 단일 커밋.
