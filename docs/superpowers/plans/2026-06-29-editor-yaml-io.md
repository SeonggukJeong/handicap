# 시나리오 에디터 YAML 파일 가져오기/내보내기 Implementation Plan

<!-- REVIEW-GATE: APPROVED -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YAML 편집 모달 안에 "파일에서 열기"(가져오기)·"파일로 저장"(내보내기) 버튼을 추가해, 현재 시나리오를 `.yaml` 파일로 내려받고 `.yaml` 파일을 에디터에 로드한다.

**Architecture:** UI-only. 내보내기는 store의 현재 보이는 텍스트를 reusable 다운로드 헬퍼(`downloadJson.ts` 일반화)로 저장하고, 가져오기는 `FileReader`로 읽어 기존 `loadFromString`(store 단일 대량 로드 진입점)을 재사용한다. 새 컴포넌트 `YamlFileActions`를 YAML 모달 내용(`MonacoYamlView`) 상단에 렌더해 공유 `EditorShell` 모달을 통해 두 페이지(`/scenarios/new`, `/scenarios/:id`)가 자동으로 얻는다. 모델/스키마/와이어/store 액션 무변경.

**Tech Stack:** TypeScript, React, Zustand, `yaml`(Document API), Monaco, Vitest + Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-29-editor-yaml-io-design.md` (spec-plan-reviewer APPROVE).

## Global Constraints

- **UI-only**: `crates/**` 0-diff. 모델(`scenario/model.ts`)·Zod 스키마·와이어·store 액션 변경 금지 — 가져오기는 기존 `loadFromString` 재사용(새 store 액션 없음).
- **`downloadJson` byte-identical**: 리포트 다운로드 등 기존 소비처(`ReportView.tsx`) 행동 불변 — 같은 `application/json` mime·같은 picker types·같은 blob 경로·1s 지연 revoke. 기존 `downloadJson.test.ts` 전부 green 유지.
- **한국어 문구는 `ko.ts` 경유**(ADR-0035) — aria-label 포함. 하드코딩 영어 금지.
- **`pnpm lint`은 `--max-warnings=0`** — 경고도 실패. `no-control-regex`·`react-refresh/only-export-components` 등은 정확한 `eslint-disable-next-line`로(미사용 directive도 실패).
- **tdd-guard(test-first)**: 각 task에서 **테스트 파일을 먼저** 편집해 pending RED를 만든 뒤 `ui/src` non-test 편집(`ko.ts`/컴포넌트). test-path(`__tests__/`·`*.test.ts(x)`) 편집은 항상 허용.
- **import 깊이**: `__tests__/` 안 테스트는 production 파일보다 한 단계 깊다. `components/scenario/__tests__/X.test.tsx`에서 store는 `../../../scenario/store`, ko는 `../../../i18n/ko`, api는 `../../../api/...`. `api/__tests__/Y.test.ts`에서 형제 모듈은 `../Y`.
- **최종 게이트**: UI 변경 commit은 pre-commit 훅이 `pnpm lint && pnpm test && pnpm build`를 돈다. 각 task는 commit 전 최소 타깃 테스트를 돌리고, Task 4(통합)는 명시적으로 셋 다 돌린다.

---

## File Structure

- **Create** `ui/src/api/sanitizeFilename.ts` — 순수 파일명 정규화 함수(Task 1).
- **Create** `ui/src/api/readTextFile.ts` — `FileReader.readAsText` Promise 래퍼(Task 3).
- **Create** `ui/src/components/scenario/YamlFileActions.tsx` — 모달 툴바(가져오기/내보내기 버튼·숨은 file input·읽기 오류 alert)(Task 4).
- **Modify** `ui/src/api/downloadJson.ts` — `downloadText`/`downloadYaml`로 일반화, `downloadJson` byte-identical 래퍼(Task 2).
- **Modify** `ui/src/i18n/ko.ts` — `editor` 섹션에 새 문구 키(Task 4).
- **Modify** `ui/src/components/scenario/MonacoYamlView.tsx` — `<YamlFileActions />` 한 줄 추가(Task 4).
- **Tests**: `ui/src/api/__tests__/sanitizeFilename.test.ts`(신규), `ui/src/api/__tests__/readTextFile.test.ts`(신규), `ui/src/api/__tests__/downloadJson.test.ts`(확장), `ui/src/components/scenario/__tests__/YamlFileActions.test.tsx`(신규).

---

## Task 1: `sanitizeFilename` 순수 함수

**Files:**
- Create: `ui/src/api/sanitizeFilename.ts`
- Test: `ui/src/api/__tests__/sanitizeFilename.test.ts`

**Interfaces:**
- Produces: `sanitizeFilename(name: string | undefined | null): string` — 예약/위험 문자(`/ \ : * ? " < > |`)·제어문자(`\x00-\x1f`) 제거 + 트림. nullish 입력은 throw 없이 `""`. 빈 결과 가능(호출부가 `|| "scenario"` 폴백).

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/api/__tests__/sanitizeFilename.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "../sanitizeFilename";

describe("sanitizeFilename", () => {
  it("keeps a clean name unchanged", () => {
    expect(sanitizeFilename("Login Flow")).toBe("Login Flow");
  });
  it("strips path and reserved characters", () => {
    expect(sanitizeFilename('a/b:c*d?"e<f>g|h\\i')).toBe("abcdefghi");
  });
  it("strips control characters", () => {
    expect(sanitizeFilename("a\x00b\x1fc")).toBe("abc");
  });
  it("trims surrounding whitespace", () => {
    expect(sanitizeFilename("  spaced  ")).toBe("spaced");
  });
  it("returns empty string when everything is stripped", () => {
    expect(sanitizeFilename("///")).toBe("");
  });
  it("returns empty string for nullish input without throwing", () => {
    expect(sanitizeFilename(undefined)).toBe("");
    expect(sanitizeFilename(null)).toBe("");
  });
  it("composes with the caller fallback to scenario", () => {
    expect(sanitizeFilename("///") || "scenario").toBe("scenario");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test sanitizeFilename`
Expected: FAIL — `sanitizeFilename` 모듈/함수 없음.

- [ ] **Step 3: 최소 구현** (`ui/src/api/sanitizeFilename.ts`)

```ts
/**
 * Normalize a candidate filename (e.g. a scenario name) into a string safe for
 * the filesystem and showSaveFilePicker's `suggestedName`. Removes path
 * separators / reserved characters / control characters and trims.
 *
 * Returns "" for nullish or fully-stripped input — callers apply their own
 * fallback, e.g. `sanitizeFilename(name) || "scenario"`. Must never throw on
 * nullish input (the invalid-buffer export path passes `undefined`).
 */
export function sanitizeFilename(name: string | undefined | null): string {
  if (name == null) return "";
  // eslint-disable-next-line no-control-regex -- intentionally strip C0 control chars from filenames
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "").trim();
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test sanitizeFilename`
Expected: PASS (7 tests).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/sanitizeFilename.ts ui/src/api/__tests__/sanitizeFilename.test.ts
git commit -m "feat(editor): sanitizeFilename 순수 헬퍼 (YAML 내보내기 파일명 정규화)"
```

---

## Task 2: 다운로드 헬퍼 일반화 (`downloadText` / `downloadYaml`)

**Files:**
- Modify: `ui/src/api/downloadJson.ts`
- Test: `ui/src/api/__tests__/downloadJson.test.ts`

**Interfaces:**
- Produces: `downloadText(filename: string, text: string, mime: string, types: SaveTypes): Promise<void>` and `downloadYaml(filename: string, text: string): Promise<void>`, where `SaveTypes = Array<{ description: string; accept: Record<string, string[]> }>`.
- `downloadJson(filename, data)` 시그니처·행동 불변(이제 `downloadText` 위 래퍼).

- [ ] **Step 1: 실패 테스트 추가** (`ui/src/api/__tests__/downloadJson.test.ts`)

기존 `import` 줄에 `downloadYaml`을 추가하고 파일 끝(마지막 `});` 뒤)에 새 describe 블록을 append한다.

import 줄 교체:
```ts
import { downloadJson, downloadYaml } from "../downloadJson";
```

파일 끝에 append:
```ts
describe("downloadYaml", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as PickerWindow).showSaveFilePicker;
  });

  it("uses YAML picker types and writes the raw text", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    (window as PickerWindow).showSaveFilePicker = picker;

    await downloadYaml("scenario.yaml", "version: 1\n");

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "scenario.yaml",
        types: [{ description: "YAML", accept: { "application/yaml": [".yaml", ".yml"] } }],
      }),
    );
    expect(write).toHaveBeenCalledWith("version: 1\n");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a blob URL with the application/yaml mime when no picker", async () => {
    await downloadYaml("scenario.yaml", "version: 1\n");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    const blobArg = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blobArg.type).toBe("application/yaml");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test downloadJson`
Expected: FAIL — `downloadYaml` export 없음 (기존 `downloadJson` 테스트는 여전히 PASS).

- [ ] **Step 3: 일반화 구현** (`ui/src/api/downloadJson.ts` 전체 교체)

```ts
type SaveTypes = Array<{ description: string; accept: Record<string, string[]> }>;

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: SaveTypes;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available — bypasses the browser
// download manager (Chrome Safe Browsing online check blocks downloads when
// the host is offline, an actual air-gapped scenario, ADR-0001). Returns true
// if handled (success OR user cancelled); false if the API is missing or threw.
async function saveViaPicker(filename: string, text: string, types: SaveTypes): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const handle = await picker.call(window, { suggestedName: filename, types });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return true; // user cancelled
    return false;
  }
}

function saveViaBlobUrl(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to read the blob bytes.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const JSON_TYPES: SaveTypes = [{ description: "JSON", accept: { "application/json": [".json"] } }];
const YAML_TYPES: SaveTypes = [{ description: "YAML", accept: { "application/yaml": [".yaml", ".yml"] } }];

/** Save arbitrary `text` to a file: File System Access picker first, blob-URL anchor fallback. */
export async function downloadText(
  filename: string,
  text: string,
  mime: string,
  types: SaveTypes,
): Promise<void> {
  const saved = await saveViaPicker(filename, text, types);
  if (!saved) saveViaBlobUrl(filename, text, mime);
}

/** Save `data` as a pretty-printed JSON file. */
export async function downloadJson(filename: string, data: unknown): Promise<void> {
  await downloadText(filename, JSON.stringify(data, null, 2), "application/json", JSON_TYPES);
}

/** Save YAML `text` as a .yaml file. */
export async function downloadYaml(filename: string, text: string): Promise<void> {
  await downloadText(filename, text, "application/yaml", YAML_TYPES);
}
```

- [ ] **Step 4: 테스트 통과 확인** (기존 + 신규 모두)

Run: `cd ui && pnpm test downloadJson`
Expected: PASS — 기존 `downloadJson` 5개 + 신규 `downloadYaml` 2개. (byte-identical: 기존 테스트가 picker `suggestedName`·`JSON.stringify(...,2)`·1s revoke를 그대로 확인.)

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/downloadJson.ts ui/src/api/__tests__/downloadJson.test.ts
git commit -m "refactor(editor): downloadJson을 downloadText로 일반화 + downloadYaml (JSON 경로 byte-identical)"
```

---

## Task 3: `readTextFile` 유틸

**Files:**
- Create: `ui/src/api/readTextFile.ts`
- Test: `ui/src/api/__tests__/readTextFile.test.ts`

**Interfaces:**
- Produces: `readTextFile(file: File): Promise<string>` — `FileReader.readAsText`로 파일을 텍스트로 읽음(jsdom·브라우저 양쪽 동작). 실패 시 reject.

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/api/__tests__/readTextFile.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { readTextFile } from "../readTextFile";

describe("readTextFile", () => {
  it("reads a File's contents as text", async () => {
    const file = new File(["hello: world\n"], "x.yaml", { type: "application/yaml" });
    expect(await readTextFile(file)).toBe("hello: world\n");
  });

  it("reads multi-line content verbatim", async () => {
    const yaml = "version: 1\nname: Demo\nsteps: []\n";
    const file = new File([yaml], "demo.yaml");
    expect(await readTextFile(file)).toBe(yaml);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test readTextFile`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 최소 구현** (`ui/src/api/readTextFile.ts`)

```ts
/**
 * Read a File as UTF-8 text via FileReader. jsdom does not implement
 * File.text()/Blob.text(), so the import-read path uses FileReader
 * (works in both jsdom and browsers). Mirrors ScenarioImportPage.readText.
 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsText(file);
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ui && pnpm test readTextFile`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/readTextFile.ts ui/src/api/__tests__/readTextFile.test.ts
git commit -m "feat(editor): readTextFile (FileReader Promise 래퍼, jsdom 호환)"
```

---

## Task 4: `YamlFileActions` 컴포넌트 + ko 문구 + MonacoYamlView 배선

**Files:**
- Create: `ui/src/components/scenario/YamlFileActions.tsx`
- Test: `ui/src/components/scenario/__tests__/YamlFileActions.test.tsx`
- Modify: `ui/src/i18n/ko.ts` (`editor` 섹션)
- Modify: `ui/src/components/scenario/MonacoYamlView.tsx`

**Interfaces:**
- Consumes: `sanitizeFilename`(Task 1), `downloadYaml`(Task 2), `readTextFile`(Task 3), `parseScenarioDoc`(`scenario/yamlDoc.ts`, 반환 `{doc,model} | {error}`), `useScenarioEditor`(`model`·`yamlText`·`pendingYamlText`·`yamlError`·`loadFromString`). (`addStep`은 컴포넌트 의존 아님 — 테스트에서 "스텝 존재" 픽스처 시드용으로만 사용.)
- Produces: `YamlFileActions()` (no props) — YAML 모달 툴바.

**Notes (구현 함정 — 반드시 준수):**
- 스토어는 핸들러에서 `useScenarioEditor.getState()`로 on-demand 읽기(렌더 구독 없음 — 버튼/입력은 store 반응 불필요, 읽기 오류만 로컬 state).
- 내보내기 파일명은 **내보낼 그 텍스트**를 `parseScenarioDoc`로 파싱해 도출(`model?.name` 직접 사용 금지 — 디바운스/invalid 윈도에서 내용과 어긋남, spec §3.4).
- 대체 확인 트리거 `hasContent = (model?.steps?.length ?? 0) > 0 || yamlError !== null` — invalid WIP 버퍼(model null·yamlError set)도 확인(spec Contradiction B).
- file input change 핸들러는 **맨 먼저 `e.target.value = ""`**(같은 파일 재선택 가능)·그 다음 file 존재 확인.
- 숨은 file input: `className="hidden"`(=`display:none` → **포커스 불가**, Tab 순서에서 native skip) + `tabIndex={-1}` + `aria-hidden="true"`. `Modal.tsx:40-42` 포커스 트랩 selector는 bare `input`을 잡지만, ⓐ `display:none`이라 `.focus()`가 no-op(실제 포커스 불가), ⓑ DOM상 Monaco 에디터 *앞*이라 first/last 정지점이 되지 않음 → 트랩 Tab-wrap에 무해(spec §4.1).
- async 핸들러는 JSX에서 `() => void fn()`로 호출(`no-misused-promises`/floating-promise 회피).
- 버튼 시각 스타일은 인접 `EditorShell` 툴바 버튼과 동일(`rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100`).

- [ ] **Step 1: 실패 테스트 작성** (`ui/src/components/scenario/__tests__/YamlFileActions.test.tsx`)

`readTextFile`은 모듈 모킹(기본 `IMPORTED_YAML` resolve, 읽기-오류 테스트만 reject 오버라이드), `downloadYaml`은 factory-spread 모킹(다른 export 실물 보존). 스토어는 각 테스트가 `loadFromString`으로 명시 시드.

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { YamlFileActions } from "../YamlFileActions";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";
import { downloadYaml } from "../../../api/downloadJson";
import { readTextFile } from "../../../api/readTextFile";

vi.mock("../../../api/downloadJson", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/downloadJson")>()),
  downloadYaml: vi.fn(),
}));
vi.mock("../../../api/readTextFile", () => ({ readTextFile: vi.fn() }));

const EMPTY_YAML = 'version: 1\nname: "Untitled"\ncookie_jar: auto\nvariables: {}\nsteps: []\n';
const IMPORTED_YAML = "version: 1\nname: Imported\ncookie_jar: auto\nvariables: {}\nsteps: []\n";

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}
function dummyFile() {
  return new File(["ignored — readTextFile is mocked"], "s.yaml", { type: "application/yaml" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readTextFile).mockResolvedValue(IMPORTED_YAML);
  useScenarioEditor.getState().loadFromString(EMPTY_YAML);
});

describe("YamlFileActions — export", () => {
  it("downloads YAML with the filename derived from the scenario name", async () => {
    useScenarioEditor.getState().loadFromString(
      'version: 1\nname: "Login Flow"\ncookie_jar: auto\nvariables: {}\nsteps: []\n',
    );
    render(<YamlFileActions />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.exportYamlAria }));
    await waitFor(() => expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1));
    const [filename, text] = vi.mocked(downloadYaml).mock.calls[0];
    expect(filename).toBe("Login Flow.yaml");
    expect(text).toContain("Login Flow");
  });

  it("falls back to scenario.yaml when the current buffer is invalid", async () => {
    // version literal 1 required → ScenarioModel fails → model null, yamlText kept.
    useScenarioEditor.getState().loadFromString("version: 2\nname: x\n");
    render(<YamlFileActions />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.exportYamlAria }));
    await waitFor(() => expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadYaml).mock.calls[0][0]).toBe("scenario.yaml");
  });
});

describe("YamlFileActions — import", () => {
  it("loads the file without confirming when the editor is empty", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("confirms before replacing when steps exist, and replaces on accept", async () => {
    useScenarioEditor.getState().loadFromString(EMPTY_YAML);
    useScenarioEditor.getState().addStep("Step one"); // guaranteed-valid http step
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(confirmSpy).toHaveBeenCalledWith(ko.editor.importReplaceConfirm);
  });

  it("keeps current content when the replace confirm is cancelled", async () => {
    useScenarioEditor.getState().loadFromString(EMPTY_YAML);
    useScenarioEditor.getState().addStep("Step one");
    const nameBefore = useScenarioEditor.getState().model?.name;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(useScenarioEditor.getState().model?.name).toBe(nameBefore);
  });

  it("confirms when the current buffer is non-empty but invalid (yamlError set)", async () => {
    useScenarioEditor.getState().loadFromString("version: 2\nname: broken\n");
    expect(useScenarioEditor.getState().model).toBeNull();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  });

  it("resets the input value so the same file can be re-picked", async () => {
    const { container } = render(<YamlFileActions />);
    const input = fileInput(container);
    fireEvent.change(input, { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(input.value).toBe("");
  });

  it("loads invalid YAML leniently — sets yamlError, does not throw (acceptance #5)", async () => {
    // Empty editor → no confirm; invalid file content loads as text via loadFromString (lenient, spec §3.3).
    vi.mocked(readTextFile).mockResolvedValueOnce("version: 2\nname: bad\n");
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().yamlError).not.toBeNull());
    expect(useScenarioEditor.getState().model).toBeNull();
  });

  it("shows an alert when the file read fails", async () => {
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error("read boom"));
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("read boom");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ui && pnpm test YamlFileActions`
Expected: FAIL — `YamlFileActions` 컴포넌트·`ko.editor.exportYamlAria` 등 미존재.

- [ ] **Step 3: ko 문구 추가** (`ui/src/i18n/ko.ts`, `editor: {` 블록 안 — 기존 `openYaml`/`yamlModalTitle` 근처에 추가)

```ts
    // ── YAML 파일 가져오기/내보내기 (file-I/O) ──
    importYaml: "파일에서 열기",
    importYamlAria: "YAML 파일을 선택해 시나리오를 불러옵니다",
    exportYaml: "파일로 저장",
    exportYamlAria: "현재 시나리오를 YAML 파일로 저장합니다",
    importReplaceConfirm: "현재 내용을 가져온 파일로 대체합니다. 계속할까요?",
    importReadError: (msg: string) => `파일을 읽지 못했습니다: ${msg}`,
```

- [ ] **Step 4: `YamlFileActions` 컴포넌트 작성** (`ui/src/components/scenario/YamlFileActions.tsx`)

```tsx
import { useRef, useState, type ChangeEvent } from "react";
import { useScenarioEditor } from "../../scenario/store";
import { parseScenarioDoc } from "../../scenario/yamlDoc";
import { downloadYaml } from "../../api/downloadJson";
import { sanitizeFilename } from "../../api/sanitizeFilename";
import { readTextFile } from "../../api/readTextFile";
import { ko } from "../../i18n/ko";

const BTN = "rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100";

export function YamlFileActions() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const onExport = async () => {
    const s = useScenarioEditor.getState();
    const text = s.pendingYamlText ?? s.yamlText;
    // Derive the filename from the exact bytes being saved (not s.model, which
    // can lag the buffer during the debounce window or when invalid).
    const parsed = parseScenarioDoc(text);
    const name = "model" in parsed ? parsed.model.name : undefined;
    const filename = `${sanitizeFilename(name) || "scenario"}.yaml`;
    await downloadYaml(filename, text);
  };

  const onImportClick = () => {
    setReadError(null);
    fileInputRef.current?.click();
  };

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file (re-fires change)
    if (!file) return;
    let content: string;
    try {
      content = await readTextFile(file);
    } catch (err) {
      setReadError((err as Error).message);
      return;
    }
    const s = useScenarioEditor.getState();
    const hasContent = (s.model?.steps?.length ?? 0) > 0 || s.yamlError !== null;
    if (hasContent && !window.confirm(ko.editor.importReplaceConfirm)) return;
    s.loadFromString(content);
  };

  return (
    <div className="mb-2 flex items-center gap-2">
      <button type="button" className={BTN} aria-label={ko.editor.importYamlAria} onClick={onImportClick}>
        {ko.editor.importYaml}
      </button>
      <button type="button" className={BTN} aria-label={ko.editor.exportYamlAria} onClick={() => void onExport()}>
        {ko.editor.exportYaml}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onFileChange(e)}
      />
      {readError !== null && (
        <p role="alert" className="text-xs text-red-600">
          {ko.editor.importReadError(readError)}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: `MonacoYamlView`에 배선** (`ui/src/components/scenario/MonacoYamlView.tsx`)

상단 import에 추가:
```tsx
import { YamlFileActions } from "./YamlFileActions";
```

`return (`의 flex-col 첫 자식으로 `<YamlFileActions />`를 추가 — 기존:
```tsx
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
```
를 다음으로:
```tsx
  return (
    <div className="flex flex-col h-full">
      <YamlFileActions />
      <div className="flex-1 min-h-[400px] border border-slate-200 rounded-md overflow-hidden">
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd ui && pnpm test YamlFileActions`
Expected: PASS (9 tests).

- [ ] **Step 7: 전체 UI 게이트** (TS strict·lint 경고는 여기서만 잡힘)

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 0 경고, 전체 테스트 GREEN, `tsc -b && vite build` 성공. (회귀 주의: `MonacoYamlView`를 마운트하는 기존 테스트가 새 버튼/입력으로 깨지지 않는지 — `YamlFileActions`는 렌더 시 store 구독이 없어 무해해야 함.)

- [ ] **Step 8: 커밋**

```bash
git add ui/src/components/scenario/YamlFileActions.tsx \
  ui/src/components/scenario/__tests__/YamlFileActions.test.tsx \
  ui/src/i18n/ko.ts ui/src/components/scenario/MonacoYamlView.tsx
git commit -m "feat(editor): YAML 모달 파일 가져오기/내보내기 버튼 (YamlFileActions)"
```

---

## Self-Review (작성자 체크 — 완료)

**Spec coverage:** §3 결정(배치·확인·lenient·파일명 도출·헬퍼 재사용) 전부 task로 매핑(Task 4 배치/확인/lenient·import; Task 1·2 파일명·헬퍼). §4 컴포넌트/유틸/헬퍼 → Task 1~4. §5 데이터흐름 → Task 4 핸들러. §6 오류처리 → Task 4(읽기오류 alert·invalid lenient·AbortError는 Task 2 헬퍼). §7 문구 → Task 4 Step 3. §8 테스트 → 각 task 테스트 + Task 4 Step 7 라이브 검증은 별도 단계(아래). §9 수용기준 1~10 커버. 누락 없음.

**Placeholder scan:** 모든 step에 실제 코드/명령 포함. TBD/TODO 없음.

**Type consistency:** `sanitizeFilename(string|undefined|null):string`·`downloadYaml(string,string):Promise<void>`·`readTextFile(File):Promise<string>`·`parseScenarioDoc` 반환 `{doc,model}|{error}`(`"model" in parsed` 내로잉) — Task 간 시그니처 일치. `useScenarioEditor` 읽는 필드(`model`/`yamlText`/`pendingYamlText`/`yamlError`/`loadFromString`/`addStep`) 모두 store에 실재.

---

## 라이브 검증 (구현 완료 후, 머지 전 — 필수)

이 슬라이스는 run-생성/report-파싱/엔진 경로를 건드리지 않지만, **실 picker 바운드 호출·실 blob 다운로드·실 파일 업로드는 RTL/jsdom이 못 잡는다**(`ui/CLAUDE.md`: `picker.call` 함정은 real-browser-only). client-only Playwright로 `vite dev`의 `/scenarios/new`에서 검증(백엔드 불필요 — 에디터 드래그 슬라이스와 동일 harness):

1. `cd ui && pnpm dev` → Playwright `localhost`로 navigate(vite dev는 IPv6 `[::1]` 바인드라 `127.0.0.1` 금지).
2. 템플릿 선택 → 에디터 진입 → "YAML" 버튼으로 모달 열기 → "파일로 저장" 클릭 → `.yaml` 파일이 올바른 이름(시나리오명)+내용으로 실제 다운로드(headless Chromium은 `showSaveFilePicker` 보통 부재 → blob-anchor 폴백 경로 검증).
3. "파일에서 열기" → `.yaml` 파일 업로드(`browser_file_upload`는 repo-루트 제한) → 아웃라인+Monaco 반영 확인.
4. 스텝 있는 상태에서 가져오기 → `window.confirm` 다이얼로그 표시(`browser_handle_dialog`) → 수락 시 대체.
5. 콘솔에 Zod/React 에러 0.

상세 Playwright 운전법은 `/live-verify` 시 로드되는 `docs/dev/live-verify-playwright.md` 참조.

---

## Execution Handoff

**STOP-gate:** spec+plan을 이 세션에서 새로 작성했으므로 같은 세션 구현 금지(CLAUDE.md). plan이 clean APPROVE + `REVIEW-GATE: APPROVED` 마커를 받고 커밋되면, `/clear` → `/start-slice`(spec/plan ready 경로)로 fresh 컨텍스트에서 **subagent-driven-development**로 구현한다. 1M-context 부모면 모든 subagent에 명시 `model:`(implementer Sonnet, code-quality 리뷰 path-gated Opus).
