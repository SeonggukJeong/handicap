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

afterEach(() => {
  cleanup();
  globalThis.localStorage.clear();
});
