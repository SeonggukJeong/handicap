# HAR → 시나리오 가져오기 — 캡처한 HTTP 트래픽을 STEP으로 변환하는 클라이언트 변환기 (캡처 보조 1차)

> 이 슬라이스는 사용자의 "스마트폰 트래픽을 캡처해 STEP으로 자동 전환" 비전의 **1단계**다. 라이브 캡처(MITM 프록시·녹화/정지)는 별도의 미래 슬라이스이고, 이번엔 **이미 캡처된 HAR을 handicap 시나리오 YAML로 변환**하는 코어 + UI만 만든다.

- **날짜**: 2026-06-15
- **상태**: 설계 초안 → plan 대기
- **출처**: 사용자 요청(2026-06-15, `/start-slice`). **왜 지금**: 초보자가 실제 앱 트래픽으로 시나리오를 빠르게 시작하게 하는 진입장벽 완화 — 변환 코어(요청→STEP·필터)는 미래 라이브 캡처 앱과 공유되는 재사용 자산이라 먼저 검증한다.
- **연관**: `ui/src/scenario/model.ts`(시나리오 Zod 모델), `ui/src/scenario/yamlDoc.ts`(`parseScenarioDoc`·wire↔model 정규화), `ui/src/scenario/ulid.ts`(`newStepId`), `ui/src/scenario/store.ts`(`loadFromString`), `ui/src/routes.tsx`(라우트 테이블), `ui/src/pages/ScenarioNewPage.tsx`(에디터 시드 패턴), ADR-0003/0013/0015(양방향 sync·시나리오 모델).
- **ADR**: **신규 불필요** — additive UI 도구이고 기존 시나리오-YAML 계약(ADR-0003/0013/0015) 범위 내(엔진·proto·migration·백엔드 라우트 0). "가져오기/캡처를 별도 관심사로 단계적 도입(1차 HAR import 인앱 → 2차 라이브 프록시는 별도 앱)"이라는 방향은 **roadmap에 기록**(미래 라이브 슬라이스 착수 시 그 큰 결정이 자체 ADR 후보).

---

## 1. 문제와 목표

초보 QA가 실제 앱/웹 트래픽에서 시나리오를 만들려면 지금은 요청을 손으로 한 스텝씩 옮겨 적어야 한다. 이 슬라이스는 **이미 캡처된 HAR 파일을 handicap 시나리오 YAML로 변환**하는 클라이언트-온리 변환기(`/scenarios/import` 라우트)를 추가한다. 사용자는 외부 캡처 도구(HTTP Toolkit·브라우저 DevTools 등)로 HAR을 만들고, 이 페이지에서 필터·옵션을 적용해 변환한 뒤 **복사**하거나 **편집기로 바로 보낸다**.

- **목표**: HAR `log.entries[]` → 캡처 순서의 와이어-형 step 목록 → 유효한 시나리오 YAML(필터·헤더처리·이름·옵션 적용) → 복사 / 편집기 시드.
- **HTTPS 타당성 경계**(사용자 확정): 대상은 **자체 앱(통제 빌드)** 과 **모바일 웹/웹뷰**만 — cert-pinning을 회피할 수 있는 경우. 임의 서드파티 프로덕션 앱은 비대상.
- **비목표(연기)**: §7 참조. 라이브 캡처/프록시 · 자동 그룹핑 · env 추출 · dedup · 비-HAR 포맷.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법) | seam? |
|---|---|---|---|
| R1 | MUST 순수 변환 함수가 파싱된 HAR을 **캡처 순서**의 step 목록으로 변환한다 — 각 step은 `newStepId()` id, `name="{METHOD} {pathname}"`(`new URL(url).pathname`, 파싱 실패 시 url 원문 폴백), `request.method`/`request.url`(쿼리스트링 포함 풀 URL 원문). 한 entry의 실패가 배치를 중단하지 않는다. | `harToScenarioYaml` 골든 HAR fixture 단위테스트(`src/import/__tests__/`); 상대/garbage URL entry 폴백 테스트 | |
| R2 | MUST 변환기는 **와이어-형(wire) YAML**을 emit한다 — `body: {json\|form\|raw: value}` · `assert: [{status: code}]`(에디터·엔진이 쓰는 형식). in-memory Zod 모델-형(`{kind,value}`/`{kind,code}`)을 **emit하지 않는다**(엔진 `Request`=`deny_unknown_fields`라 모델-형 키 거부). 출력은 `parseScenarioDoc`로 유효 모델로 파싱된다. | **골든 와이어-YAML 리터럴 단언**(출력에 `body:`→`json:`/`form:`/`raw:`, `assert:`→`- status:` 구조가 실재) **그리고** `parseScenarioDoc(yaml)`가 `{model}`(에러 없음) 반환. ⚠ `ScenarioModel.parse`/`parseScenarioDoc` 단독은 모델-형도 통과시켜 **false-green** → 와이어 구조를 리터럴로 확인 필수 | ✅ wire: 변환기 출력 ↔ handicap **와이어** 시나리오 계약(엔진 serde / `parseScenarioDoc`) |
| R3 | MUST body 매핑 — JSON(파싱 가능 + `jsonBodyCastErrors` 빈 경우) → `{json: value}`; JSON이지만 `jsonBodyCastErrors`가 비-빈(미지원 cast keyword `{{x:int}}`·env-cast `${X:num}`·혼합 `v={{x:num}}` — 단, 표준 `{{x:num}}`/`{{x:str}}`/`{{x:bool}}` 단독값은 **유효**라 안 걸림) → **`{raw: text}` 폴백**; form-urlencoded → `{form: record}`(record는 `postData.params[]` 우선, 없고 mimeType이 form이면 `postData.text`를 쿼리스트링 파싱); 그 외 → `{raw: text}`; `postData` 없으면 body 생략. | 6분기(json / json-cast-literal(`{{x:int}}`)→raw / form-params / form-text / raw / none) 단위테스트 + 출력 `parseScenarioDoc` 통과 | |
| R4 | MUST HAR `request.headers`(배열 `{name,value}`)를 wire **map**으로 폴드(중복 키 last-wins) 후 헤더 처리 모드를 **사용자가 선택** 적용: `전부 유지`(기본) / `자동·휘발성 제거`(host·content-length·connection·accept-encoding) / `의미 헤더만`(content-type·authorization·accept·`X-*` 유지, 나머지 제거). **HTTP/2 의사헤더(`:`로 시작, 예 `:authority`)는 모든 모드에서 제거**(전송 불가 transport 아티팩트). | 모드별 변환 단위테스트(배열→map 폴드·dup last-wins·전모드 `:`-제거 포함) + 페이지 셀렉터 RTL | |
| R5 | MUST 필터 — (a) 정적 리소스 제외 토글(기본 ON; 확장자 + 응답 content-type), (b) 호스트 포함/제외, (c) 요청별 포함/제외. **선택된 요청만 캡처 순서로** emit. | 필터 함수 단위테스트(각 축) + 페이지 RTL(체크박스 토글→미리보기 변화) | |
| R6 | SHOULD status assertion 옵션 — ON이면 각 step에 `assert: [{status: <캡처 응답 status>}]`, OFF(기본)이면 `assert: []`. | on/off 양쪽 단위테스트(와이어-형 `status:` 확인) | |
| R7 | MUST 시나리오 이름은 HAR `log.pages[].title` 또는 첫 채택 요청 호스트에서 유추해 **입력칸에 프리필**(폴백 `"Imported scenario"`)하고 사용자가 편집할 수 있다. | 유추+폴백 단위테스트 + 페이지 입력칸 RTL | |
| R8 | MUST 새 라우트 `/scenarios/import`가 변환 페이지를 렌더하고, 시나리오 목록 페이지(`ScenarioListPage`, index 라우트)에 "가져오기" 진입 버튼이 있다. | RTL: 라우트 렌더 + 목록 버튼이 `/scenarios/import`로 navigate | ✅ wire: `ui/src/routes.tsx` 라우트 테이블 |
| R9 | MUST "편집기로 보내기"가 변환 YAML을 **라우터 state**(`{importedYaml}`)로 `/scenarios/new`에 navigate하고, `ScenarioNewPage`가 mount 시 **ref-가드 effect**에서 `location.state.importedYaml`이 있으면 기존 `chooseTemplate` 경로(`loadFromString` 선적재 + canonical을 yamlText/originalYaml에)를 **1회** 호출해 갤러리를 건너뛰고 에디터를 시드한다 — **render-phase 부작용/lazy-init 금지(StrictMode 안전)**. | RTL: 버튼 클릭 → `/scenarios/new`가 그 YAML 로드; **그리고** state 부재 시 기존 ScenarioNewPage 갤러리 RTL 테스트 unchanged(회귀 가드) | ✅ wire: `ScenarioNewPage` 시드 분기(인앱 핸드오프) |
| R10 | MUST "복사" 버튼이 변환 YAML을 클립보드에 복사한다. | RTL clipboard 테스트(`userEvent.setup()` *뒤* 모킹 — C-2 함정) | |
| R11 | MUST 잘못된/빈 HAR(JSON 파싱 실패 · `entries` 0개)은 명확한 에러 메시지로 처리되고, 개별 entry의 URL 파싱 실패도 배치를 크래시시키지 않는다(폴백). | 단위(깨진 JSON·빈 entries·상대 URL → Result/폴백) + RTL(`role="alert"`) | |
| R12 | SHOULD 변환·페이지는 외부 네트워크 호출이 **0**이다(순수 클라이언트 HAR 파싱) — CSP `default-src 'self'` 정합. | 코드리뷰 + 변환 단위테스트에 네트워크 모킹 불요(관찰) | |

- **`seam?` 요약**: R2(계약 — 변환기 출력↔**와이어** 시나리오 형식)·R8(`routes.tsx`)·R9(인앱 핸드오프 — `ScenarioNewPage` 시드). R2가 핵심이자 가장 흘리기 쉬운 불변식: **emit은 와이어-형이어야** 하고(엔진 `deny_unknown_fields`), 파싱 성공만으론 모델-형 false-green이 잡히지 않으므로 골든 와이어 구조를 리터럴로 검증한다.

---

## 3. 핵심 통찰 (설계 근거)

1. **재사용되는 진짜 씨앗은 "변환 모듈"이지 페이지가 아니다.** `harToScenarioYaml`(순수 함수)는 미래 라이브 캡처 앱에도 그대로 쓰일 자산이고, 페이지 UI 껍데기(파일 드롭·필터)는 라이브 앱에선 완전히 다를 것이다. 그래서 R1(변환 모듈)과 R2(계약)·R8/R9(페이지·라우팅)를 분리하고, 변환 모듈을 가장 먼저 독립 커밋한다(§8-1). 이 분리 덕에 "변환기를 인앱 라우트로 둘지/별도 페이지로 둘지"는 미래에 영향이 없다 — 결국 in-app 라우트(`/scenarios/import`)를 택했다(편집기로의 매끄러운 핸드오프).
2. **계약 경계는 scenario-YAML(와이어 형식) 하나뿐.** 변환기는 handicap과 오직 시나리오 YAML로 통신한다. 그 YAML은 **에디터/엔진이 쓰는 와이어 형식**이어야 한다 — `body: {json|form|raw: value}`·`assert: [{status: code}]`이지, in-memory Zod 모델 형식(`body:{kind,value}`/`assert:[{kind,code}]`)이 아니다. 근거: 엔진 `Request`는 `#[serde(deny_unknown_fields)]`(`crates/engine/src/scenario.rs`), `Body`는 `{json|form|raw}` 수동 serde, 에디터 `Inspector.tsx`가 Doc에 `{json: …}`를 쓰고 `yamlDoc.ts::normalizeBody`/`normalizeAssertion`은 **wire→model** 단방향이다. **함정**: `parseScenarioDoc`/`ScenarioModel.parse`는 정규화기가 모델-형도 그대로 통과시켜 **양 형식을 다 받는다** → 파싱 성공만으론 와이어-정확성을 증명 못 한다(false-green). 그래서 R2는 와이어 구조를 **리터럴 골든**으로 확인한다. 기존 `newStepId`/`yaml`/`parseScenarioDoc`를 재사용하므로 새 백엔드·proto·migration이 전부 0(§5). 가져오기/캡처를 *별도 관심사*로 단계적 도입(1차 import 인앱 → 2차 라이브 프록시 별도 앱)하는 방향은 roadmap에 기록(ADR는 미래 라이브 슬라이스의 큰 결정 몫).
3. **편집기 핸드오프는 라우터 state + ref-가드 effect로 — 새 메커니즘 0.** sessionStorage/URL이 아니라 인앱 `navigate("/scenarios/new", {state:{importedYaml}})`로 YAML을 넘긴다(전체 reload 없음). `ScenarioNewPage`는 이미 `chooseTemplate`에서 **`loadFromString` 선적재 + canonical을 yamlText/originalYaml에 선험 시드**하는 패턴을 쓴다(EditorShell 첫-onChange가 pre-load 잔존물을 흘리는 함정 회피, `ui/CLAUDE.md`). import 시드는 mount 시 **ref-가드 effect가 그 `chooseTemplate`을 importedYaml로 1회 호출**하는 것일 뿐이다(갤러리 게이트 `seedYaml===null`이 editor mount를 store 적재 *뒤로* 미루므로 첫-onChange 함정 회피). `chooseTemplate`은 click 핸들러라 render-phase 밖에서 도는데, effect도 render-phase 밖이라 같은 안전성을 갖는다 — **lazy-`useState` initializer에 `loadFromString` 부작용을 넣는 것은 금지**(StrictMode 이중호출 + render-부작용 위반).
4. **HTTPS 캡처 타당성을 import로 우회.** HTTPS 복호화는 단말 CA 설치 + 앱의 CA 신뢰가 필요하고(서드파티 프로덕션 앱은 pinning으로 막힘), 대상을 자체 앱(통제 빌드)·모바일 웹/웹뷰로 한정했다(§1). 캡처 자체는 성숙한 외부 도구(HTTP Toolkit 등)에 맡기고 그 HAR을 입력으로 받으므로 MITM 스택을 재발명하지 않는다 — 라이브 프록시는 그래서 별도 미래 슬라이스(§7).

---

## 4. 변경 상세

> 전부 `ui/` 안. 엔진/컨트롤러/워커/proto/migration·신규 백엔드 라우트 **0**(§5).

### 4.1 `ui/src/import/harToScenario.ts` (신규, 순수) — 충족 R: R1, R2, R3, R6, R7, R11, R12
- `parseHar(text): Har` — JSON 파싱 + 최소 형태 검증(`log.entries` 배열). 실패 시 명확한 에러(throw 또는 `{ok:false,error}`) (R11).
- `harEntryToWireStep(entry, opts): object` — **와이어-형 step 객체** 생성: `{ id: newStepId(), name, type:"http", request:{ method, url, headers, body? }, assert, extract:[] }`. body=`{json|form|raw: …}`(R3), assert=`[{status: code}]`(R6 on) 또는 `[]`. **모델-형 키(`kind`/`value`/`code`) 금지.** name=`try { new URL(url).pathname } catch { url }`로 `{METHOD} {path}`(R1).
- **headers 폴드(R4)**: HAR `request.headers`는 배열 `[{name,value}]` → wire **map**으로 접는다(중복 키 **last-wins**). `name.startsWith(":")`(HTTP/2 의사헤더)는 **모든 모드에서 제거**. 그 후 모드별 denylist/allowlist 적용.
- **form record(R3)**: `postData.params[]`가 있으면 그것을 `{name:value}` map으로(dup last-wins), 없고 `mimeType`이 `application/x-www-form-urlencoded`면 `postData.text`를 `URLSearchParams`로 파싱.
- `harToScenarioYaml(har, opts): string` — 필터(R5)된 entries를 캡처 순서로 매핑 + name(R7) + `{ version:1, name, cookie_jar:"auto", variables:{}, steps }` → `yaml` 패키지로 직렬화(`stringify` 또는 와이어-형 `Document`). 출력은 `parseScenarioDoc`로 유효 모델로 파싱되고, 골든 테스트가 와이어 구조(`json:`/`status:`)를 리터럴 확인(R2).
- 헤더 denylist(R4 모드)·정적 확장자/콘텐츠타입 집합(R5)은 이 모듈의 명명 상수로(테스트가 락인).

### 4.2 `ui/src/import/filters.ts` (신규 또는 4.1 내) — 충족 R: R5, R7
- `defaultStaticExcluded(entry): boolean`(확장자 + 응답 content-type), 호스트 집합 도출(필터 R5 **및** 이름 유추 R7의 "첫 채택 요청 호스트"가 공유), per-entry 선택 상태. 페이지가 이 순수 함수로 미리보기 목록을 도출.

### 4.3 `ui/src/pages/ScenarioImportPage.tsx` (신규) — 충족 R: R4, R5, R6, R7, R8, R9, R10, R11
- 파일 드롭/선택 → `parseHar` → 필터 UI(정적 제외 토글·호스트 체크박스·요청별 체크박스, R5) + 옵션 패널(헤더 모드 R4·status assert 체크박스 R6·이름 입력 R7) → `harToScenarioYaml` → 읽기전용 미리보기 + **복사**(R10) + **편집기로 보내기**(R9 — `navigate("/scenarios/new",{state:{importedYaml}})`).
- 파싱/변환 실패는 `role="alert"`(R11).

### 4.4 `ui/src/routes.tsx` — 충족 R: R8
- `createBrowserRouter` children 배열에 `{ path: "scenarios/import", element: <ScenarioImportPage /> }` 추가 + `import { ScenarioImportPage }`. (라우터는 App.tsx가 아니라 **routes.tsx**에 있다.)

### 4.5 `ui/src/pages/ScenarioListPage.tsx` — 충족 R: R8
- "가져오기" 버튼/`<Link to="/scenarios/import">`. 기존 "새 시나리오" 진입과 나란히.

### 4.6 `ui/src/pages/ScenarioNewPage.tsx` — 충족 R: R9 (seam)
- mount 시 **ref-가드 effect**: `useLocation().state?.importedYaml`이 있으면 `chooseTemplate(importedYaml)`을 1회 호출(`didImportSeed` ref로 StrictMode 이중-effect 가드). 갤러리 게이트(`seedYaml===null`)가 editor mount를 store 적재 뒤로 미룬다. **render-phase / `useState` lazy-init에 `loadFromString`를 넣지 않는다.** `location.state` 부재 시 기존 갤러리 흐름과 **byte-identical**(§5).
- `ko.ts`(ADR-0035) — "가져오기"/"편집기로 보내기"/"복사"/이름·옵션 라벨·에러 문구를 카탈로그에.

---

## 5. 무변경 / 불변식 (명시)

- **엔진·컨트롤러·워커·proto·migration·신규 백엔드 라우트: 전부 무변경.** 순수 클라이언트 기능.
- **변환기는 와이어-형 YAML만 emit** — `body:{json|form|raw}`·`assert:[{status}]`. 모델-형(`{kind,value}`/`{kind,code}`) 금지. 엔진 `Request` `deny_unknown_fields`/`Body` 수동 serde와 1:1(R2).
- **시나리오 모델 fork 없음** — `newStepId`/`yaml`/`parseScenarioDoc`를 재사용. 변환기가 자체 모델/직렬화기를 만들지 않는다.
- **`ScenarioNewPage` import-시드 분기는 additive** — `location.state.importedYaml` 부재 시 기존 템플릿 갤러리 흐름과 **byte-identical**(기존 ScenarioNewPage RTL 테스트 그대로 통과 = 회귀 가드, R9).
- **기존 라우트·페이지 동작 무변경** — `/scenarios/import` 라우트와 목록 버튼만 추가.

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | 골든 HAR fixture → 기대 step(id ULID 정규식·순서); 상대/garbage URL entry 폴백 | |
| R2 | **골든 와이어-YAML 리터럴 단언**(`body:`→`json:`/`assert:`→`- status:`) + `parseScenarioDoc`→유효 모델(에러 0). 파싱만으론 false-green이라 둘 다 | |
| R3 | json / json-cast-literal→raw / form-params / form-text / raw / none 6분기 + `parseScenarioDoc` 통과 | |
| R4 | 3모드 각각 헤더 집합 단언 | |
| R5 | 정적 제외·호스트·요청별 필터 함수 단위 + 페이지 토글 RTL | |
| R6 | assert on(`status:` 실재)/off(`[]`) 단위 | |
| R7 | page title / host / 폴백 유추 단위 + 입력칸 RTL | |
| R8 | `ScenarioImportPage` 라우트 렌더 RTL + 목록 버튼 navigate | |
| R9 | RTL: "편집기로 보내기" → `/scenarios/new`가 importedYaml 로드 + **state 없을 때 기존 갤러리 RTL unchanged(회귀)** | |
| R10 | clipboard writeText 호출 단언(setup 뒤 모킹) | |
| R11 | 깨진 JSON·빈 entries·상대 URL → 에러/폴백 | |
| R12 | 변환 경로 네트워크 호출 0(관찰) | |

- **라이브 검증 불요**(production diff가 `ui/`-only, run-생성/리포트-파싱/엔진 경로 무변경). R2의 "출력이 와이어-정확 + 실제 에디터 로더 통과"를 골든 와이어-YAML + `parseScenarioDoc` 단위테스트로 닫으므로 S-D 갭(서버 응답경로)과 무관. 머지 전 **전체 `pnpm test`**(인자 없는) 1회로 다른 파일 회귀(ScenarioNewPage 등) 확인(ui/CLAUDE.md S-D 함정).

---

## 7. 의도적 연기 (roadmap에 누적)

- **라이브 캡처/프록시(MITM 녹화·정지)**: handicap 내장 또는 별도 앱이 폰 트래픽을 실시간 캡처 → STEP 누적. 프록시·CA 관리·라이브 스트리밍이 살집 → **roadmap의 별도 미래 라이브 슬라이스**(그 큰 결정이 ADR 후보). 변환 모듈은 그때 재사용.
- **자동 loop/조건/parallel 그룹핑**: 변환은 평탄한 step 목록만 만든다. 그룹핑은 사용자가 handicap 에디터에서 수동(기존 기능).
- **env/`${BASE_URL}` 추출·자동 파라미터화**: 공통 호스트→`${BASE_URL}`·반복 토큰→`{{var}}` 자동화는 후속.
- **중복 요청 dedup / 연속 접기**.
- **비-HAR 포맷 import**(curl·Postman·OpenAPI).
- **응답 본문 기반 extract 자동 생성**.

---

## 8. 구현 순서 (plan 입력)

> UI-only. pre-commit은 `ui/`(non-`.md`) staged면 **UI 게이트**(`pnpm lint && pnpm test && pnpm build`) 실행, cargo는 skip(non-cargo 커밋). TDD-guard: `ui/src/*` 편집 전 pending 테스트 파일 필요 → 각 task는 테스트 먼저. 각 task **단일 green 커밋**.

1. **변환 코어** — `src/import/harToScenario.ts`(+`filters.ts`) + `src/import/__tests__/harToScenario.test.ts`(골든 HAR fixture + **골든 와이어-YAML 단언** body `json:`/assert `- status:` 구조 + `parseScenarioDoc` 통과). R1·R2·R3·R4·R6·R7·R11·R12. (테스트 먼저 → green.)
2. **변환 페이지** — `ScenarioImportPage.tsx` + `pages/__tests__/ScenarioImportPage.test.tsx`(드롭·필터·옵션·이름·미리보기·복사·에러). R4(UI)·R5·R6(UI)·R7(UI)·R10·R11(UI). `ko.ts` 문구.
3. **라우트·진입·핸드오프** — `routes.tsx` 라우트(R8) + ScenarioListPage 버튼(R8) + ScenarioNewPage ref-가드 import-시드 effect(R9) + "편집기로 보내기" + RTL. **ScenarioNewPage 회귀(state 부재 시 갤러리) 테스트 포함**(R9 회귀 가드).
