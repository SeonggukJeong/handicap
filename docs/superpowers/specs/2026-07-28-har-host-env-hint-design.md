# HAR 가져오기 host-환경 힌트 — 설계

- 날짜: 2026-07-28 · 슬라이스: `har-host-env-hint` (§A12 도그푸딩 백로그 잔여 1건)
- 유형: user-path · UI-only 소형 (서버/proto/store/migration 0-diff)
- ADR: 불요 (모델·와이어 불변)

## 사용자 스토리 (US)

- **US1 (안내)**: QA가 이전에 환경으로 등록해 둔 서버의 HAR을 다시 가져올 때, 이 서버가 이미 어느 환경에 있는지 대조 작업 없이 확인한다 — 성공하면 ① 체크박스를 켜기 전에도 섹션에 "호스트 {n}개가 이미 환경에 등록돼 있습니다" 한 줄이 보이고 ② 켠 뒤에는 해당 host 행에 "'{환경명}' 환경에 {var이름}(으)로 등록됨" 안내가 보인다.
- **US2 (프리필)**: QA가 등록된 host의 변수 이름을 손으로 맞추지 않아도 생성 시나리오가 기존 환경과 호환된다 — 성공하면 체크박스를 켠 뒤 var 이름 입력이 기존 환경의 이름(예: `BASE_URL`)으로 미리 채워지고, YAML 미리보기의 `${…}` 토큰이 그 이름으로 나온다(= RunDialog에서 기존 환경을 선택만 하면 실행 가능, 새 환경 등록 불필요).
- **US3 (비차단)**: QA가 안내와 다른 결정을 하고 싶을 때(다른 이름 사용·새 환경 등록) 방해받지 않는다 — 성공하면 이름 수정과 "환경으로 등록" 버튼이 안내 표시 전과 동일하게 동작한다.
- **US4 (무영향·fail-soft)**: 등록된 환경이 없거나 환경 조회 API가 실패해도 HAR 가져오기 흐름이 막히지 않는다 — 성공하면 안내만 부재할 뿐, 기존 화면과 기본 이름 프리필(`BASE_URL`/`BASE_URL_2`)이 그대로다.

판정 기준(전 US 공통): "이미 등록됨" = HAR 엔트리의 origin과 기존 환경 var 값의 **origin 정확 일치**, 단 값이 **순수 origin**일 때만(아래 R2).

## 배경·결정 요약 (브레인스토밍 확정)

- 출처: `docs/roadmap.md` §A12 도그푸딩 백로그 — "감지된 host가 기존 환경(environments)에 등록돼 있으면 어느 세트에 있는지 안내(비차단 — 다른 이름 저장 허용). UI-only 소형."
- **범위 = B**: 안내 + var 이름 프리필 (사용자 선택 2026-07-28). 프리필이 실질 가치 — 같은 토큰이면 생성 시나리오를 기존 환경 그대로 실행 가능. 옵션 C(중복 등록 억제 안내)는 기각(YAGNI).
- **매칭 = origin 정확 일치** (사용자 선택): scheme+host+port 전부 일치 — 재사용할 환경 값과 프리필 근거가 된 트래픽 origin이 1:1로 대응함을 보장한다. host-only 매칭(스킴 무시)은 기각. (한계: HAR 안에 같은 host가 http/https 혼재하면 기존 `parameterizeUrl`이 host 단위로 치환해 first-seen origin이 이긴다 — 이 슬라이스가 도입한 위험이 아니라 기존 동작이며, 매칭도 first-seen origin(`originOf`) 기준으로만 성립. 엣지 케이스 §참조.)
- **UI = 변형 A** (목업 승인): 행별 안내 + 섹션 내 발견성 한 줄. 자동 동작(hostVars 자동 enable·환경 자동 선택) 없음 — YAML이 조용히 바뀌는 경로 배제.
- **어휘**: 사용자 노출 문구는 앱 기존 명사 **"환경"** 사용(ko.ts `environments: "환경"` — "세트"는 ko 카탈로그에 0회, 신규 어휘 도입 금지. `8e04441` 어휘 통일 선례).
- 현재 구조: `ScenarioImportPage`의 "호스트 → 환경변수" 섹션(`hostToEnv` fieldset)이 `hostsByRequestCount`로 host를 뽑고 `defaultHostVars`(BASE_URL/BASE_URL_2…) 기본명 + `hostVarOverrides` 사용자 수정으로 `effectiveHostVars`를 만든다. 환경 목록 API(`GET /api/environments`)는 `vars` 없이 `var_count`만 반환 — vars는 단건 GET(`EnvironmentSchema`)에만 있다. 환경 값은 자유 문자열(`EnvironmentsPage.buildInput`은 URL 검증 없음 — origin이라는 보장은 이 페이지가 만든 환경에만 성립하므로 R2가 값 형태를 직접 검사한다).

## 요구사항

### R1. 데이터 취득 — `useEnvironmentsWithVars(enabled)` 훅

- `ui/src/api/hooks.ts`에 신규. **내부 구성**: ① 목록은 훅 내부의 자체 `useQuery({ queryKey: queryKeys.environments(), queryFn: listEnvironments, enabled })` — 공유 `useEnvironments()`는 파라미터가 없고 호출부 2곳(`EnvironmentPicker`·`EnvironmentsPage`)이 있어 시그니처를 건드리지 않는다(같은 queryKey라 캐시는 공유됨). ② 단건은 `useQueries`로 fan-out — per-env 쿼리는 기존 `queryKeys.environment(id)`·`getEnvironment(id)` 재사용(RunDialog `useEnvironment` 캐시와 공유).
- **fan-out 상한 K=20**: 목록을 `updated_at` desc로 정렬해 상위 20개만 단건 fetch(목록 summary에 `updated_at` 있음). R2 정렬과 같은 축이라 상한이 잘라도 "최근 환경 우선" 의미가 유지된다.
- 반환: settle된 성공 쿼리만 모은 `Environment[]` — `useQueries`의 `combine` 옵션(설치본 v5.100.14에 존재)으로 **참조 안정화**(부분 결과 허용 — 쿼리별 에러 격리가 US4의 절반을 by-construction 충족). `combine` 콜백은 **모듈 스코프**에 정의(인라인이면 identity 변화로 내부 memo가 매번 무효 — deep-equal `replaceEqualDeep`가 참조는 지켜주지만 매 렌더 재계산 낭비).
- 참고: `useReports`(hooks.ts:208)는 `useQueries` *모양*의 선례일 뿐 — `enabled`·부분수집·`combine`은 이 훅이 신규다(기존 소비처 `ScenarioComparePage`는 all-or-nothing).
- `ScenarioImportPage`는 `har !== null`일 때만 켠다(페이지 진입만으로 fan-out 금지). 서버 API 확장(`?include=vars`)은 기각(UI-only 스코프).

### R2. 매칭 순수 함수 — `matchHostsToEnvs` (`ui/src/import/hostEnv.ts`)

```ts
export interface HostEnvMatch {
  envId: string;
  envName: string;
  varName: string;
}
export function matchHostsToEnvs(
  hosts: string[],
  preview: readonly PreviewEntry[],
  envs: readonly Environment[],
): Record<string, HostEnvMatch[]>;
```

- host별 기준 origin = 기존 `originOf(host, preview)`. `""`(파싱 불가)면 그 host는 매치 없음.
- 각 환경의 각 `[varName, value]`에 대해 `new URL(value)`를 시도 — 파싱 실패 값은 skip. **순수 origin 값만 매치 후보**: `url.origin === 기준 origin`이고 `url.pathname === "/" && url.search === "" && url.hash === ""`일 때만 매치(후행 `/` 하나는 URL 파싱이 흡수). 경로/쿼리가 붙은 값(`https://h/api`)은 **매치 자체에서 제외** — 프리필하면 `${VAR}${pathname}`이 이중 경로(`https://h/api/users`)로 해석돼 US2("선택만 하면 실행 가능")가 조용히 거짓이 되기 때문(안내도 하지 않는다 — 안내와 프리필의 판정을 가르면 문구가 거짓말하게 된다).
- host별 다중 매치 정렬: 환경 `updated_at` desc(최근 수정 환경 우선), 동률은 환경 이름 asc. **첫 원소가 프리필 소스**(R3).
- 한 환경 안에서 여러 var가 같은 origin이면 **var 이름 asc 첫 번째**만 그 환경의 매치로 채택(환경당 최대 1건). 주의: 와이어의 vars는 서버 `BTreeMap` 직렬화라 이미 사전순이지만, 함수는 순서를 가정하지 말고 명시 정렬한다.
- 순수 함수 — fetch·상태 없음.

### R3. 프리필 우선순위 + 중복 방지 (US2·US3)

- **도출은 `hostEnv.ts`의 export 순수 함수로**: `resolveHostVars(hostsOrdered, matches, overrides): Record<string, string>` — 페이지의 `effectiveHostVars` memo는 이 함수 호출로 축소된다. 이유: 자격 규칙이 쓰는 `VAR_NAME_RE`가 `hostEnv.ts` module-private(export는 `RESERVED`뿐)이고, 아래 dedupe 단위 테스트가 `hostEnv.test.ts`에 배정돼 있다 — 페이지에 로직을 두면 regex ad-hoc export 또는 단위 테스트 도달 불가 중 하나가 강제된다.
- **우선순위**: `overrides[h] ?? 프리필 후보(h) ?? defaults[h]` (defaults = 기존 `defaultHostVars`).
- **프리필 후보 자격**: `matches[h][0].varName`이 ① `VAR_NAME_RE` 통과 ② `RESERVED`(vu_id 등) 아님일 때만. 자격 미달이면 후보 없음 → `defaults[h]` 폴백(행별 안내는 사실이므로 그대로 표시). 근거: `validateEnv`는 예약어를 soft 경고만 하고(`ok`에 미포함 — 기존 테스트가 "등록 활성"을 고정), 형식 위반도 [환경으로 등록]만 막을 뿐 [복사]·[편집기로 보내기]는 미게이트라, 프리필이 만든 나쁜 이름이 YAML로 샐 수 있다.
- **프리필 중복 방지(dedupe)**: 서로 다른 환경이 같은 이름(전형: 둘 다 `BASE_URL`)을 쓰면 2-host HAR에서 두 행이 같은 이름으로 프리필돼, 미게이트 [복사]/[편집기로 보내기] 경로로 **사용자 행동 없이** 두 host가 한 `${BASE_URL}`로 붕괴한다(silent-config 클래스). 방지 알고리즘:
  1. **pre-pass**: `hostsOrdered`에 현재 존재하는 host의 `overrides` 값을 전부 `used`에 시드 — override 칸은 절대 재작성하지 않지만 **이름은 점유한다**(시드를 현재 host로 한정하는 이유: overrides는 파일 재선택 전까지 잔존하므로 제외된 host의 stale 항목이 이름을 예약하면 안 됨). 이게 없으면 "뒤 행에 override + 앞 행에 매치" 순서에서 늦은 프리필이 override와 같은 이름을 배정해 동일한 silent-collapse가 남는다.
  2. **forward pass**: `hostsOrdered` 순서로 순회 — override 있는 host는 그 값 그대로(재작성 없음), 나머지는 후보→`defaults[h]`→`BASE_URL_{k}` 순으로 `used`에 없는 첫 이름을 배정. `BASE_URL_{k}`는 **k=2부터 증가**하며 `used` 재검사(`defaultHostVars`는 `BASE_URL_1`을 절대 내지 않음). **배정된 모든 이름은 즉시 `used`에 추가** — 이 불변식이 뒤 host의 무충돌을 보장한다. 결정적·전역 유일.
- **override는 값 재작성 대상이 아님** — 사용자가 손댄 칸은 절대 덮지 않는다(US3). 사용자가 override로 직접 만든 중복(예: 두 칸에 같은 이름 타이핑)은 기존 `validateEnv` dup 빨간 문구가 잡는다.
- 매치 데이터는 비동기 도착 — 안 만진 칸만 기본값→매치명으로 바뀐다.

### R4. 행별 안내 (US1-②)

- `hostVarsEnabled`로 펼친 상태에서, 매치가 있는 host 행 아래 text-xs 한 줄: `'{환경명}' 환경에 {var이름}(으)로 등록됨` + 다중 매치면 ` · 외 {N}개 환경` 꼬리(**N = `matches[h].length - 1`**).
- **배치**: 현재 host 행은 `<label key={h}>` 하나가 이름+화살표+Input을 감싼다 — 안내 `<p>`는 그 `<label>` **밖** 형제로 두어야 한다(라벨 안에 넣으면 안내 클릭이 입력을 포커스해 "표시 전용"이 깨짐). map 렌더를 keyed fragment로 전환.
- 표시 전용(비인터랙티브) — 입력·버튼 동작 불변. 환경명·var이름은 **매치 데이터**(프리필 소스 = `matches[h][0]`)에서 오고, 사용자가 이름을 바꾸거나 dedupe가 폴백해도 안내 문구는 등록 사실(불변)을 계속 말한다.

### R5. 발견성 한 줄 (US1-①)

- 섹션 체크박스 줄 아래, `매치된 host 수 > 0`일 때만: `호스트 {n}개가 이미 환경에 등록돼 있습니다`(n = 매치 1건 이상인 host 수).
- `hostVarsEnabled` 여부와 무관하게 렌더(접힌 상태에서도 발견성 확보 — US1-①이 이 줄의 존재 이유). Callout/배너 아님 — text-xs 평문 한 줄. 매치 0건이면 렌더 자체 없음(상시 요소 +0).

### R6. fail-soft (US4)

- 환경 목록/단건 쿼리 에러 → 해당 데이터 없음으로 취급(안내·프리필 부재), **앱 레벨 에러 배너·`console.error` 없음**(브라우저 자체 네트워크 로그·React Query retry 1회는 앱이 막을 수 없는 범위라 허용).
- 등록 환경 0개 → fan-out 0건, 안내 없음, 기존 화면 byte-identical.

### R7. i18n·카피 (ADR-0035)

- 신규 `ko.import.*` 키 3개 — **byte-exact**:
  - `hostRegisteredIn: (env: string, varName: string) => \`'${env}' 환경에 ${varName}(으)로 등록됨\``
  - `hostRegisteredMore: (n: number) => \`외 ${n}개 환경\`` (구분자 ` · `는 JSX에서)
  - `hostsRegisteredSummary: (n: number) => \`호스트 ${n}개가 이미 환경에 등록돼 있습니다\``
- 신규↔기존 카탈로그 **양방향 부분문자열 충돌 grep** 수행(신규가 기존 전체값을 포함/기존이 신규 전체값을 포함 — thinkboard-defaults 교훈, `toHaveTextContent` 부분매칭 오염 방지). 충돌 발견 시 같은 화면에 동시 렌더되는 쌍만 문제 삼는다(전 카탈로그 무충돌은 비현실 — "환경" 단독 키 등). **측정된 same-screen 쌍 1건**: `ko.import.hosts`("호스트") ⊂ `hostsRegisteredSummary` — hosts fieldset legend(`hosts.length > 1`)와 R5 줄이 2-host HAR에서 동시 렌더되므로, 이 화면 테스트의 "호스트" 단언은 `toHaveTextContent`/정규식 부분매칭 금지(exact `getByText` 또는 스코프 한정).

### R8. 불변 (회귀 경계)

- `buildEnvInput`·`validateEnv`·`registerEnv` 흐름·YAML 생성기(`harToScenarioYaml`) 무변경.
- 매치 0건(또는 fetch 미완료) 시 기존 동작 byte-identical — 프리필은 `defaults[h]`로 폴백.
- **성능**: `matchHostsToEnvs`는 `useMemo`로 — deps는 참조 안정화된 `envs`(R1 `combine`)와 기존 memo 산출물(`hostsOrdered`·`previewEntries`). 매 렌더 재계산으로 `yaml` memo(대형 HAR에서 비쌈)까지 연쇄 재계산되는 것 방지.

## 엣지 케이스

- **비동기 도착 중 YAML 플립**: 사용자가 매치 도착 전에 hostVars를 켜면 미리보기 토큰이 `BASE_URL`→매치명으로 한 번 바뀔 수 있다 — 수용(HAR 파싱 직후 fetch 시작이라 실사용상 창이 짧고, override는 불변). 스펙 한계로 기록.
- **경로/쿼리 붙은 환경 값**: 매치 제외(R2) — 안내도 프리필도 없음. 의도된 fail-quiet.
- **매치명이 형식 위반·예약어**: 안내는 표시, 프리필만 제외(R3 자격 규칙).
- **같은 origin이 여러 환경에**: 안내는 첫 환경 + "외 N개 환경", 프리필은 첫 환경 이름(R2 정렬), 이름 점유 시 dedupe 폴백(R3).
- **port/스킴만 다른 유사 host**: 정확 일치라 매치 안 됨 — 의도된 동작(브레인스토밍 확정).
- **HAR 내 같은 host의 http/https 혼재**: `originOf`가 first-seen origin을 반환하므로 그 origin 기준으로만 매칭— `parameterizeUrl`의 host 단위 치환(기존 동작)과 함께 알려진 한계로 기록(이 슬라이스 비도입).

## 비목표 (후속 후보)

- 중복 등록 억제 안내(옵션 C) · scheme 불일치 꾸밈말 · 기존 환경 업데이트/병합 제안 · 서버 목록 API vars 포함 확장 · 혼합 스킴 host 매치 제외.

## 테스트 전략

- **단위 (`hostEnv.test.ts`)**: `matchHostsToEnvs` — 정확 일치·후행 `/` 흡수·경로/쿼리 값 제외·파싱 불가 값 skip·다중 매치 정렬(updated_at desc→이름 asc)·환경 내 var 이름 asc 1건·빈 envs. `resolveHostVars` — 두 환경 같은 이름 충돌 시 `defaults` 폴백·기본명 점유 시 `_k`(k=2부터) 증가·override 값 재작성 없음·**override 시드 순서 케이스**(뒤 행 override `API_URL` + 앞 행 매치 `API_URL` → 앞 행이 `defaults` 폴백, override와 비충돌)·stale override(목록 밖 host)는 이름 예약 안 함.
- **RTL (`ScenarioImportPage.test.tsx`)**: 신규 훅이 HAR 로드 시 **무조건 발화**하므로 기존 ~22개 미모킹 테스트가 undici 상대경로 reject로 깨진다(ui/CLAUDE.md "무조건 발화하는 React Query 훅" 함정) — **파일 공통 baseline fetch stub**(`beforeEach`에서 `/api/environments` → `{environments: []}` 반환)을 먼저 깔고, 힌트 케이스만 URL-디스패치 mock으로 목록+단건을 준다. 케이스: ① 행별 안내 렌더(US1-②) ② 발견성 한 줄 — 매치 있을 때만·체크박스 꺼진 상태에서도(US1-①/R5) ③ 프리필 3단 우선순위 — override > 매치 > 기본(US2·US3) ④ YAML 미리보기 토큰 반영(US2) ⑤ dedupe — 두 host 같은 매치명일 때 두 번째가 기본명 폴백(R3) ⑥ fetch reject 시 기존 화면 그대로(US4) ⑦ dup 검증 상호작용 — override로 만든 중복은 기존 빨간 문구(R3).
- **이빨 실증**: 회귀 가드 표방 테스트는 고의 회귀(예: dedupe 제거·프리필 우선순위 뒤집기) 주입→RED→원복→GREEN. `ko.*(…)` 보간 단언은 자기참조 함정 회피 — 렌더된 환경명/숫자를 별도 단언([[plan-mandated-vacuous-tests]] 11호 클래스).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(각각 exit 코드 명시 캡처).

## 라이브 검증 (user-path — US 앵커 표)

진입 경로: `/scenarios/import` 단일(라우트 확인 완료 — 이 컴포넌트가 마운트되는 다른 화면 없음).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 컨트롤러에 환경 등록(값=responder origin) → 같은 origin의 HAR 가져오기 | 체크박스 켜기 전 발견성 한 줄 → 켠 뒤 행 아래 "'{환경}' 환경에 {이름}(으)로 등록됨" 실표시 |
| US2 | 위 상태에서 var 입력·YAML 미리보기 확인 | 입력값=기존 환경 이름, YAML `${이름}` 토큰 |
| US3 | 이름을 다른 값으로 수정 → 환경으로 등록 | 수정값 유지·등록 성공(안내는 유지) |
| US4 | 환경 0개 상태에서 같은 HAR | 안내 없음·기본 프리필·흐름 정상 |
