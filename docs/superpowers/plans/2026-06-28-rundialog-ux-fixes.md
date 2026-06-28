# RunDialog UX 버그·예상-밖 동작 수정 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RunDialog의 5개 UX 버그/어색함(프리셋 드롭다운 줄바꿈·미반영, 부하모델 타일 HelpTip 위치, 고정 "추천" 프레이밍, 측정 HelpTip 중복, sticky footer 여백)을 고친다.

**Architecture:** 전부 UI-only. 폼 state·`buildProfile()` 출력·POST payload는 byte-identical. 1b는 `loadedPresetId`를 *클리어하지 않고* render-derived 비교(`presetSnapshotKey`)로 드롭다운 표시만 도출(rename/delete 버튼 보존). 부하모델 타일은 `button[role=radio]`에서 `div + sr-only native radio + stretched label(after:content-[''])`로 재구성해 HelpTip을 제목 옆·테두리 안으로 옮긴다. "추천" 프레이밍은 `showRecommended` prop 제거 + 칩 중립 라벨로 되돌린다.

**Tech Stack:** React 18 + TypeScript(strict) + Tailwind v3 + Vitest/RTL. 게이트 = `cd ui && pnpm lint && pnpm test && pnpm build`.

## Global Constraints

- **UI-only, payload·wire byte-identical**: `crates/**`·proto·migration·`ui/src/scenario/schemas.ts` **0-diff**. `buildProfile()` 출력 불변 — 칩 vus/duration 값(10/30·50/60·200/180) 불변.
- **ScheduleForm byte-identical (R12)**: 변경은 `loadModelTiles` 분기(RunDialog 전용)·RunDialog-전용 prop 한정. `ScheduleForm.tsx`·`Field.tsx`·`Badge.tsx`·`HelpTip.tsx`·`Segmented.tsx`·공유 `INPUT` 상수 **0-diff**. `showRecommended`는 RunDialog 전용 prop이라 제거해도 ScheduleForm 무영향.
- **a11y**: 부하모델 옵션은 role=radio·같은 `name="load-model"` 그룹·키보드 이동 가능, accessible name = **제목만**(HelpTip이 accname 오염 금지, U3), 선택은 네이티브 `checked`.
- **ko.ts 경유 (ADR-0035)**: 모든 사용자노출 문구·aria-label은 `ko.ts` 카탈로그. 영어/인라인 한국어 하드코딩 금지.
- **TDD 순서 (tdd-guard, ui/CLAUDE.md)**: 각 task에서 **테스트 파일을 먼저 편집**해 pending diff를 만든 뒤 src 편집(안 그러면 첫 src 편집이 `[tdd-guard] Blocked`).
- **게이트 함정**: 커밋은 파이프(`| tail`) 금지(git-guard·exit code 마스킹). `pnpm test`(esbuild)는 통과해도 `pnpm build`(`tsc -b`)·`pnpm lint`(`--max-warnings=0`)가 잡는 클래스(removed-prop·exhaustive-deps·nested-default 누출)가 있으니 **세 게이트 전부** 통과해야 커밋.

---

## File Structure

| 파일 | 책임 | 건드리는 Task |
|---|---|---|
| `ui/src/components/RunDialog.tsx` | 프리셋 드롭다운(1a·1b)·측정 HelpTip(④)·footer(⑤)·showRecommended 호출 제거(③) | 1, 3, 4, 5 |
| `ui/src/components/LoadModelFields.tsx` | 부하모델 타일 재구성(②)·칩 relabel·추천 제거(③) | 2, 3 |
| `ui/src/i18n/ko.ts` | `sizePresets`/`sizePresetsLabel`/`recommendedNotice` 수정 + `sizePresetsCaption`·`measureHelp` 신규 | 3, 4 |
| `ui/src/components/__tests__/RunDialog.test.tsx` | 1a·1b·④·⑤ 테스트 + 추천 안내 문구 갱신 | 1, 3, 4, 5 |
| `ui/src/components/__tests__/LoadModelFields.test.tsx` | 타일 테스트 갱신(②)·칩 라벨 갱신·B4 제거(③) | 2, 3 |
| `ui/src/components/__tests__/ScheduleForm.test.tsx` | 추천 안내 부재 단언 문구 갱신(③) | 3 |

**Task 순서**: 1 → 2 → 3 → 4 → 5 (순차·각 독립 green 커밋). 병렬 충돌 없음(같은 파일을 순차 편집).

---

## Task 1: 프리셋 드롭다운 — 줄바꿈 방지(1a) + 선택 반영/수정 시 표시 복귀(1b)

**Files:**
- Modify: `ui/src/components/RunDialog.tsx` (import 줄 1; `loadedPresetId` 인근 :196; `loadPreset` :211-287; `savePreset`/`renamePreset` onSuccess :490/:496/:514; `currentInput` 인근 render 본문 :456-534; 프리셋 `<label>`/`<Select>` :556-573)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:**
- Consumes: 기존 `buildProfile(): Profile` (:456), `loadedPresetId`/`setLoadedPresetId` (:196), `loadPreset(id)` (:211), `savePreset`/`renamePreset` (:476/:505).
- Produces: 신규 state `presetSnapshotKey: string`/`presetLoadTick: number`, 신규 ref `keyRef`, render-local `currentProfileKey: string`. (다른 task 미참조 — Task 1 내부 한정.)

**메커니즘 (spec §3.1):** `loadedPresetId`는 **클리어하지 않는다**(이름변경/삭제 버튼 게이트 :890 + `renamePreset`/`removePreset` 대상 보존). 드롭다운 값은 `loadedPresetId && currentProfileKey === presetSnapshotKey ? loadedPresetId : ""`로 매 렌더 도출. 스냅샷은 load(및 save/rename 성공)가 commit된 *뒤* effect에서 캡처 — `presetLoadTick`을 dep로, 키는 매 렌더 갱신되는 `keyRef`로 읽어 `exhaustive-deps`를 회피한다(`currentProfileKey`를 dep에 넣으면 매 수정마다 재캡처돼 드롭다운이 영영 복귀 안 함 — 금지).

- [ ] **Step 1: 실패 테스트 작성** — ⚠️ **반드시 기존 `describe("RunDialog — save/manage preset (A2)")` 블록(현 :532-672) *안에*** 아래 3개 `it`을 추가한다(예: rename 테스트 :646-672 바로 뒤). 이유: 이 테스트들이 쓰는 `mockPresets`(:533)·`renderDialog`(:595)는 그 describe **안에 스코프**돼 있다 — 새 top-level describe에 넣으면 `mockPresets`가 `ReferenceError`(모듈 스코프엔 없음)이고 `renderDialog`는 시그니처 다른 모듈-스코프 :44로 잘못 resolve된다(플랜 리뷰 IMPORTANT). `toDetailed`(:66)·`waitFor`(import 줄 1)·`userEvent`는 이미 접근 가능. ⚠️ **`ko`는 이 파일에 import돼 있지 않다**(플랜 리뷰 — 현 `ko.` 6곳은 전부 *주석*) → 아래 import를 파일 상단 import 블록에 추가. Task 4도 같은 파일에서 `ko`를 쓰므로 이 import 하나가 둘 다 커버(Task 4에선 재추가 금지). `setNativeValue` 헬퍼는 **모듈 스코프**(파일 상단, `renderDialog` :44 근처)에 1회 추가.

먼저 파일 상단 import에 `ko` 추가:
```tsx
import { ko } from "../../i18n/ko";
```

그리고 모듈 스코프에 헬퍼 추가(이미 있으면 생략):
```tsx
function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
```

그리고 `describe("RunDialog — save/manage preset (A2)")` **안에** 3개 추가(이 describe의 `renderDialog`는 no-arg·`hasLoop={false}`·`scenario={null}`; `mockPresets`의 GET `/api/presets/P1`는 `profile:{vus:1,duration_seconds:1,...}` = closed+fixed 반환 → 로드 후 간단 모드 유지·vus 입력 노출):
```tsx
  it("1a: 프리셋 불러오기 라벨은 줄바꿈 방지 클래스를 가진다", () => {
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    const label = screen.getByText("프리셋 불러오기");
    expect(label).toHaveClass("shrink-0");
    expect(label).toHaveClass("whitespace-nowrap");
  });

  it("1b: 프리셋을 불러오면 드롭다운에 표시되고, 폼을 수정하면 — 선택 —으로 복귀한다", async () => {
    const user = userEvent.setup();
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    const select = (await screen.findByLabelText("프리셋 불러오기")) as HTMLSelectElement;
    await user.selectOptions(select, "P1");
    // 스냅샷은 post-paint effect에서 잡힘 → 비동기 단언
    await waitFor(() => expect(select.value).toBe("P1"));
    // 부하 폼 수정(VU) → 드롭다운이 "" (— 선택 —)로 복귀.
    // 정확-문자열 getByLabelText(ko.loadModel.vus="동시 사용자(VU)")는 타일 라벨("동시 사용자 (VU)", 공백)과
    // 정확매치 안 되므로 충돌 없음(Task 2 충돌은 *regex* getByLabelText만 해당).
    const vu = screen.getByLabelText(ko.loadModel.vus) as HTMLInputElement;
    setNativeValue(vu, "999");
    await waitFor(() => expect(select.value).toBe(""));
  });

  it("1b 회귀가드: 불러온 뒤 폼을 수정해도 이름 변경/프리셋 삭제 버튼이 남는다 (loadedPresetId 미클리어)", async () => {
    const user = userEvent.setup();
    mockPresets([{ id: "P1", name: "loadme" }]);
    renderDialog();
    await toDetailed(user); // 이름변경/삭제 버튼은 상세-only 저장 섹션
    await user.selectOptions(await screen.findByLabelText("프리셋 불러오기"), "P1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument(),
    );
    const vu = screen.getByLabelText(ko.loadModel.vus) as HTMLInputElement;
    setNativeValue(vu, "999");
    // 수정 후에도 버튼 잔존
    expect(screen.getByRole("button", { name: "이름 변경" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "프리셋 삭제" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: 새 3개 FAIL — 1a는 라벨에 클래스 없음, 1b는 드롭다운이 항상 ""(현재 `value=""` 하드코딩).

- [ ] **Step 3: import에 `useRef` 추가** — `ui/src/components/RunDialog.tsx:1`

```tsx
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
```

- [ ] **Step 4: 1b state·ref·effect 추가** — `loadedPresetId` state 선언(:196) 바로 아래에 추가:

```tsx
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  // 1b: 드롭다운 표시는 render-derived (loadedPresetId 미클리어 — rename/delete 보존).
  const [presetSnapshotKey, setPresetSnapshotKey] = useState<string>("");
  const [presetLoadTick, setPresetLoadTick] = useState(0);
```

`buildProfile`/`currentInput` 정의(:456-474) 뒤, render `return` 전(예: `eyebrowCls` 선언 :533 인근)에 추가:

```tsx
  // 1b: 현재 폼의 정규화 키 + latest-value ref (effect가 ref로 읽어 exhaustive-deps 회피).
  const currentProfileKey = JSON.stringify(buildProfile());
  const keyRef = useRef(currentProfileKey);
  keyRef.current = currentProfileKey;
  // load/save/rename이 commit된 뒤 그 시점 폼으로 스냅샷 캡처(단일 발화).
  // currentProfileKey를 dep에 넣지 말 것 — 매 수정마다 재캡처돼 드롭다운이 복귀 안 함.
  useEffect(() => {
    setPresetSnapshotKey(keyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetLoadTick]);
```

- [ ] **Step 5: loadPreset이 commit 끝에 tick bump** — `loadPreset`의 `setPresetName(p.name);`(:283) 바로 다음 줄에 추가:

```tsx
      setLoadedPresetId(id);
      setPresetName(p.name);
      setPresetLoadTick((t) => t + 1); // 1b: commit 후 스냅샷 재캡처 트리거
```

- [ ] **Step 6: save/rename 성공 시에도 스냅샷 재캡처** — 세 onSuccess에 tick bump 추가(spec §3.1, removePreset은 loadedPresetId=null이라 제외):

`savePreset` 덮어쓰기(:490) 와 생성(:496):

```tsx
          onSuccess: () => {
            setLoadedPresetId(existing.id);
            setPresetLoadTick((t) => t + 1);
          },
```
```tsx
        onSuccess: (p) => {
          setLoadedPresetId(p.id);
          setPresetLoadTick((t) => t + 1);
        },
```

`renamePreset`(:514):

```tsx
        onSuccess: () => {
          setPresetName(next);
          setPresetLoadTick((t) => t + 1);
        },
```

- [ ] **Step 7: 프리셋 `<label>` 줄바꿈 방지(1a) + `<Select>` 값 도출(1b)** — `ui/src/components/RunDialog.tsx:556-562`

라벨(:556):
```tsx
          <label className="text-sm text-slate-600 shrink-0 whitespace-nowrap" htmlFor="load-preset">
            프리셋 불러오기
          </label>
```

Select value(:562) — `value=""`를 도출식으로:
```tsx
            value={loadedPresetId && currentProfileKey === presetSnapshotKey ? loadedPresetId : ""}
```

- [ ] **Step 8: 테스트 통과 확인 + 전체 게이트**

Run: `cd ui && pnpm test RunDialog`
Expected: 새 3개 PASS. 이어서 기존 rename 테스트(:646)도 PASS(버튼은 loadedPresetId로 즉시 노출).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS(특히 `pnpm lint`가 exhaustive-deps 무경고 — disable 주석 정당).

- [ ] **Step 9: 커밋**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "fix(rundialog): 프리셋 드롭다운 줄바꿈 방지 + 선택 반영/수정 시 표시 복귀 (render-derived, loadedPresetId 미클리어)"
```

---

## Task 2: 부하모델 타일 HelpTip — 제목 옆·테두리 안 (div + native radio + stretched label)

**Files:**
- Modify: `ui/src/components/LoadModelFields.tsx` (`ids` 객체 :103-110에 라디오 id 2개 추가; `loadModelTiles` 분기 타일 2개 :294-345 재구성)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx` (타일 테스트 :414-428)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx` (⚠️ 라벨 충돌 sweep — 14곳, 아래 Step 1a)

**Interfaces:**
- Consumes: `loadModel`/`setLoadModel`, `ko.loadModel.tileClosedTitle`/`tileOpenTitle`/`tileClosedDesc`/`tileOpenDesc`, `ko.glossary.closedLoop`/`openLoop`, `HelpTip`.
- Produces: 변경 없음(시그니처 동일). 타일은 여전히 `role=radio`·`name="load-model"` 그룹.

**범위:** `loadModelTiles === true` 분기(:290-345)만. `!loadModelTiles` 라디오 분기·프로파일 Segmented(:388-402)는 **0-diff**.

**HelpTip 배치 — spec §3.2 보정:** `HelpTip`은 `className` prop이 없다(`{label, children}` only). spec의 `<HelpTip className="relative z-10">`는 불가 → **HelpTip을 `<span className="relative z-10">`로 감싸** stretched-label의 `::after` 오버레이 위로 올린다(HelpTip.tsx **0-diff** 유지).

> ⚠️ **CRITICAL 선행 (플랜 리뷰)**: 타일을 native `<input type=radio>` + `<label htmlFor>`로 바꾸면 라디오의 **접근명**이 `"동시 사용자 (VU)"`/`"목표 RPS"`가 된다. 이 문자열이 vus 필드 라벨 `ko.loadModel.vus`="동시 사용자(VU)"·targetRps 라벨 "목표 RPS"와 **regex `getByLabelText`로 충돌**한다(현재 타일은 label-less `<button>`이라 안 걸렸음). RunDialog는 `loadModelTiles`를 항상 전달(:620)하므로, RunDialog.test.tsx의 `getByLabelText(/동시 사용자/)`·`getByLabelText(/목표 RPS/i)` **14곳**(:506·744·1062·1071·1110·1113·1129·1298·1299·2124·2414·2506·2784·2928)이 "multiple elements"로 깨진다. **Step 1a에서 먼저 role-scope로 전환**해야 Task 2가 자기 게이트(full `pnpm test`)를 통과한다. `getByRole("spinbutton",…)`은 숫자 입력만 잡고 라디오를 제외하므로, 이 sweep은 src 변경 *전/후* 모두 green(준비 리팩터). 정확-문자열 `getByLabelText(ko.loadModel.vus)`·`getByRole("radio",{name})`은 무관(LoadModelFields.test :95/:103은 라디오 모드라 무충돌).

- [ ] **Step 1a: RunDialog.test.tsx 라벨 충돌 sweep (src 변경 전·green 유지)** — 14곳을 `getByLabelText`→`getByRole("spinbutton")`로 전환. 정확 치환 2종:
  - `screen.getByLabelText(/동시 사용자/)` → `screen.getByRole("spinbutton", { name: /동시 사용자/ })` (:506·744·1129·2124·2784)
  - `screen.getByLabelText(/동시 사용자/i)` → `screen.getByRole("spinbutton", { name: /동시 사용자/i })` (:2928)
  - `screen.getByLabelText(/목표 RPS/i)` → `screen.getByRole("spinbutton", { name: /목표 RPS/i })` (:1062·1071·1110·1113·1298·1299·2414·2506)

  변환 후 즉시 확인:
  Run: `grep -n "getByLabelText(/동시 사용자\|getByLabelText(/목표 RPS" ui/src/components/__tests__/RunDialog.test.tsx`
  Expected: **0건**(모두 spinbutton으로 전환).
  Run: `cd ui && pnpm test RunDialog`
  Expected: PASS(아직 src 미변경 — spinbutton은 숫자 입력을 그대로 잡으므로 회귀 없음).

- [ ] **Step 1: 실패 테스트 작성** — `ui/src/components/__tests__/LoadModelFields.test.tsx`의 타일 테스트(:414-428)를 새 구조에 맞게 갱신 + HelpTip 존재 단언 추가. accent 클래스는 이제 라디오가 아니라 *컨테이너 div*에 있으므로 `closest("div")`로 잡는다.

`it("loadModelTiles renders load-model as role=radio tiles inside the fieldset, name preserved", ...)`(:414-420)에 HelpTip 단언 추가:
```tsx
  it("loadModelTiles renders load-model as role=radio tiles inside the fieldset, name preserved", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    const group = screen.getByRole("group", { name: /부하 모델/i });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ })).toBeInTheDocument();
    expect(screen.getByText(ko.loadModel.tileClosedDesc)).toBeInTheDocument();
    // ②: HelpTip이 제목 옆·테두리 안 (closed/open 각각)
    expect(screen.getByRole("button", { name: "closed-loop 설명" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "open-loop 설명" })).toBeInTheDocument();
  });
```

`it("선택 타일에 accent 클래스, 비선택엔 부재 (R1) + teeth", ...)`(:422-428)를 컨테이너 기준으로:
```tsx
  it("선택 타일에 accent 클래스, 비선택엔 부재 (R1) + teeth", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    const closed = screen.getByRole("radio", { name: /동시 사용자 \(VU\)/ }).closest("div")!;
    const open = screen.getByRole("radio", { name: /목표 RPS/ }).closest("div")!;
    expect(closed).toHaveClass("border-accent-500"); // 선택
    expect(open).not.toHaveClass("border-accent-500"); // 비선택 (teeth: 선택을 open으로 뒤집으면 FAIL)
  });
```

추가 — accessible name이 *제목만*(HelpTip 비오염, U3) 확인하는 teeth:
```tsx
  it("타일 라디오 accessible name은 제목만 (HelpTip 비오염, U3)", () => {
    setup({ loadModelTiles: true, loadModel: "closed" });
    // 정확매치: 설명/HelpTip 라벨이 섞이면 실패
    expect(screen.getByRole("radio", { name: "동시 사용자 (VU)" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "목표 RPS" })).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test LoadModelFields`
Expected: 갱신된/신규 타일 테스트 FAIL — accent가 아직 radio(button)에 있고 `closest("div")` 컨테이너엔 없음; HelpTip 라벨은 현재도 있으나 accname 정확매치는 현 button 콘텐츠(제목+설명)라 FAIL.

- [ ] **Step 3: `ids`에 라디오 id 2개 추가** — `ui/src/components/LoadModelFields.tsx:103` `ids` 객체에 추가:

```tsx
  const ids = {
    vus: useId(),
    durationClosed: useId(),
    rampUp: useId(),
    targetRps: useId(),
    durationOpen: useId(),
    maxInFlight: useId(),
    workerCount: useId(),
    loadModelClosed: useId(),
    loadModelOpen: useId(),
```
(기존 항목은 그대로 두고 두 줄만 끝에 추가 — 닫는 `};` 위.)

- [ ] **Step 4: 타일 2개 재구성** — `ui/src/components/LoadModelFields.tsx:294-345`(`loadModelTiles ? (` 안의 `<div className="grid grid-cols-2 gap-3">…</div>`)를 통째로 교체:

```tsx
          <div className="grid grid-cols-2 gap-3">
            {/* closed 타일 — div + sr-only native radio + stretched label(after:content-[''])
               HelpTip은 제목 옆 형제(라벨 밖)라 accname 비오염, relative z-10 래퍼로 오버레이 위. */}
            <div
              className={`relative flex items-start gap-3 rounded-lg border p-3 ${
                loadModel === "closed"
                  ? "border-accent-500 bg-accent-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="load-model"
                id={ids.loadModelClosed}
                className="sr-only"
                checked={loadModel === "closed"}
                onChange={() => setLoadModel("closed")}
              />
              <span
                aria-hidden="true"
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
                  loadModel === "closed" ? "border-accent-500 bg-accent-500" : "border-slate-300"
                }`}
              />
              <span className="flex flex-col min-w-0">
                <span className="flex items-center gap-1">
                  <label
                    htmlFor={ids.loadModelClosed}
                    className="font-semibold cursor-pointer after:content-[''] after:absolute after:inset-0"
                  >
                    {ko.loadModel.tileClosedTitle}
                  </label>
                  <span className="relative z-10">
                    <HelpTip label="closed-loop 설명">{ko.glossary.closedLoop}</HelpTip>
                  </span>
                </span>
                <span className="text-xs text-slate-500">{ko.loadModel.tileClosedDesc}</span>
              </span>
            </div>
            {/* open 타일 */}
            <div
              className={`relative flex items-start gap-3 rounded-lg border p-3 ${
                loadModel === "open"
                  ? "border-accent-500 bg-accent-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="load-model"
                id={ids.loadModelOpen}
                className="sr-only"
                checked={loadModel === "open"}
                onChange={() => setLoadModel("open")}
              />
              <span
                aria-hidden="true"
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ${
                  loadModel === "open" ? "border-accent-500 bg-accent-500" : "border-slate-300"
                }`}
              />
              <span className="flex flex-col min-w-0">
                <span className="flex items-center gap-1">
                  <label
                    htmlFor={ids.loadModelOpen}
                    className="font-semibold cursor-pointer after:content-[''] after:absolute after:inset-0"
                  >
                    {ko.loadModel.tileOpenTitle}
                  </label>
                  <span className="relative z-10">
                    <HelpTip label="open-loop 설명">{ko.glossary.openLoop}</HelpTip>
                  </span>
                </span>
                <span className="text-xs text-slate-500">{ko.loadModel.tileOpenDesc}</span>
              </span>
            </div>
          </div>
```

- [ ] **Step 5: 테스트 통과 확인 + 전체 게이트**

Run: `cd ui && pnpm test LoadModelFields`
Expected: 타일 테스트 PASS(accent는 컨테이너 div, accname=제목만, HelpTip 존재).
Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/components/LoadModelFields.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "fix(rundialog): 부하모델 타일 HelpTip을 제목 옆·테두리 안으로 (native radio + stretched label)"
```

---

## Task 3: 고정 "추천" 프레이밍 제거 — 빠른-입력 칩 relabel + 추천 배지/안내문 제거

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`recommendedNotice` :101; `sizePresetsLabel` :190; `sizePresets` :191-195; 신규 `sizePresetsCaption`)
- Modify: `ui/src/components/LoadModelFields.tsx` (칩 :481-511; `showRecommended` Props :57-58·destructure :98·4 Field props :517/:532/:686/:704)
- Modify: `ui/src/components/RunDialog.tsx` (LoadModelFields 호출의 `showRecommended` :618 제거)
- Test: `ui/src/components/__tests__/LoadModelFields.test.tsx`(칩 :120-143·B4 :365-380), `ui/src/components/__tests__/RunDialog.test.tsx`(:213-215), `ui/src/components/__tests__/ScheduleForm.test.tsx`(:160)

**Interfaces:**
- Consumes: `ko.loadModel.sizePresets`(`{label,vus,durationSeconds}` — `hint` 제거됨), `ko.loadModel.sizePresetsLabel`/`sizePresetsCaption`, `ko.runDialog.recommendedNotice`.
- Produces: `Props`에서 `showRecommended` 제거(LoadModelFields). `sizePresets` 항목 타입에서 `hint` 제거.

> **payload 불변**: 칩 vus/duration 값(10/30·50/60·200/180) 그대로 → 클릭 시 동일 `setVus`/`setDuration` → POST byte-identical.

- [ ] **Step 1: 실패 테스트 작성/갱신** — 4개 테스트 파일을 먼저 수정해 pending diff 생성.

(a) `LoadModelFields.test.tsx` 칩 테스트(:120-143) — 새 중립 라벨·그룹명으로(드리프트 회피 위해 ko 카탈로그 직접 참조):
```tsx
  it("closed 모드에서 빠른 입력 chips가 보이고 클릭하면 VU·시간을 채운다", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByRole("group", { name: ko.loadModel.sizePresetsLabel })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ko.loadModel.sizePresets[1].label }));
    expect(props.setVus).toHaveBeenCalledWith(50);
    expect(props.setDuration).toHaveBeenCalledWith(60);
  });

  it("open 모드에선 빠른 입력 chips가 없다", () => {
    setup({ loadModel: "open" });
    expect(screen.queryByRole("group", { name: ko.loadModel.sizePresetsLabel })).toBeNull();
  });

  it("현재 VU·시간이 프리셋과 일치하면 해당 chip이 눌린 상태(aria-pressed)다", () => {
    setup({ vus: 10, duration: 30 });
    expect(
      screen.getByRole("button", { name: ko.loadModel.sizePresets[0].label }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: ko.loadModel.sizePresets[1].label }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("VU만 일치하고 시간이 다르면 chip이 눌리지 않는다", () => {
    setup({ vus: 10, duration: 60 });
    expect(
      screen.getByRole("button", { name: ko.loadModel.sizePresets[0].label }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("빠른 입력 캡션과 중립 라벨 (가볍게/보통/세게 부재)", () => {
    setup();
    expect(screen.getByText(ko.loadModel.sizePresetsCaption)).toBeInTheDocument();
    expect(screen.queryByText("가볍게")).not.toBeInTheDocument();
    expect(screen.queryByText("보통")).not.toBeInTheDocument();
    expect(screen.queryByText("세게")).not.toBeInTheDocument();
  });
```

또한 같은 파일 **:154**(closed+curve 테스트, 위 :120-143 범위 밖)의 `queryByRole("group", { name: /부하 크기 프리셋/ })`를 `/빠른 입력/`로 갱신 — 안 그러면 그룹명 rename 후 regex가 아무것도 안 잡아 "곡선 모드에서 칩 숨김" 가드가 **vacuously true**로 조용히 은퇴한다(ui/CLAUDE.md 은퇴-라벨 vacuous 트랩; Step 7 grep은 키명만 봐서 이 한국어 문자열을 못 잡음):
```tsx
    expect(screen.queryByRole("group", { name: /빠른 입력/ })).not.toBeInTheDocument();
```

(b) `LoadModelFields.test.tsx` B4 블록(:365-380) — `it.each`(:371-380, 제거되는 prop 전달)를 **삭제**하고 첫 테스트(:366)를 prop-없는 부재 단언으로 유지(이름만 정리):
```tsx
  // ③: '추천' Badge는 더 이상 렌더하지 않는다 (showRecommended prop 제거)
  it("'추천' Badge 미렌더 (closed+fixed)", () => {
    renderFields();
    expect(screen.queryByText("추천")).not.toBeInTheDocument();
  });
  it("'추천' Badge 미렌더 (open+fixed)", () => {
    renderFields({ loadModel: "open", rateMode: "fixed" });
    expect(screen.queryByText("추천")).not.toBeInTheDocument();
  });
```

(c) `RunDialog.test.tsx`(:213-215) — 추천 안내 문구를 새 값으로:
```tsx
  it("부하 섹션 상단에 기본값 안내를 보인다", () => {
    renderDialog();
    expect(
      screen.getByText("기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요."),
    ).toBeInTheDocument();
  });
```

(d) `ScheduleForm.test.tsx`(:160) — 부재 단언을 새 문구로(정확성):
```tsx
    expect(
      screen.queryByText("기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요."),
    ).not.toBeInTheDocument();
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test LoadModelFields RunDialog ScheduleForm`
Expected: 위 변경분 FAIL(새 라벨/캡션 미존재, 추천 문구 미변경; B4 it.each 제거로 그 테스트 사라짐).

- [ ] **Step 3: ko.ts 카탈로그 수정** — `ui/src/i18n/ko.ts`

`recommendedNotice`(:101):
```tsx
    recommendedNotice: "기본값이 채워져 있어 바로 실행할 수 있습니다 — 대상에 맞게 조정하세요.",
```

`sizePresetsLabel`/`sizePresets`(:190-195) — 라벨을 중립 숫자로, `hint` 제거, 그 아래 캡션 키 추가:
```tsx
    sizePresetsLabel: "빠른 입력",
    sizePresetsCaption: "대상 시스템에 맞게 조정하세요",
    sizePresets: [
      { label: "10명 · 30초", vus: 10, durationSeconds: 30 },
      { label: "50명 · 1분", vus: 50, durationSeconds: 60 },
      { label: "200명 · 3분", vus: 200, durationSeconds: 180 },
    ],
```

- [ ] **Step 4: 칩 렌더 — hint 제거 + 캡션 추가** — `ui/src/components/LoadModelFields.tsx:481-511`

칩 버튼 본문의 `hint` span 제거(`{p.label}` 만):
```tsx
            <div
              role="group"
              aria-label={ko.loadModel.sizePresetsLabel}
              className="mb-2 flex flex-wrap gap-2"
            >
              {ko.loadModel.sizePresets.map((p) => {
                const active = vus === p.vus && duration === p.durationSeconds;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setVus(p.vus);
                      setDuration(p.durationSeconds);
                    }}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      active
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="mb-3 text-xs text-slate-500">{ko.loadModel.sizePresetsCaption}</p>
```

- [ ] **Step 5: `showRecommended` prop 제거** — `ui/src/components/LoadModelFields.tsx`

Props(:57-58): `showRecommended?: boolean;` 줄과 그 위 주석 줄 삭제.
구조분해(:98): `showRecommended,` 삭제.
4개 `Field`의 `recommended={showRecommended ? ko.common.recommended : undefined}`(:517·:532·:686·:704) 줄을 **각각 통째로 삭제**(Field의 `recommended`는 optional이라 prop 자체 생략).

- [ ] **Step 6: RunDialog 호출에서 `showRecommended` 제거** — `ui/src/components/RunDialog.tsx:618` `showRecommended` 줄 삭제.

- [ ] **Step 7: 테스트 통과 + 전체 게이트 + 잔존 grep**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS. (`showRecommended` 제거 후 `tsc -b`가 removed-prop 미참조 확인; `ko.common.recommended`는 미사용으로 남지만 lint는 카탈로그 미사용 속성을 flag 안 함 — spec대로 유지.)
Run(완성도 확인): `grep -rn "showRecommended\|\.hint\|sizePresetsLabel" ui/src/components ui/src/i18n`
Expected: `showRecommended` 0건, `.hint` 0건, `sizePresetsLabel`는 ko.ts 정의 + LoadModelFields aria-label만.

- [ ] **Step 8: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/LoadModelFields.tsx ui/src/components/RunDialog.tsx ui/src/components/__tests__/LoadModelFields.test.tsx ui/src/components/__tests__/RunDialog.test.tsx ui/src/components/__tests__/ScheduleForm.test.tsx
git commit -m "fix(rundialog): 고정 '추천' 프레이밍 제거 — 빠른-입력 칩 중립 라벨 + 추천 배지/안내문 제거"
```

---

## Task 4: 측정 HelpTip 심화 — measureDesc 중복 제거

**Files:**
- Modify: `ui/src/i18n/ko.ts` (`measureDesc` :140 인근에 `measureHelp` 신규 추가)
- Modify: `ui/src/components/RunDialog.tsx:734` (HelpTip body → `measureHelp`)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:**
- Consumes: `ko.runDialog.measureHelp`(신규), 기존 `ko.runDialog.measureDesc`(바깥 한 줄 요약은 유지).

- [ ] **Step 1: 실패 테스트 작성** — `RunDialog.test.tsx` 측정 섹션 테스트에 추가(측정 섹션은 상세 모드). `ko` import는 Task 1에서 이미 추가됨(없으면 `import { ko } from "../../i18n/ko";` 추가):

```tsx
  it("측정 HelpTip은 바깥 요약(measureDesc)보다 심화 내용(measureHelp)을 담는다", async () => {
    const user = userEvent.setup();
    renderDialog();
    await toDetailed(user);
    // HelpTip 버튼 열기 (측정 섹션의 ⓘ — label = measureTitle)
    await user.click(
      screen.getByRole("button", { name: ko.runDialog.measureTitle }),
    );
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("처리량은 더 오르지 않습니다"); // 심화 문구 식별 구절
    expect(note.textContent).not.toBe(ko.runDialog.measureDesc); // 한 줄 요약과 다름
  });
```

> 참고: 측정 토글은 `role="switch"`(:721)라 `getByRole("button", {name: measureTitle})`엔 안 잡힌다 → HelpTip ⓘ `<button>`(HelpTip.tsx:19)만 매치돼 단일 결과. 그대로 클릭하면 된다(다중매치 우려 없음). `findByRole("note")`는 HelpTip popover(`role="note"`, HelpTip.tsx:32)를 정확히 가리킨다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — 현재 HelpTip body가 `measureDesc`라 "처리량은 더 오르지 않습니다" 미포함.

- [ ] **Step 3: ko.ts에 measureHelp 추가** — `ui/src/i18n/ko.ts` `measureDesc`(:140) 바로 다음 줄에:

```tsx
    measureDesc: "응답 시간을 DNS·연결·대기·다운로드로 나눠 측정 — 리포트에서 어디서 느린지 진단",
    measureHelp:
      "응답 시간을 네 단계로 나눕니다 — DNS(주소 조회) → 연결(TCP+TLS 핸드셰이크) → 대기(요청 전송부터 첫 바이트까지 ≈ 서버 처리 시간) → 다운로드(본문 수신). " +
      "keep-alive로 연결을 재사용하면 DNS·연결 비용은 첫 요청에만 들고 그다음 요청은 0입니다. " +
      "각 단계의 퍼센타일은 비가산이라 네 단계의 합이 전체 응답 시간과 다를 수 있습니다. " +
      "서버 자원에 여유가 없으면 VU나 RPS를 올려도 '대기' 단계만 길어지고 처리량은 더 오르지 않습니다 — 이때 단계 분해로 병목이 서버(대기)인지 네트워크(DNS·연결)인지 가려냅니다.",
```

- [ ] **Step 4: HelpTip body 교체** — `ui/src/components/RunDialog.tsx:734`

```tsx
                <HelpTip label={ko.runDialog.measureTitle}>{ko.runDialog.measureHelp}</HelpTip>
```
(바깥 `<span className="text-xs text-slate-500">{ko.runDialog.measureDesc}</span>` :736은 **그대로**.)

- [ ] **Step 5: 테스트 통과 + 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/i18n/ko.ts ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "fix(rundialog): 측정 HelpTip에 심화 내용(measureHelp) — 바깥 요약과 중복 제거"
```

---

## Task 5: Footer sticky 하단 여백

**Files:**
- Modify: `ui/src/components/RunDialog.tsx:1070` (sticky footer div className)
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

**Interfaces:** 없음(클래스만 추가).

- [ ] **Step 1: 실패 테스트 작성** — `RunDialog.test.tsx`. footer 헬퍼(`footer()` :2742 인근, `[class*="sticky"]`)가 있으면 재사용:

```tsx
  it("sticky footer는 하단 여백(pb-*)을 가진다", () => {
    renderDialog();
    const sticky = document.querySelector('[class*="sticky"]') as HTMLElement;
    expect(sticky).toBeTruthy();
    expect(sticky.className).toMatch(/\bpb-\d/);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test RunDialog`
Expected: FAIL — 현재 footer에 `pb-*` 없음.

- [ ] **Step 3: footer에 `pb-3` 추가** — `ui/src/components/RunDialog.tsx:1070`

```tsx
      <div className="sticky bottom-0 bg-white border-t border-slate-200 pt-3 pb-3 mt-3 flex items-center justify-between gap-3">
```
(`pt-3` 뒤에 `pb-3` 추가. 정확한 값은 라이브 스크린샷으로 `pb-2`/`pb-3`/`pb-4` 미세 조정 — 기본 `pb-3`.)

- [ ] **Step 4: 테스트 통과 + 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "fix(rundialog): sticky footer 하단 여백(pb-3) — 실행 버튼과 창 바닥 사이 숨 쉴 공간"
```

---

## 최종 검증 (모든 task 후, finish 전)

- [ ] **전체 게이트 재실행**: `cd ui && pnpm lint && pnpm test && pnpm build` (targeted-green ≠ full-green).
- [ ] **0-diff 불변식 grep**: `git diff master --stat` — 변경 파일이 `ui/src/components/RunDialog.tsx`·`LoadModelFields.tsx`·`ui/src/i18n/ko.ts` + 3 테스트 파일 + docs뿐. `crates/`·`proto`·migration·`ui/src/scenario/schemas.ts`·`ScheduleForm.tsx`·`ui/src/components/ui/Field.tsx`·`Badge.tsx`·`HelpTip.tsx`·`Segmented.tsx` **0-diff** 확인.
- [ ] **handicap-reviewer**(최종 whole-branch 리뷰) APPROVE. 보안 게이트는 N/A 예상(요청실행·템플릿/캐스트·env/데이터셋 바인딩·업로드·trace 미접촉 — `finish-slice §0` grep으로 확인).
- [ ] **라이브 검증**(`/live-verify`, spec §5 권장 — run 생성 경로는 안 건드리지만 시각·동작 회귀가 본질): 워크트리 자체 바이너리(`--rest 8090 --grpc 8091`로 main dev 8080 비침) + responder + Playwright —
  (a) 프리셋 불러오기 → 드롭다운에 이름 표시 → 폼 수정 시 "— 선택 —" 복귀 + 이름 변경/삭제 버튼 잔존,
  (b) 부하모델 HelpTip이 제목 옆·테두리 안 + **타일 카드 빈 영역 클릭 시 선택**(`after:content-['']` 오버레이 실측 — RTL로 불가),
  (c) 빠른-입력 칩(중립 라벨)·"추천" 부재·캡션 존재,
  (d) 측정 HelpTip 심화 내용,
  (e) 스크롤 시 footer 하단 여백,
  (f) closed 1 run 생성 → payload byte-identical.

---

## Self-Review (작성자 체크)

**Spec coverage:** §3.1(1a·1b)=Task 1, §3.2(②)=Task 2, §3.3(③ 칩+추천)=Task 3, §3.4(④)=Task 4, §3.5(⑤)=Task 5. §4 불변식=Global Constraints + 최종 grep. §5 테스트=각 Task Step 1 + 기존 테스트 갱신(B4 제거·notice 문구·칩 라벨·ScheduleForm 부재). 누락 없음.

**Placeholder scan:** 모든 코드 스텝에 실제 코드 블록·정확 경로·예상 출력 포함. TBD/TODO 없음.

**Type consistency:** `presetSnapshotKey`/`presetLoadTick`/`keyRef`/`currentProfileKey`(Task 1), `ids.loadModelClosed`/`loadModelOpen`(Task 2), `sizePresetsCaption`/`measureHelp`(ko 신규, Task 3/4) — 정의처와 사용처 일치. `showRecommended` 제거는 Props·destructure·4 Field·RunDialog 호출·B4 테스트 전부 동일 task(Task 3)에서 — `tsc -b` 부분 제거 방지.

**Spec과 어긋난 보정(의도적):** ① §3.2의 `<HelpTip className="relative z-10">`는 HelpTip에 className prop이 없어 불가 → `<span className="relative z-10">` 래퍼로(HelpTip 0-diff). ② §3.3은 칩 라벨 테스트(`LoadModelFields.test.tsx:120-143`·:154)를 명시 안 했으나 relabel·그룹명 변경으로 깨지거나 vacuous화되므로 Task 3에 포함. ScheduleForm.test.tsx:160 갱신은 **깨져서가 아니라**(부재 단언이고 ScheduleForm은 recommendedNotice를 렌더 안 함 → 구·신 문구 둘 다 부재로 통과) 정확성 차원의 cosmetic 갱신.

**플랜 리뷰에서 접은 수정(orchestrator 직접 grep/Read 검증):** ① **CRITICAL** Task 2의 native-radio `<label>`이 RunDialog.test.tsx의 regex `getByLabelText(/동시 사용자|목표 RPS/)` 14곳과 충돌 → Step 1a sweep으로 `getByRole("spinbutton")` 전환(준비 리팩터, src 전후 green). ② **IMPORTANT** Task 1 신규 테스트는 describe-스코프 헬퍼(`mockPresets`/`renderDialog`)를 쓰므로 새 top-level describe가 아니라 `describe("RunDialog — save/manage preset (A2)")` *안에* 배치. ③ Task 3 `LoadModelFields.test.tsx:154` 그룹명 vacuous-true 방지. ④ **IMPORTANT** `ko`가 `RunDialog.test.tsx`에 import 안 돼 있음(현 `ko.` 6곳은 전부 주석) → Task 1 Step 1이 `import { ko } from "../../i18n/ko";` 추가(Task 1·4 공용).

<!-- REVIEW-GATE: APPROVED -->
