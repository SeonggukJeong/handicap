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
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
}
