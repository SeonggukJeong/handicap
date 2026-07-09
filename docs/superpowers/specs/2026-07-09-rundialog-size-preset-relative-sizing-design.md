# RunDialog 크기 프리셋 상대 배수 사이징 — "빠른 입력" 칩을 직전 run 기준 0.5×/1×/2×로 (roadmap §B10 Option C)

- **날짜**: 2026-07-09
- **상태**: 설계 승인(spec-plan-reviewer clean APPROVE, 2026-07-09) → plan 작성 대기
- **출처**: `roadmap-status.md` "소규모 후속" / `2026-06-28-rundialog-ux-fixes-design.md` §7 백로그 Option C. **왜 지금**: 사용자가 "작지만 가치가 큰 작업"으로 지목, 고정 10/50/200명 칩이 시나리오 규모와 무관해 크거나 작은 시나리오엔 부적합.
- **연관**: `2026-06-28-rundialog-ux-fixes-design.md`(Option A로 "추천" 프레이밍 제거·Option C는 백로그로 연기), `VuSizingHelper.tsx`(재사용하는 `usePriorClosedRunAnchor` 원 소유자).
- **ADR**: 신규 불필요(ADR-0043 UI 디자인시스템·ADR 무관 UI-only 프레젠테이션 변경, 기존 사이징 헬퍼 패턴의 확장).

---

## 1. 문제와 목표

RunDialog의 "빠른 입력" 칩(closed-loop+고정 모드에서만 노출)은 모든 시나리오에 동일한 고정값(10명·30초/50명·1분/200명·3분)을 보여준다. 시나리오마다 적정 부하 규모가 다르므로, 이미 이 시나리오로 한 번 이상 run을 돌려본 사용자에겐 그 직전 run 대비 상대 배수(0.5×/1×/2×)가 훨씬 유용한 시작점이다.

- **목표**: 이 시나리오의 가장 최근 완료된 closed-loop(고정 VU) run이 있으면 그 VU·duration을 "1×"로 두고 0.5×/1×/2× 칩을 계산해 보여준다. 없으면(신규 시나리오, ScheduleForm) 기존 고정 3개 칩을 그대로 보여준다(폴백 byte-identical).
- **비목표(연기)**: §7 참조. open-loop 프리셋 칩 신설, duration 단독 배수 조정, 다른 시나리오 히스토리 참조.

---

## 2. 요구사항 (정규 — R-id) ⟵ 척추

| ID | 요구사항 (MUST/SHOULD, 한 문장) | acceptance (충족 확인법: 테스트명 또는 관찰) | seam? |
|---|---|---|---|
| R1 | MUST `usePriorClosedRunAnchor`(현 `VuSizingHelper.tsx` private)를 **export**하고 반환 타입에 `durationSeconds`(= `latest.profile.duration_seconds`)를 추가한다. 기존 `{vus,rps}` 소비처(VuSizingHelper 본체)는 무변경. | `sizing.ts`/`VuSizingHelper.test.tsx` 기존 테스트 grep 무변경 통과 | |
| R2 | MUST `sizing.ts`에 순수 함수 `sizePresetsFor(anchor: {vus,durationSeconds} \| null): {label,vus,durationSeconds}[]` 추가 — `anchor===null`이면 `ko.loadModel.sizePresets`(고정 3개)의 **spread 복사본**(`[...ko.loadModel.sizePresets]`)을 반환한다(`ko`가 `as const`라 원본은 readonly tuple — 그대로 반환하면 mutable 반환타입과 안 맞아 `tsc -b`가 깨진다). | 단위 테스트 `sizePresetsFor(null)` → 기존 배열과 deep-equal(`toEqual`,참조 동일성 아님) | |
| R3 | MUST `anchor` 있으면 `[0.5,1,2]` 배수로 `vus=Math.max(1,Math.round(anchor.vus*m))`·`durationSeconds=Math.max(1,Math.round(anchor.durationSeconds*m))`, 라벨은 `` `${vus}명 · ${formatDurationKo(durationSeconds)}` ``(기존 `i18n/duration.ts::formatDurationKo` 재사용, 신규 포맷터 없음). | 단위 테스트: anchor={vus:20,durationSeconds:60,rps:*} → `["10명 · 30초","20명 · 1분","40명 · 2분"]` | |
| R4 | MUST 계산된 `(vus,durationSeconds)` 쌍이 배수 순서(0.5×→1×→2×)상 앞서 나온 쌍과 완전히 같으면 그 칩을 건너뛴다(중복 버튼 방지, 2개만 남는 것도 허용). | 단위 테스트: anchor={vus:1,durationSeconds:1,...} → 0.5×(1,1)·1×(1,1) 중복 → 칩 2개(`["1명 · 1초","2명 · 2초"]`) | |
| R5 | MUST `RunDialog.tsx`가 `usePriorClosedRunAnchor(scenarioId)`를 직접 호출해 새 optional prop `sizePresetAnchor`로 `LoadModelFields`에 내려준다. `LoadModelFields`는 이 hook을 직접 호출하지 **않는다**(순수 프레젠테이셔널 유지 — R8 근거). | `RunDialog.tsx` diff에 hook 호출 + prop 전달 라인 존재, `LoadModelFields.tsx`엔 `usePriorClosedRunAnchor`/`useScenarioRuns`/`useRunReport` import 없음(grep) | |
| R6 | MUST `LoadModelFields`는 `sizePresetsFor(sizePresetAnchor ?? null)`으로 칩 목록을 계산해 렌더한다(기존 `ko.loadModel.sizePresets.map(...)` 인라인 대체). 클릭 시 `setVus(p.vus); setDuration(p.durationSeconds)`는 무변경. | `LoadModelFields.test.tsx` 기존 "closed 모드 chips" 테스트 무변경 통과(anchor 미전달=`undefined`→고정폴백) | |
| R7 | MUST `sizePresetAnchor`가 없으면(ScheduleForm 미전달, 또는 RunDialog인데 앵커가 `null`) 캡션은 기존 `ko.loadModel.sizePresetsCaption`("대상 시스템에 맞게 조정하세요") 그대로. 있으면 신규 `ko.loadModel.sizePresetsCaptionFromPrior(vus, durationLabel)` → "직전 run(20명 · 1분) 기준입니다"(ADR-0035 함수 키). | 단위/RTL 테스트 양쪽 캡션 텍스트 단언 | |
| R8 | MUST `RunDialog.test.tsx`의 `vi.mock("../VuSizingHelper", () => ({ VuSizingHelper: () => null }))` **bare mock**을 factory-spread(`importOriginal`)로 교정해 `usePriorClosedRunAnchor`의 실제 구현이 유지되게 한다 — 안 하면 `RunDialog.tsx`의 새 hook 호출이 `undefined(...)` TypeError로 전체 스위트를 깬다. | `RunDialog.test.tsx` 전체(신규 케이스 제외) 무변경 green | ✅ `test-mock 계약`(ui/CLAUDE.md 팩토리-스프레드 패턴) |
| R9 | MUST `LoadModelFields.test.tsx`는 **한 줄도 수정하지 않고** 기존 스위트가 그대로 통과한다(R5의 존재 이유 — QueryClientProvider 불요 유지). | `git diff --stat`에 `LoadModelFields.test.tsx` 없음 | |
| R10 | SHOULD 신규 anchor 있는 RunDialog 시나리오(직전 완료 closed run 존재)를 검증하는 RTL 테스트를 최소 1개 추가 — `fetchMock`이 `GET .../runs`(완료+vus>0 1건)·`GET .../report`(rps>0)를 라우팅해 칩 3개가 계산값으로 렌더되는지. | 신규 `RunDialog.test.tsx` 케이스 | |
| R11 | MUST `usePriorClosedRunAnchor` export가 `react-refresh/only-export-components`(eslint, `--max-warnings=0`) 경고를 유발하므로 export 선언 바로 위에 `// eslint-disable-next-line react-refresh/only-export-components`를 붙인다(이 코드베이스 기존 5건 선례: `StageCurvePreview.tsx`/`FlowOutline.tsx`/`VarUsagePopover.tsx`/`MonacoYamlView.tsx`/`RunListControls.tsx`와 동일 패턴). | `pnpm lint`(`--max-warnings=0`) 0 warning | |

- **seam?**: R8만 — 프로덕션 계약이 아니라 테스트 모킹 계약(실제 훅 구현이 mock에 가려지지 않아야 함)이라 일반 wire seam은 아니지만, 이 슬라이스의 성립 여부를 가르는 유일한 함정이라 표에 남긴다.

---

## 3. 핵심 통찰 (설계 근거)

1. **B안(RunDialog가 앵커 계산 → prop) vs A안(LoadModelFields가 직접 hook 호출)** — 원래 A안(diff 최소)을 검토했으나, `LoadModelFields.test.tsx`는 `VuSizingHelper`/`SlotSizingHelper`/`WorkerSizingHelper`를 전부 `vi.mock`으로 스텁해 **`QueryClientProvider` 없이** 렌더된다. `usePriorClosedRunAnchor`는 내부에서 `useQuery`(via `useScenarioRuns`/`useRunReport`)를 호출하므로, `LoadModelFields`가 직접 이 hook을 부르면 `enabled:false`여도 `useQueryClient()`가 즉시 throw해 기존 스위트 전체가 깨진다. `RunDialog.test.tsx`는 RunDialog 자체가 이미 `useScenario` 등을 직접 써서 `QueryClientProvider`로 감싸져 있다(R9의 근거 — 기존 인프라를 그대로 활용). 그래서 앵커 계산 책임을 hook-호출 인프라가 이미 있는 RunDialog로 옮긴다(R5). (A안을 살리는 A'안 — `LoadModelFields.test.tsx`에 `QueryClientProvider`를 새로 씌우는 것 — 도 기술적으로 가능하지만 diff가 더 커지고 이 컴포넌트를 "순수 프레젠테이셔널"로 유지하는 기존 관례를 깨므로 기각.)
2. **`sizing.ts`는 React 의존 없는 순수 계산 전용 파일**(파일 최상단 주석 "React 의존 없음 — 단위 테스트 대상")이라, hook(`usePriorClosedRunAnchor`)은 그대로 `VuSizingHelper.tsx`에 두고 export만 하고(R1), 순수 함수(`sizePresetsFor`)만 `sizing.ts`에 추가한다(R2) — 기존 파일 역할 분리를 안 깨뜨림.
3. **왜 duration도 같은 배수로 스케일하나(R3)** — 사용자 결정(브레인스토밍 확인): "짝지어 온 프리셋" 관례(현재도 VU·duration이 항상 쌍)를 유지하는 게 계산도 단순하고 "직전 run과 비례한 크기"라는 심상 모델에 맞는다.
4. **왜 중복 collapse가 필요한가(R4)** — 직전 run VU가 1이면 0.5×→round(0.5)→클램프 1, 1×→1로 같은 값이 된다. 시각적으로 동일한 버튼 2개가 뜨는 건 사용자가 "왜 두 개가 같지?"로 헷갈리게 하므로 배수 순서상 처음 나온 값만 남긴다.
5. **R8이 이 설계의 유일한 실제 위험** — bare `vi.mock` auto-mock이 모듈 전체를 갈아치우는 패턴은 이미 `ui/CLAUDE.md`에 "커스텀 에러 클래스 던지는 모듈"·"무조건 발화 훅 추가" 두 항목으로 문서화된 반복 함정이다. 이번은 세 번째 사례(export된 순수 hook을 bare mock이 날려버림) — 고치지 않으면 RunDialog 스위트 전체가 첫 렌더에서 즉사한다(A2-2급 회귀).
6. **`sizing.ts::sizePresetsFor`가 `ko.loadModel.sizePresets`를 그대로 반환하면 안 되는 이유(R2)** — `ko.ts`의 최상위 객체가 `as const`라 `sizePresets`는 readonly tuple이다. `pnpm test`(esbuild transpile)는 통과하지만 `pnpm build`(`tsc -b`)에서만 "readonly array is not assignable to mutable array" 류로 깨지는, ui/CLAUDE.md가 반복 경고하는 build-gate 클래스 함정이다 — spread 복사(`[...ko.loadModel.sizePresets]`)로 회피.
7. **`usePriorClosedRunAnchor` export는 `react-refresh/only-export-components`를 유발한다(R11)** — 이 파일(`VuSizingHelper.tsx`)은 컴포넌트(`VuSizingHelper`)와 hook을 한 파일에서 export하게 되는데, `eslint.config.js`가 `allowConstantExport:true`로도 함수(비-컴포넌트) export는 못 봐준다. 이미 이 저장소에 컴포넌트+헬퍼 hook을 같은 파일에서 export하는 선례가 5건 있고 전부 `eslint-disable-next-line` 한 줄로 해결했으므로 같은 패턴을 따른다(파일을 분리하는 대안도 있지만 기존 소유권 구조를 그대로 두는 쪽이 diff가 작다).

---

## 4. 변경 상세

### 4.1 `components/VuSizingHelper.tsx` — 충족 R: `R1, R11`
- `function usePriorClosedRunAnchor(...)` → `export function usePriorClosedRunAnchor(...)`, 바로 위 줄에 `// eslint-disable-next-line react-refresh/only-export-components`(R11 — 기존 5건 선례와 동일 패턴, 파일 분리 대신 이 방식 선택).
- 반환 타입 `{vus:number; rps:number} | null` → `{vus:number; rps:number; durationSeconds:number} | null`(신규 exported type alias `ClosedRunAnchor`). `durationSeconds = latest?.profile.duration_seconds ?? 0`, 기존 게이트(`vus>0 && rps>0`)는 무변경(closed+fixed run은 `duration_seconds`가 항상 양수 — `validate_run_config`가 보장, 추가 게이트 불필요).
- 컴포넌트 본체(JSX)는 `anchor.durationSeconds`를 안 쓰므로 무변경.

### 4.2 `components/sizing.ts` — 충족 R: `R2, R3, R4`
- `import { formatDurationKo } from "../i18n/duration";` + `import { ko } from "../i18n/ko";` 추가. **`VuSizingHelper.tsx`(`.tsx`)에서 타입을 import하지 않는다** — `sizePresetsFor`는 `anchor: { vus: number; durationSeconds: number } | null`(리터럴 타입, `ClosedRunAnchor`의 부분집합을 인라인)만 받으면 충분하므로, `import type`이 컴파일 타임에 지워져 실질 순환은 없더라도 `sizing.ts`↔`VuSizingHelper.tsx` 소스-레벨 순환 import 자체를 만들지 않는다(`sizing.ts`의 "React 의존 없음" 불변식을 더 강하게 유지 — spec-plan-reviewer 재검토 지적).
- `const SIZE_PRESET_MULTIPLIERS = [0.5, 1, 2] as const;`
- `export function sizePresetsFor(anchor: { vus: number; durationSeconds: number } | null): { label: string; vus: number; durationSeconds: number }[]` — anchor null이면 `[...ko.loadModel.sizePresets]`(spread 복사, R2 — `ko`가 `as const`라 원본은 readonly tuple), 있으면 배수 순회+클램프+중복 skip+라벨 조립. 라벨의 `·` 구분자는 `ko.ts`의 기존 프리셋 라벨(`"10명 · 30초"`)에서 그 문자를 그대로 복사해 쓴다(재입력 금지 — U+00B7 MIDDLE DOT vs 비슷하게 보이는 다른 코드포인트 오타 함정, 루트 CLAUDE.md 참조).

### 4.3 `components/RunDialog.tsx` — 충족 R: `R5`
- `import { usePriorClosedRunAnchor } from "./VuSizingHelper";` 추가.
- 컴포넌트 상단(다른 데이터 훅과 나란히) `const sizePresetAnchor = usePriorClosedRunAnchor(scenarioId);`.
- `<LoadModelFields ... sizePresetAnchor={sizePresetAnchor} ... />`로 전달(기존 `sizingScenarioId`/`sizingScenario`/`sizingEnv` 전달부 옆).

### 4.4 `components/LoadModelFields.tsx` — 충족 R: `R6, R7`
- `Props`에 `sizePresetAnchor?: ClosedRunAnchor | null;`(RunDialog 전용 optional — 기존 `onApplyVus`류와 동일한 "미전달=ScheduleForm byte-identical" 패턴, §5 참조) 추가 + import.
- 기존 `{ko.loadModel.sizePresets.map((p) => {...})}` 블록을 `{sizePresetsFor(sizePresetAnchor ?? null).map((p) => {...})}`로 교체(내부 JSX·active 판정·onClick 로직은 무변경 — `p.vus`/`p.durationSeconds`/`p.label` 필드명 그대로 재사용).
- 캡션 `<p>{ko.loadModel.sizePresetsCaption}</p>` → `sizePresetAnchor`가 있으면 `ko.loadModel.sizePresetsCaptionFromPrior(sizePresetAnchor.vus, formatDurationKo(sizePresetAnchor.durationSeconds))`, 없으면 기존 문자열.

### 4.5 `i18n/ko.ts` — 충족 R: `R7`
- `ko.loadModel`에 함수 키 `sizePresetsCaptionFromPrior: (vus: number, durationLabel: string) => string` 추가(예: `` `직전 run(${vus}명 · ${durationLabel}) 기준입니다` ``). 기존 `sizePresetsCaption`/`sizePresets` 배열은 무변경(R2 폴백이 그대로 참조).

### 4.6 `components/__tests__/RunDialog.test.tsx` — 충족 R: `R8, R10`
- `vi.mock("../VuSizingHelper", () => ({ VuSizingHelper: () => null }))` →
  ```ts
  vi.mock("../VuSizingHelper", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../VuSizingHelper")>()),
    VuSizingHelper: () => null,
  }));
  ```
- 신규 `it`: `fetchMock`을 URL 라우팅(`.../runs` → 완료 closed run 1건 vus=20,duration_seconds=60 / `.../report` → `summary.rps=10`)으로 세팅 후 칩 라벨 3개(`"10명 · 30초"`/`"20명 · 1분"`/`"40명 · 2분"`)와 캡션 렌더 확인.

---

## 5. 무변경 / 불변식 (명시)

- **엔진/proto/migration/controller 전부 무변경** — 이 슬라이스는 `ui/` 프레젠테이션 계산뿐, 제출 payload에 영향 없음(`setVus`/`setDuration` 호출 시그니처 무변경 — R6).
- **`ScheduleForm.tsx`는 무변경, byte-identical** — `sizePresetAnchor`를 전달하지 않으므로 `LoadModelFields`에서 `undefined ?? null` → `sizePresetsFor(null)` → 기존 고정 3개 칩 그대로(R2/R6, 기존 R12 "additive optional prop" 패턴 반복).
- **`LoadModelFields.test.tsx`는 0-diff**(R9) — 이 설계의 성립 조건이자 회귀 가드.
- **VuSizingHelper의 기존 동작(캡션 "이전 run 기준" 등) byte-identical** — `usePriorClosedRunAnchor` 반환에 필드 하나(`durationSeconds`)만 추가, 기존 소비 코드는 그 필드를 안 읽음. 정확히는 "동작 byte-identical, 소스는 `export` 키워드 + eslint-disable 주석 + 추가 필드 3곳만 diff"(R11 — 완전한 0-diff가 아님을 명시).

---

## 6. 테스트 / 검증

| R-id | 검증 방법 (테스트명 / 관찰) | 라이브? |
|---|---|---|
| R1 | `VuSizingHelper.test.tsx` 기존 스위트 무변경 통과 | |
| R2 | `sizing.test.ts`(신규 또는 기존 파일에 추가) `sizePresetsFor(null)` deep-equal 고정폴백 | |
| R3 | `sizePresetsFor({vus:20,durationSeconds:60})` → 3라벨 정확값 단언 | |
| R4 | `sizePresetsFor({vus:1,durationSeconds:1})` → 길이 2, 중복 없음 | |
| R5 | `LoadModelFields.tsx` grep에 query-hook import 없음 | |
| R6 | `LoadModelFields.test.tsx` 기존 "closed 모드 chips" 케이스 무변경 통과 | |
| R7 | 캡션 분기 2케이스(anchor 있음/없음) RTL 텍스트 단언 | |
| R8 | `RunDialog.test.tsx` **전체**(신규 제외) 무변경 green — targeted 아닌 전체 1회 필수(S-D 급 교훈, ui/CLAUDE.md) | |
| R9 | `git diff --stat -- ui/src/components/__tests__/LoadModelFields.test.tsx` 출력 없음 | |
| R10 | 신규 RTL 케이스 1개 green | |
| R11 | `pnpm lint`(`--max-warnings=0`) 0 warning | |

- **라이브 검증 불요**: run-생성 payload·리포트 파싱 경로 무접촉(UI 프레젠테이션 계산만, spec §6 기준으로 S-D 갭 구조적 부재) — `finish-slice` §5 "production diff 0 아니지만 run-생성/report-파싱/엔진 경로 무접촉" 근거로 생략.
- **머지 전 필수**: `pnpm lint && pnpm test && pnpm build`(인자 없는 전체 `pnpm test` — targeted-green≠full-green 함정, ui/CLAUDE.md). 전체 `pnpm test`는 `ScenarioRunsPage.test.tsx`도 포함하는데, 이 페이지는 실제 `RunDialog`를 렌더하고(module mock 없음) `QueryClientProvider`로 감싸져 있어 새 `usePriorClosedRunAnchor` 호출이 무해하게 통과할 것으로 예상되나(reviewer 분석: `useScenarioRuns` 쿼리키 공유+URL-라우팅 fetchMock이라 저위험) — 전체 스위트 1회로 이 페이지도 함께 확인됨을 명시.

---

## 7. 의도적 연기 (roadmap §B에 누적)

- **open-loop 프리셋 칩**: 현재도 없음(칩은 closed+fixed 전용). open-loop은 `target_rps`/`max_in_flight` 자체가 슬롯/RPS 사이징 헬퍼(`SlotSizingHelper`)를 이미 갖고 있어 별도 칩 불필요 — 이번에 추가 안 함.
- **duration 단독 배수 조정 UI**: VU와 독립적으로 duration만 배수 슬라이더 등으로 조정하는 기능. 이번엔 항상 VU와 짝지어 스케일(§3.3).
- **다른 시나리오의 run 히스토리 참조**("비슷한 시나리오" 추천): 범위 밖 — 앵커는 항상 *이* 시나리오의 직전 run만.
- **`WorkerCountHint`/`SlotSizingHelper` 등 다른 헬퍼로 앵커 확산**: 이번은 크기 칩 한정, 다른 헬퍼는 각자의 기존 앵커/추정 로직 유지.

---

## 8. 구현 순서 (plan 입력)

1. **4.1+4.2 (계약 없는 순수 로직)**: `tdd-guard`가 pending test 파일 없이 첫 `ui/src` 비-테스트 편집을 막으므로 **`sizing.test.ts`(RED, `sizePresetsFor`/확장된 anchor 타입 대상)를 먼저 쓴 뒤** `VuSizingHelper.tsx` export+타입 확장(+R11 eslint-disable) → `sizing.ts::sizePresetsFor` 구현으로 GREEN. 이 커밋만으로 기존 동작 무변화(아직 아무도 `sizePresetsFor`를 호출 안 함) — green 확인 후 다음.
2. **4.5 (ko.ts)**: 신규 캡션 함수 키 추가(단독 커밋 가능, 사용처 없어도 무해).
3. **4.4 (LoadModelFields)**: prop 추가 + 칩/캡션 로직 교체. `LoadModelFields.test.tsx` 무변경 확인(R9 — 이 시점에 이미 확인 가능, RunDialog 연결 전).
4. **4.3+4.6 (RunDialog 연결 + 테스트 모킹 수정)**: hook 호출·prop 전달 + **R8 mock 수정을 반드시 같은 커밋에 포함**(안 그러면 이 커밋 자체가 RunDialog 스위트를 깨뜨린 상태로 남는다) + 신규 R10 테스트.
5. 전체 `pnpm lint && pnpm test && pnpm build` 1회(인자 없이) 확인 후 완료.
