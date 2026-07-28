# HAR 가져오기 host-환경 힌트 — 설계

- 날짜: 2026-07-28 · 슬라이스: `har-host-env-hint` (§A12 도그푸딩 백로그 잔여 1건)
- 유형: user-path · UI-only 소형 (서버/proto/store/migration 0-diff)
- ADR: 불요 (모델·와이어 불변)

## 사용자 스토리 (US)

- **US1 (안내)**: QA가 이전에 환경 세트로 등록해 둔 서버의 HAR을 다시 가져올 때, 이 서버가 이미 어느 세트에 있는지 대조 작업 없이 확인한다 — 성공하면 호스트→환경변수 행에 "'{세트명}' 세트에 {var이름}(으)로 등록됨" 안내가 보인다.
- **US2 (프리필)**: QA가 등록된 host의 변수 이름을 손으로 맞추지 않아도 생성 시나리오가 기존 환경과 호환된다 — 성공하면 var 이름 입력이 기존 세트의 이름(예: `BASE_URL`)으로 미리 채워지고, YAML 미리보기의 `${…}` 토큰이 그 이름으로 나온다(= RunDialog에서 기존 환경을 선택만 하면 실행 가능, 새 환경 등록 불필요).
- **US3 (비차단)**: QA가 안내와 다른 결정을 하고 싶을 때(다른 이름 사용·새 세트 등록) 방해받지 않는다 — 성공하면 이름 수정과 "환경으로 등록" 버튼이 안내 표시 전과 동일하게 동작한다.
- **US4 (무영향·fail-soft)**: 등록된 환경이 없거나 환경 조회 API가 실패해도 HAR 가져오기 흐름이 막히지 않는다 — 성공하면 안내만 부재할 뿐, 기존 화면과 기본 이름 프리필(`BASE_URL`/`BASE_URL_2`)이 그대로다.

판정 기준(전 US 공통): "이미 등록됨" = HAR 엔트리의 origin과 기존 환경 var 값의 **origin 정확 일치**(아래 R2).

## 배경·결정 요약 (브레인스토밍 확정)

- 출처: `docs/roadmap.md` §A12 도그푸딩 백로그 — "감지된 host가 기존 환경(environments)에 등록돼 있으면 어느 세트에 있는지 안내(비차단 — 다른 이름 저장 허용). UI-only 소형."
- **범위 = B**: 안내 + var 이름 프리필 (사용자 선택 2026-07-28). 프리필이 실질 가치 — 같은 토큰이면 생성 시나리오를 기존 환경 그대로 실행 가능. 옵션 C(중복 등록 억제 안내)는 기각(YAGNI).
- **매칭 = origin 정확 일치** (사용자 선택): scheme+host+port 전부 일치. host-only 매칭은 재사용 시 스킴이 조용히 바뀌는 위험([[load-divergence-explain-confirm]]의 silent-config 클래스)이라 기각.
- **UI = 변형 A** (목업 승인): 행별 안내 + 섹션 내 발견성 한 줄. 자동 동작(hostVars 자동 enable·환경 자동 선택) 없음 — YAML이 조용히 바뀌는 경로 배제.
- 현재 구조: `ScenarioImportPage`의 "호스트 → 환경변수" 섹션(`hostToEnv` fieldset)이 `hostsByRequestCount`로 host를 뽑고 `defaultHostVars`(BASE_URL/BASE_URL_2…) 기본명 + `hostVarOverrides` 사용자 수정으로 `effectiveHostVars`를 만든다. 환경 목록 API(`GET /api/environments`)는 `vars` 없이 `var_count`만 반환 — vars는 단건 GET(`EnvironmentSchema`)에만 있다.

## 요구사항

### R1. 데이터 취득 — `useEnvironmentsWithVars(enabled)` 훅

- `ui/src/api/hooks.ts`에 신규: `useEnvironments()`(목록) + `useQueries`(환경별 단건 GET) 조합. `useReports(runIds)`가 정확한 선례.
- per-env 쿼리는 기존 `queryKeys.environment(id)`·`getEnvironment(id)` 재사용 — RunDialog `useEnvironment` 캐시와 공유.
- 반환: settle된 성공 쿼리만 모은 `Environment[]` (부분 결과 허용 — 쿼리별 에러 격리가 US4의 절반을 by-construction 충족).
- `enabled: boolean` 파라미터 — `ScenarioImportPage`는 `har !== null`일 때만 켠다(페이지 진입만으로 fan-out 금지). 목록 쿼리에도 `enabled` 적용.
- 환경 개수는 소수(수 개~십수 개) 전제 — N+1 fan-out 수용. 서버 API 확장(`?include=vars`)은 기각(UI-only 스코프).

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
- 각 환경의 각 `[varName, value]`에 대해 `new URL(value)`를 시도 — 파싱 실패 값은 skip(fail-soft), 성공 시 `url.origin === 기준 origin`이면 매치. 값의 표기 차이(후행 `/` 등)는 URL 파싱이 흡수한다. 경로가 붙은 값(`https://h/api`)도 origin이 같으면 매치로 본다(환경 var는 origin 용도라는 기존 `buildEnvInput` 전제).
- host별 다중 매치 정렬: 환경 `updated_at` desc(최근 수정 세트 우선), 동률은 이름 asc. **첫 원소가 프리필 소스**(R3).
- 한 환경 안에서 여러 var가 같은 origin이면 `Object.entries` 순서상 첫 var만 그 환경의 매치로 채택(환경당 최대 1건 — "이 세트에 이 이름으로 등록됨" 문장이 성립해야 함).
- 순수 함수 — fetch·상태 없음.

### R3. 프리필 우선순위 (US2·US3)

- `effectiveHostVars` 도출을 `hostVarOverrides[h] ?? matches[h]?.[0]?.varName ?? defaults[h]`로 확장.
- 사용자가 손댄 칸(`hostVarOverrides`)은 절대 덮지 않는다 — 매치 데이터가 비동기로 늦게 도착해도 안 만진 칸만 기본값→매치명으로 바뀐다.
- 매치명이 기존 `validateEnv` 규칙(빈 이름·형식·중복·예약어)에 걸리면 **기존 검증 UI가 그대로 잡는다** — 신규 검증 로직 없음. (예: 서로 다른 세트의 두 host가 같은 이름으로 매치 → dup 빨간 문구, 사용자가 수정.)

### R4. 행별 안내 (US1)

- `hostVarsEnabled`로 펼친 상태에서, 매치가 있는 host 행 바로 아래 text-xs 한 줄: `'{세트명}' 세트에 {var이름}(으)로 등록됨` + 다중 매치면 ` · 외 N개 세트` 꼬리.
- 표시 전용(비인터랙티브) — 입력·버튼 동작 불변. 세트명·var이름은 **매치 데이터**(프리필 소스 = `matches[h][0]`)에서 오고, 사용자가 이름을 바꿔도 안내 문구는 등록 사실(불변)을 계속 말한다.

### R5. 발견성 한 줄

- 섹션 체크박스 줄 아래, `매치된 host 수 > 0`일 때만: `N개 호스트가 이미 환경 세트에 등록돼 있습니다`(N = 매치 1건 이상인 host 수).
- `hostVarsEnabled` 여부와 무관하게 렌더(접힌 상태에서도 발견성 확보 — 변형 A의 존재 이유). Callout/배너 아님 — text-xs 평문 한 줄. 매치 0건이면 렌더 자체 없음(상시 요소 +0).

### R6. fail-soft (US4)

- 환경 목록/단건 쿼리 에러 → 해당 데이터 없음으로 취급(안내·프리필 부재), 에러 배너·콘솔 스팸 없음.
- 등록 환경 0개 → fan-out 0건, 안내 없음, 기존 화면 byte-identical.

### R7. i18n·카피 (ADR-0035)

- 신규 `ko.import.*` 키 3개: 행별 안내(`(세트, 이름) => …(으)로 등록됨`), 다중 꼬리(`(n) => 외 ${n}개 세트`), 발견성(`(n) => ${n}개 호스트가 이미 환경 세트에 등록돼 있습니다`). 조사는 병기형 `(으)로`.
- 신규↔기존 카탈로그 **양방향 부분문자열 충돌 grep** 수행(신규가 기존을 포함/기존이 신규를 포함 — thinkboard-defaults 교훈, `toHaveTextContent` 부분매칭 오염 방지).

### R8. 불변 (회귀 경계)

- `buildEnvInput`·`validateEnv`·`registerEnv` 흐름·YAML 생성기(`harToScenarioYaml`) 무변경.
- 매치 0건(또는 fetch 미완료) 시 기존 동작 byte-identical — 프리필은 `defaults[h]`로 폴백.

## 엣지 케이스

- **비동기 도착 중 YAML 플립**: 사용자가 매치 도착 전에 hostVars를 켜면 미리보기 토큰이 `BASE_URL`→매치명으로 한 번 바뀔 수 있다 — 수용(HAR 파싱 직후 fetch 시작이라 실사용상 창이 짧고, override는 불변). 스펙 한계로 기록.
- **매치명이 var 규칙 위반**(환경 키가 `${}` 식별자 형식이 아닐 때): 프리필은 되고 기존 `validateEnv`가 invalid로 표시 — 비차단, 사용자가 수정(R3).
- **같은 origin이 여러 세트에**: 안내는 첫 세트 + "외 N개 세트", 프리필은 첫 세트 이름(R2 정렬).
- **port/스킴만 다른 유사 host**: 정확 일치라 매치 안 됨 — 의도된 동작(브레인스토밍 확정).

## 비목표 (후속 후보)

- 중복 등록 억제 안내(옵션 C) · scheme 불일치 꾸밈말 · 기존 환경 업데이트/병합 제안 · 서버 목록 API vars 포함 확장.

## 테스트 전략

- **단위 (`hostEnv.test.ts`)**: `matchHostsToEnvs` — 정확 일치·후행 `/` 흡수·파싱 불가 값 skip·다중 매치 정렬(updated_at desc)·환경당 1건·빈 envs.
- **RTL (`ScenarioImportPage.test.tsx`)**: 기존 `vi.stubGlobal("fetch", …)` URL-디스패치 mock에 `/api/environments`(목록)·`/api/environments/{id}`(단건) 추가. 케이스: ① 행별 안내 렌더(US1) ② 프리필 3단 우선순위 — override > 매치 > 기본(US2·US3) ③ YAML 미리보기 토큰 반영(US2) ④ 발견성 한 줄 — 매치 있을 때만(R5) ⑤ fetch reject 시 기존 화면 그대로(US4) ⑥ dup 검증 상호작용(R3).
- **이빨 실증**: 회귀 가드 표방 테스트는 고의 회귀(예: 프리필 우선순위를 매치 우선으로 뒤집기) 주입→RED→원복→GREEN. `ko.*(…)` 보간 단언은 자기참조 함정 회피 — 렌더된 세트명/숫자를 별도 단언([[plan-mandated-vacuous-tests]] 11호 클래스).
- **게이트**: `pnpm lint && pnpm test && pnpm build`(각각 exit 코드 명시 캡처).

## 라이브 검증 (user-path — US 앵커 표)

진입 경로: `/scenarios/import` 단일(라우트 확인 완료 — 이 컴포넌트가 마운트되는 다른 화면 없음).

| US | 절차 | 통과 신호 |
|---|---|---|
| US1 | 컨트롤러에 환경 세트 등록(값=responder origin) → 같은 origin의 HAR 가져오기 → hostVars 켬 | 행 아래 "'{세트}' 세트에 {이름}(으)로 등록됨" 실표시 |
| US2 | 위 상태에서 var 입력·YAML 미리보기 확인 | 입력값=기존 세트 이름, YAML `${이름}` 토큰 |
| US3 | 이름을 다른 값으로 수정 → 환경으로 등록 | 수정값 유지·등록 성공(안내는 유지) |
| US4 | 환경 0개 상태(또는 컨트롤러 환경 API 차단)에서 같은 HAR | 안내 없음·기본 프리필·흐름 정상 |
