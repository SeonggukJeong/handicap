import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, RouterProvider, useParams } from "react-router-dom";
import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { useUnsavedGuard } from "../useUnsavedGuard";

/** param-only 이동(/p/1→/p/2)에서 컴포넌트가 마운트 유지되는 실제 조건을 재현하는 하니스.
 *  (편집 페이지 복제 /scenarios/A→/scenarios/B와 동형 — spec §3-5) */
function GuardedPage({ initialDirty }: { initialDirty: boolean }) {
  const { id } = useParams<{ id: string }>();
  const [dirty, setDirty] = useState(initialDirty);
  const { blocker, bypassNext } = useUnsavedGuard(dirty);
  return (
    <div>
      <span data-testid="param">{id}</span>
      <span data-testid="blocker-state">{blocker.state}</span>
      <button onClick={() => setDirty(true)}>make-dirty</button>
      <button onClick={() => setDirty(false)}>make-clean</button>
      <button onClick={() => bypassNext()}>arm-bypass</button>
      <button onClick={() => blocker.proceed?.()}>proceed</button>
      <button onClick={() => blocker.reset?.()}>reset</button>
      <Link to="/p/2">to-p2</Link>
      <Link to="/p/3">to-p3</Link>
      <Link to="/away">away</Link>
    </div>
  );
}

function renderGuarded(initialDirty: boolean) {
  const router = createMemoryRouter(
    [
      { path: "/p/:id", element: <GuardedPage initialDirty={initialDirty} /> },
      { path: "/away", element: <div>AWAY</div> },
    ],
    { initialEntries: ["/p/1"] },
  );
  // 프로덕션(main.tsx)이 StrictMode — useBlocker의 이중 마운트 거동까지 테스트에서 재현
  render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}

describe("useUnsavedGuard", () => {
  it("dirty면 이동을 차단하고 blocked 상태가 된다 (R1)", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(screen.getByTestId("param")).toHaveTextContent("1"); // 잔류
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("blocked");
  });

  it("blocked에서 proceed()하면 이동한다", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    await user.click(screen.getByRole("button", { name: "proceed" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("blocked에서 reset()하면 잔류하고 unblocked로 돌아온다", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("link", { name: "away" }));
    await user.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByTestId("param")).toHaveTextContent("1");
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("unblocked");
  });

  it("clean이면 즉시 이동한다 (R4)", async () => {
    const user = userEvent.setup();
    renderGuarded(false);
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("bypassNext() 후 첫 이동은 dirty여도 통과한다 (R5)", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("button", { name: "arm-bypass" }));
    await user.click(screen.getByRole("link", { name: "away" }));
    expect(await screen.findByText("AWAY")).toBeInTheDocument();
  });

  it("clean 이동도 armed 플래그를 소비한다 — 잔존 플래그가 나중 dirty 이동을 통과시키지 않는다 (spec §3-5 잔존 버그 회귀)", async () => {
    const user = userEvent.setup();
    renderGuarded(false); // clean
    await user.click(screen.getByRole("button", { name: "arm-bypass" }));
    await user.click(screen.getByRole("link", { name: "to-p2" })); // clean 통과 + 플래그 소비, 컴포넌트는 마운트 유지
    expect(screen.getByTestId("param")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    await user.click(screen.getByRole("link", { name: "to-p3" }));
    expect(screen.getByTestId("param")).toHaveTextContent("2"); // 차단 = 잔류
    expect(screen.getByTestId("blocker-state")).toHaveTextContent("blocked");
  });

  it("dirty일 때만 beforeunload를 preventDefault한다 (R7)", async () => {
    const user = userEvent.setup();
    renderGuarded(false);
    // jsdom: cancelable 없으면 preventDefault가 no-op이라 반드시 cancelable: true (spec §6)
    const cleanEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvt);
    expect(cleanEvt.defaultPrevented).toBe(false);

    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    const dirtyEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvt);
    expect(dirtyEvt.defaultPrevented).toBe(true);

    // dirty→clean 복귀 시 리스너 해제 (R7 "clean/unmount 시 해제" 자구)
    await user.click(screen.getByRole("button", { name: "make-clean" }));
    const backCleanEvt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(backCleanEvt);
    expect(backCleanEvt.defaultPrevented).toBe(false);
  });
});
