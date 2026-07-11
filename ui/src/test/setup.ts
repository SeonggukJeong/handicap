import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// recharts ResponsiveContainer (ReportView/RunDetailPage) requires ResizeObserver in jsdom.
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
// implementation so tests that use window.localStorage work correctly.
//
// 항상 재설치(guard 없음) — 이전엔 `.clear` 존재 여부로 skip했는데, 그 in-memory
// `store`가 워커 내 파일 간 잔존해(globalThis가 파일 경계에서 안 리셋되는 실행
// 환경에서) suite-wide 비결정 실패를 냈다(ui/CLAUDE.md "suite-wide 비결정 테스트
// 격리 flake"). 매 파일 fresh store로 재설치해 잔존을 원천 차단.
{
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

// vitest's jsdom environment overrides globalThis.AbortController/AbortSignal
// with jsdom's own implementation, but globalThis.Request/fetch/Response stay
// Node's native (undici-backed) ones (jsdom doesn't implement fetch, so vitest
// copies Node's native fetch/Request/Response onto the jsdom window instead of
// shadowing them). react-router's data router (`createMemoryRouter`) builds a
// fresh `new AbortController()` for every navigate() and passes `.signal` into
// `new Request(url, {signal})` — undici's webidl brand-check rejects jsdom's
// AbortSignal ("Expected signal ... to be an instance of AbortSignal"), which
// crashes any real client-side navigation under RouterProvider. None of our
// tests assert on request cancellation, so patch Request to drop `signal`
// rather than try to reconcile the two AbortSignal implementations.
{
  const NativeRequest = globalThis.Request;
  class PatchedRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init: RequestInit = {}) {
      if (init.signal) {
        const rest = { ...init };
        delete rest.signal;
        super(input, rest);
      } else {
        super(input, init);
      }
    }
  }
  globalThis.Request = PatchedRequest as unknown as typeof Request;
}

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
});
