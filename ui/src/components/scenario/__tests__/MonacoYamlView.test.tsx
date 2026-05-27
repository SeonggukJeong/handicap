import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock @monaco-editor/react BEFORE importing the view, because the view's
// module-scope code calls loader.config(...) at import time. We need to
// observe that call.
const loaderConfigMock = vi.fn();

vi.mock("@monaco-editor/react", () => {
  return {
    loader: { config: loaderConfigMock },
    default: vi.fn(() => null),
  };
});

// Mock the worker module so `new editorWorker()` returns a stub.
// The workerQueryPlugin in vitest.config.ts strips the `?worker` suffix before
// resolution, so we mock the path WITHOUT the suffix. The component imports
// "monaco-editor/esm/vs/editor/editor.worker?worker" — after the plugin strips
// the suffix it becomes "monaco-editor/esm/vs/editor/editor.worker", which is
// what vi.mock must intercept.
vi.mock("monaco-editor/esm/vs/editor/editor.worker", () => {
  return {
    default: class FakeWorker {
      // minimal Worker-shape stub
      postMessage() {}
      terminate() {}
    },
  };
});

// Mock monaco-editor itself so its size doesn't blow up the test.
vi.mock("monaco-editor", () => {
  return {
    // namespace import target
    editor: {},
    languages: {},
  };
});

describe("MonacoYamlView module-scope side effects", () => {
  it("calls loader.config({ monaco }) exactly once at import", async () => {
    // Force a fresh module load (important because module-scope effects fire on import)
    vi.resetModules();
    loaderConfigMock.mockClear();
    await import("../MonacoYamlView");
    expect(loaderConfigMock).toHaveBeenCalledTimes(1);
    const args = loaderConfigMock.mock.calls[0][0];
    expect(args).toHaveProperty("monaco");
  });

  it("registers self.MonacoEnvironment.getWorker that returns a Worker-shaped object", async () => {
    vi.resetModules();
    await import("../MonacoYamlView");
    const env = (
      self as unknown as {
        MonacoEnvironment?: { getWorker: (id: string, label: string) => unknown };
      }
    ).MonacoEnvironment;
    expect(env).toBeDefined();
    expect(typeof env?.getWorker).toBe("function");
    const w = env!.getWorker("0", "yaml");
    // FakeWorker has postMessage + terminate
    expect(typeof (w as { postMessage?: unknown }).postMessage).toBe("function");
    expect(typeof (w as { terminate?: unknown }).terminate).toBe("function");
  });
});

describe("MonacoYamlView debounce behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("setPendingYamlText fires immediately on change; commitPendingYaml fires after 300ms", async () => {
    vi.resetModules();
    // Re-import the store fresh so its state is isolated.
    const store = await import("../../../scenario/store");
    store.useScenarioEditor.setState(
      (store.useScenarioEditor as unknown as { getInitialState: () => typeof store.useScenarioEditor extends { getState: () => infer S } ? S : never }).getInitialState(),
    );

    const setPendingSpy = vi.spyOn(
      store.useScenarioEditor.getState(),
      "setPendingYamlText",
    );
    const commitSpy = vi.spyOn(
      store.useScenarioEditor.getState(),
      "commitPendingYaml",
    );

    // Inject spies into the store so the module reads the spied refs.
    store.useScenarioEditor.setState({
      setPendingYamlText:
        setPendingSpy as unknown as typeof store.useScenarioEditor extends {
          getState: () => infer S;
        }
          ? S extends { setPendingYamlText: infer F }
            ? F
            : never
          : never,
      commitPendingYaml:
        commitSpy as unknown as typeof store.useScenarioEditor extends {
          getState: () => infer S;
        }
          ? S extends { commitPendingYaml: infer F }
            ? F
            : never
          : never,
    });

    const view = await import("../MonacoYamlView");
    // The exported __test_handleChangeForTests helper mirrors the component's
    // onChange debounce logic. We test through it to avoid mounting Monaco.
    expect(view).toHaveProperty("__test_handleChangeForTests");
    view.__test_handleChangeForTests("hello: world");

    expect(setPendingSpy).toHaveBeenCalledWith("hello: world");
    expect(commitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(commitSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });

  it("rapid edits within debounce window only fire commitPendingYaml once", async () => {
    vi.resetModules();
    const store = await import("../../../scenario/store");
    store.useScenarioEditor.setState(
      (store.useScenarioEditor as unknown as { getInitialState: () => ReturnType<typeof store.useScenarioEditor.getState> }).getInitialState(),
    );
    const commitSpy = vi.spyOn(
      store.useScenarioEditor.getState(),
      "commitPendingYaml",
    );
    store.useScenarioEditor.setState({
      commitPendingYaml: commitSpy as unknown as typeof store.useScenarioEditor extends {
        getState: () => infer S;
      }
        ? S extends { commitPendingYaml: infer F }
          ? F
          : never
        : never,
    });

    const view = await import("../MonacoYamlView");
    view.__test_handleChangeForTests("a");
    vi.advanceTimersByTime(100);
    view.__test_handleChangeForTests("ab");
    vi.advanceTimersByTime(100);
    view.__test_handleChangeForTests("abc");
    vi.advanceTimersByTime(299);
    expect(commitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("CSP meta tag carries worker-src 'self' blob:", () => {
  it("ui/index.html literally contains the required CSP directives", async () => {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    // jsdom environment does not provide a file: import.meta.url, so we use
    // path.resolve(__dirname, ...) instead. __dirname is vitest's test file dir.
    const htmlPath = nodePath.resolve(__dirname, "../../../../index.html");
    const html = await fs.readFile(htmlPath, "utf-8");
    expect(html).toMatch(/worker-src 'self' blob:/);
    expect(html).toMatch(/default-src 'self'/);
    expect(html).toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(html).toMatch(/connect-src 'self'/);
  });
});
