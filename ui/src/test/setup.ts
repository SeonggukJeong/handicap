import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver, which @xyflow/react's <ZoomPane>
// instantiates on mount. Without this polyfill any test that renders the full
// <ReactFlow> (e.g. CanvasView) throws "ResizeObserver is not defined". A no-op
// stub is sufficient — the canvas tests assert on rendered text, not layout.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
}

// Node.js 25 provides a native globalThis.localStorage that is file-backed and
// does not implement the full Web Storage API (e.g. .clear() is missing when no
// --localstorage-file path is given). Replace it with a simple in-memory
// implementation so tests that use window.localStorage work correctly. This
// polyfill is guarded on .clear being absent to avoid overwriting a fully
// functional implementation (e.g. real jsdom Storage with a URL).
// 가드의 `localStorage?.clear` 접근이 Node 25 lazy native storage를 건드려 테스트 실행마다 `Warning: '--localstorage-file' was provided without a valid path` 1회 출력됨 — 무해.
if (typeof globalThis.localStorage?.clear !== "function") {
  const store: Record<string, string> = {};
  const inMemoryStorage: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: inMemoryStorage,
    writable: true,
    configurable: true,
  });
}
