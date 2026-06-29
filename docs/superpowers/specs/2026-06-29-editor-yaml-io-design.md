# 시나리오 에디터 YAML 파일 가져오기/내보내기 (file-I/O)

- 날짜: 2026-06-29
- 상태: 설계 (구현 전)
- 영역: B13 에디터 흐름 재설계 후속 (ADR-0044 fast-follow)
- 출처: 사용자 요청(2026-06-28, roadmap §B13 "YAML 가져오기/내보내기 — fast-follow")

## 1. 배경·동기

ADR-0044(에디터 1차 표현 캔버스→아웃라인)의 슬라이스 1에서 YAML 양방향 모달(`MonacoYamlView`)이 들어왔고, 핵심 *공유→붙여넣기*는 Monaco 내장 복사/붙여넣기(클립보드)로 이미 충족된다. roadmap §B13은 **파일 I/O**(시나리오를 `.yaml` 파일로 내려받기 / 파일을 업로드해 에디터에 로드)를 "우선순위 높은 빠른 후속"으로 명시했다. 파일 I/O는 직교적 footgun 표면(`FileReader`·`showSaveFilePicker`·`picker.call(window,…)` 바운드 호출·blob revoke 타이밍 — 전부 `ui/CLAUDE.md` 함정)이라 슬라이스 1에서 분리해 둔 항목이다.

이 슬라이스는 그 파일 I/O 두 동작(내보내기·가져오기)을 추가한다.

## 2. 목표 / 비목표

### 목표
- 현재 에디터의 시나리오를 `.yaml` 파일로 **내보내기**(다운로드).
- `.yaml` 파일을 **가져오기**(업로드)해 에디터에 로드.
- 두 동작 모두 두 페이지(`/scenarios/new`, `/scenarios/:id`)에서 동작.

### 비목표 (YAGNI)
- 별도 가져오기 *페이지*·페이지 헤더 진입점 (HAR 가져오기는 별도 페이지로 이미 존재 — 그와 별개).
- 병합/append(가져오기는 **대체**다).
- 다중 파일·드래그앤드롭 업로드.
- 모델/스키마/와이어/엔진 변경.
- `ScenarioImportPage`의 자체 `readText` 리팩터(슬라이스 타이트 유지 — 향후 dedupe 가능).
- 디자인 시스템 토큰 이주(에디터는 raw Tailwind, roadmap §B12 별도 슬라이스 — 이 슬라이스는 인접 EditorShell 툴바 버튼 스타일을 그대로 따른다).

## 3. 결정 (사용자 확정)

1. **배치 = YAML 편집 모달 안.** 두 버튼은 YAML 모달 내부 툴바 행에 둔다(렌더 *위치*는 모달, 편집하는 *파일*은 모달의 내용 컴포넌트 `MonacoYamlView.tsx` — §4.1). 근거: ① YAML 모달(`EditorShell.tsx:79-83`)은 두 페이지가 공유하는 `EditorShell`에 있어 자동으로 양쪽 적용·byte-identical, ② "YAML"이라는 주제로 한 곳에 응집(모달을 보고 있으면 "무엇을" 내보내고 가져오는지 자명 — 헤더의 맥락 없는 버튼보다 혼란이 적다), ③ 가져오기 결과가 모달 Monaco에 즉시 보이고 기존 검증(`yamlError`/ValidationBanner)이 그대로 작동(무료 리뷰·검증 단계). 발견성 비용(가져오기 시 모달 먼저 열기, 클릭 1회)은 대상(개발자, ADR-0003)·목적상 수용.
2. **가져오기 대체 확인 = 내용 있을 때만.** "내용 있음"은 `hasContent = (model?.steps?.length ?? 0) > 0 || yamlError !== null` — 즉 ⓐ 유효 모델에 스텝이 있거나, ⓑ 현재 버퍼가 파싱 불가(invalid WIP — `model`은 null이지만 사용자가 작성 중인 텍스트가 있음)면 `window.confirm`으로 대체 확인. 빈 스타터(유효·스텝 0)면 확인 없이 바로 로드. **invalid 버퍼를 포함하는 이유**(reviewer Contradiction B): `model`은 YAML이 invalid면 null이라 `steps` 기반 단독 검사로는 invalid WIP가 무확인 대체돼 작업이 조용히 사라진다 — `yamlError !== null`을 더해 닫는다(방향 안전: 확인이 더 뜰지언정 덜 뜨지 않음). `window.confirm`은 코드베이스 전역 선례(`RunDialog`/`TemplatesPage`/`ScenarioNewPage`의 `discardConfirm` 등)이고, 모달-안-모달 ESC 레이어링 함정(`ui/CLAUDE.md` HelpTip 항목)을 피한다.
3. **가져오기 검증 = lenient.** 가져오기는 기존 `loadFromString(content)`(store 단일 대량 로드 진입점)을 그대로 재사용한다. 파싱 불가 파일도 텍스트로 로드되고 `yamlError`로 표면화(사용자가 Monaco에서 수정) — 별도 가져오기-검증 경로를 만들지 않는다.
4. **내보내기 내용 = 현재 보이는 텍스트, 파일명도 그 텍스트에서 도출.** 내보내는 바이트는 `pendingYamlText ?? yamlText`(`MonacoYamlView.tsx:61`의 `visibleText`와 동일) — 모달 안 미커밋 편집까지 "보이는 그대로". YAML이 invalid여도 내보내기 허용(WIP 버퍼 저장). **파일명은 `model?.name`이 아니라 *내보내는 바로 그 텍스트*를 `parseScenarioDoc`로 파싱해 도출**(reviewer Ambiguity A): `model`은 커밋 시에만(그리고 유효할 때만) 갱신돼 디바운스 윈도/ invalid 버퍼에서 파일명이 내용과 어긋날 수 있다 → 내보낼 바이트에서 직접 이름을 뽑으면 파일명이 항상 내용과 일치(파싱 실패=invalid면 `scenario.yaml` 폴백, 이는 올바름 — invalid WIP엔 정규 이름이 없다). 파싱은 비파괴적(store 무변경)·내보내기 클릭당 1회라 비용 무시.
5. **다운로드 헬퍼 재사용.** `api/downloadJson.ts`의 picker/blob/revoke 패턴을 일반화해 재사용(아래 §6.4) — picker 바운드 호출·1s 지연 revoke 함정을 한 곳에 유지.

## 4. 아키텍처·컴포넌트

### 4.1 새 컴포넌트 `YamlFileActions` (`ui/src/components/scenario/YamlFileActions.tsx`)
YAML 모달 surface의 툴바 행. `MonacoYamlView`의 flex 컬럼 **첫 자식**(에디터 위)으로 렌더해 YAML surface를 자족적으로 유지하고, 공유 모달을 통해 두 페이지가 자동으로 얻는다. 포함:
- **"파일에서 열기"** 버튼 → 숨은 `<input type="file" accept=".yaml,.yml">`(ref) 클릭.
- **"파일로 저장"** 버튼 → 내보내기.
- 파일 *읽기* 오류용 `role="alert"` 행(드묾; 기존 YAML *파싱* 오류 행과 별개).

**함정(reviewer 지적): 숨은 file input은 Modal 포커스 트랩의 Tab 정지점이 되면 안 된다.** `Modal.tsx:38-49`의 포커스 트랩은 가시성 무관하게 `input`을 querySelectorAll로 잡아, 숨은 input이 마지막 Tab 정지점이 돼 Tab-wrap을 깬다 → 숨은 input에 `tabIndex={-1}` + `aria-hidden="true"`를 준다(트리거는 보이는 버튼이라 키보드 접근 유지).

버튼 시각 스타일은 인접 `EditorShell` 툴바 버튼(변수/YAML 토글, raw Tailwind `rounded border border-slate-300 px-2 py-1 text-sm`)과 동일하게 맞춘다.

### 4.2 새 유틸 `readTextFile` (`ui/src/api/readTextFile.ts`)
`FileReader.readAsText`를 Promise로 감싼 헬퍼(`ScenarioImportPage.readText`와 동형 — jsdom·브라우저 양쪽 동작). 새 코드에서 사용.

### 4.3 다운로드 헬퍼 일반화 (`ui/src/api/downloadJson.ts`)
- `saveViaPicker(filename, text, types)` / `saveViaBlobUrl(filename, text, mime)`로 시그니처 일반화(현재 JSON 하드코딩 → 인자화).
- `downloadText(filename, text, mime, types)` 공개 — picker 우선 + blob 폴백.
- `downloadJson(filename, data)`은 `downloadText`를 JSON mime/types로 호출하는 래퍼로 축소(**행동 byte-identical**: 같은 `application/json` mime·같은 picker types·같은 blob 경로·같은 1s 지연 revoke).
- `downloadYaml(filename, text)` 추가: `downloadText(filename, text, "application/yaml", [{description:"YAML", accept:{"application/yaml":[".yaml",".yml"]}}])`.

### 4.4 새 순수 함수 `sanitizeFilename` (`ui/src/api/sanitizeFilename.ts`)
파일명 후보(시나리오 이름)를 파일시스템·picker `suggestedName` 안전 문자열로 정규화하는 **독립 순수 함수**(자체 모듈 → 직접 단위 테스트 용이). 시그니처 `sanitizeFilename(name: string | undefined | null): string`. 동작:
- **nullish 입력(`undefined`/`null`) 안전 처리 → `""` 반환**(reviewer 잔여 지적): invalid 버퍼 내보내기 경로(§3.4 지원 기능)가 `name = undefined`를 넘기므로, 함수가 `name.replace(...)`로 throw하면 안 된다 — 진입에서 nullish면 즉시 `""`.
- 예약/위험 문자 `/ \ : * ? " < > |` 와 제어문자(`\x00-\x1f`) 제거.
- 앞뒤 공백 트림.
- 결과 문자열 반환(빈 문자열일 수 있음 — 폴백은 호출부가 `sanitizeFilename(name) || "scenario"`로 처리).

호출부(§5.1)는 `${sanitizeFilename(name) || "scenario"}.yaml`로 최종 파일명을 만든다. `picker.suggestedName`이 경로 구분자에 throw하므로 정규화는 scope creep이 아니라 필수.

## 5. 데이터 흐름

### 5.1 내보내기
1. store에서 보이는 텍스트 읽기: `text = pendingYamlText ?? yamlText`.
2. 파일명 도출(§3.4): 내보낼 그 `text`를 `parseScenarioDoc(text)`로 파싱 → `"model" in parsed ? parsed.model.name : undefined`로 이름을 얻고, `${sanitizeFilename(name) || "scenario"}.yaml`(§4.4). 파싱 실패(invalid) 또는 이름 정규화 후 빈 문자열이면 `scenario.yaml`. (`model?.name` 직접 사용 금지 — 디바운스/invalid 윈도에서 내용과 어긋남.)
3. `downloadYaml(filename, text)` 호출 → `saveViaPicker`(File System Access API, `picker.call(window, …)`) → 실패/미지원 시 `saveViaBlobUrl`(anchor click + 1s 지연 `revokeObjectURL`).

### 5.2 가져오기
1. 파일 선택 → `readTextFile(file)`로 텍스트 읽기.
2. **입력 value 리셋**(`e.target.value = ""`) — 같은 파일 재선택 시 `onChange` 재발화.
3. 대체 확인: `hasContent`(§3.2 = `(model?.steps?.length ?? 0) > 0 || yamlError !== null`)이면 `window.confirm(ko.editor.importReplaceConfirm)`; 취소면 중단(no-op). 빈 스타터(유효·스텝 0)면 확인 생략.
4. 진행: `loadFromString(content)` — 모델+텍스트를 한 번에 교체. lenient(§3.3): invalid면 텍스트로 로드 + `yamlError` 표면화.
5. `FileReader` 오류: 로컬 오류 state → `role="alert"` 메시지.

## 6. 오류 처리

- **파일 읽기 실패**(`FileReader.onerror`): `role="alert"` 메시지(`ko.editor.importReadError(msg)`). 모델 변경 없음.
- **invalid YAML 가져오기**: `loadFromString`이 lenient 처리 — 텍스트 로드 + `yamlError`(기존 경로). 별도 처리 없음.
- **내보내기 picker 취소**(`AbortError`): `saveViaPicker`가 true 반환(처리됨) → blob 폴백 안 탐(기존 `downloadJson` 행동 유지).
- **내보내기 picker 미지원/throw**: blob 폴백.

## 7. 문구 (`ui/src/i18n/ko.ts`, ADR-0035)

새 `editor` 키:
- `importYaml: "파일에서 열기"`
- `importYamlAria: "YAML 파일을 선택해 시나리오를 불러옵니다"`
- `exportYaml: "파일로 저장"`
- `exportYamlAria: "현재 시나리오를 YAML 파일로 저장합니다"`
- `importReplaceConfirm: "현재 내용을 가져온 파일로 대체합니다. 계속할까요?"`
- `importReadError: (msg: string) => \`파일을 읽지 못했습니다: ${msg}\``

aria-label도 사용자 노출 문구라 ko 경유(ADR-0035).

## 8. 테스트 전략

### 8.1 단위 (vitest, `__tests__/`)
- `downloadJson.test.ts`: 기존 케이스 green 유지(JSON 경로 byte-identical). 추가 — `downloadText`/`downloadYaml`이 YAML types로 picker 호출, blob mime `application/yaml`, fake timer로 revoke 1회, `AbortError` 시 blob 폴백 미호출.
- `sanitizeFilename.test.ts`(순수 함수 직접 테스트): 평범한 이름 그대로; `/`·`:`·`*`·제어문자 제거; 앞뒤 공백 트림; **전부 제거돼 빈 문자열이 되는 입력**(예: `"///"` → `""`)과 그때 호출부 폴백이 `scenario.yaml`이 되는지; **nullish 입력(`undefined`/`null`) → throw 없이 `""`**(invalid-버퍼 export 경로 가드).
- `YamlFileActions.test.tsx`:
  - 내보내기 → `downloadYaml`이 *내보낸 텍스트에서 파싱한* 파일명 + 보이는 텍스트로 호출. 유효 YAML(`name: Foo`) → `Foo.yaml`; **invalid 버퍼** → 폴백 `scenario.yaml`(파싱 실패 경로).
  - 가져오기(내용 없음: 유효·스텝 0) → `loadFromString`이 파일 내용으로 호출, 확인 없음.
  - 가져오기(내용 있음, 스텝>0) → `window.confirm`(`vi.spyOn`) 표시; 확인→`loadFromString` 호출 / 취소→no-op.
  - 가져오기(**invalid 버퍼**, `yamlError !== null`·`model` null) → 확인 표시(Contradiction B 회귀 가드).
  - 입력 value 리셋(같은 파일 재선택 가능).
  - 읽기 오류 → `role="alert"`.
- jsdom 폴리필: `URL.createObjectURL`(기존 `downloadJson.test.ts` 패턴) + `showSaveFilePicker` mock.

### 8.2 라이브 검증 (client-only Playwright)
RTL/jsdom이 못 잡는 표면(실 picker 바운드 호출·실 blob 다운로드·실 파일 업로드 — `picker.call` 함정은 `ui/CLAUDE.md`에 "real-browser-only" 명시)을 `vite dev`의 `/scenarios/new`(백엔드 불필요, 에디터 드래그 슬라이스와 동일 harness)에서 검증:
- 내보내기 → `.yaml` 파일이 올바른 이름+내용으로 실제 다운로드(headless Chromium은 `showSaveFilePicker` 보통 부재 → blob-anchor 폴백 경로를 탐 — 의도된 폴백 검증).
- `.yaml` 파일 가져오기 → 아웃라인/Monaco에 반영.
- 스텝 있는 상태에서 가져오기 → 확인 다이얼로그 표시.

`vite dev`는 IPv6 `[::1]` 바인드 → Playwright `localhost`로 navigate(`ui/CLAUDE.md`). `browser_file_upload`는 repo-루트 제한(`docs/dev/live-verify-playwright.md`).

선택(nice-to-have, 블로킹 아님): 실 Chrome에서 내보내기 1회로 `application/yaml` picker 경로 실측(headless가 못 덮는 부분). picker `application/yaml` accept가 throw해도 `saveViaPicker`가 non-Abort throw를 catch→false→blob 폴백이라 크래시는 없음(graceful) — 그래서 블로킹 아님.

## 9. 수용 기준 (acceptance)

1. YAML 편집 모달에 "파일에서 열기"·"파일로 저장" 버튼이 있고, 두 페이지(`/scenarios/new`, `/scenarios/:id`)에서 보인다.
2. "파일로 저장" → 현재 보이는 YAML이 `${scenario-name}.yaml`(폴백 `scenario.yaml`)로 다운로드된다.
3. "파일에서 열기" → `.yaml` 파일을 골라 에디터에 로드된다(아웃라인+Monaco 반영).
4. 내용이 있는 상태(스텝 존재 **또는** invalid WIP 버퍼 = `yamlError`)에서 가져오기 → 대체 확인이 뜨고, 취소 시 기존 내용 유지·확인 시 대체. 빈 스타터(유효·스텝 0)면 확인 없이 로드.
5. invalid YAML 파일 가져오기 → 텍스트가 로드되고 `yamlError`로 표면화(앱 크래시 없음).
6. 파일 읽기 실패 → `role="alert"` 메시지, 모델 무변경.
7. 같은 파일 재선택 가능(입력 value 리셋).
8. `downloadJson`(리포트 다운로드 등 기존 소비처) 행동 byte-identical.
9. 모델/스키마/와이어/store 액션 무변경(UI-only) — 새 store 액션 없음(기존 `loadFromString` 재사용).
10. `pnpm lint`(`--max-warnings=0`)·`pnpm test`·`pnpm build` GREEN.

## 10. 참조

- 코드: `ui/src/components/scenario/EditorShell.tsx`(:79-83 모달), `MonacoYamlView.tsx`(:61 visibleText), `ui/src/scenario/store.ts`(`loadFromString`·`yamlText`·`pendingYamlText`·`yamlError`·`model`), `ui/src/scenario/model.ts`(:363-371 `ScenarioModel.name`), `ui/src/api/downloadJson.ts`, `ui/src/pages/ScenarioImportPage.tsx`(`readText`), `ui/src/i18n/ko.ts`.
- 함정: `ui/CLAUDE.md` — picker 바운드 호출(`picker.call(window)`)·blob 1s 지연 revoke·`FileReader.readAsText`(jsdom)·`URL.createObjectURL` 폴리필·dirty-flag seed·라이브 검증 Playwright(`localhost`·`browser_file_upload` 루트 제한).
- 결정: ADR-0044(에디터 아웃라인), ADR-0035(한국어 문구), ADR-0043(디자인 시스템 — 이 슬라이스는 미적용, §2 비목표), ADR-0003(GUI↔Code 양방향 sync).
