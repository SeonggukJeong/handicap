import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { KeyValueGrid } from "../KeyValueGrid";
import { COMMON_HEADERS } from "../../../scenario/commonHeaders";

function Harness(props: {
  initial?: Record<string, string>;
  initialDisabled?: Record<string, string>;
  withCommon?: boolean;
  format?: "header" | "form";
}) {
  const [entries, setEntries] = useState<Record<string, string>>(props.initial ?? {});
  const [disabled, setDisabled] = useState<Record<string, string>>(props.initialDisabled ?? {});
  return (
    <>
      <KeyValueGrid
        entries={entries}
        disabledEntries={disabled}
        onChange={(a, d) => {
          setEntries(a);
          setDisabled(d);
        }}
        resetKey="step-1"
        bulkFormat={props.format ?? "header"}
        itemLabel="header"
        keyPlaceholder="Header"
        valuePlaceholder="value"
        emptyText="No headers"
        commonKeys={props.withCommon ? COMMON_HEADERS : undefined}
      />
      <pre data-testid="dump">{JSON.stringify(entries)}</pre>
      <pre data-testid="dump-disabled">{JSON.stringify(disabled)}</pre>
    </>
  );
}

const dump = () => JSON.parse(screen.getByTestId("dump").textContent || "{}");
const dumpDisabled = () => JSON.parse(screen.getByTestId("dump-disabled").textContent || "{}");

describe("KeyValueGrid — grid editing", () => {
  it("adds a row via the two-field add row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("새 header 키"), "X-Custom");
    await user.type(screen.getByLabelText("새 header 값"), "abc");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(dump()).toEqual({ "X-Custom": "abc" });
  });

  it("commits an edited value on blur (not before)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const value = screen.getByLabelText("header value 0");
    await user.clear(value);
    await user.type(value, "2");
    expect(dump()).toEqual({ A: "1" }); // not committed yet
    await user.tab(); // blur
    expect(dump()).toEqual({ A: "2" });
  });

  it("renames a key on blur", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const key = screen.getByLabelText("header key 0");
    await user.clear(key);
    await user.type(key, "B");
    await user.tab();
    expect(dump()).toEqual({ B: "1" });
  });

  it("removes a row", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1", B: "2" }} />);
    await user.click(screen.getByRole("button", { name: "header A 제거" }));
    expect(dump()).toEqual({ B: "2" });
  });

  it("dedupes duplicate keys last-wins on commit", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    await user.type(screen.getByLabelText("새 header 키"), "A");
    await user.type(screen.getByLabelText("새 header 값"), "2");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(dump()).toEqual({ A: "2" });
  });

  it("each row exposes exactly two textboxes with min-w-0 (overflow guard)", async () => {
    render(<Harness initial={{ A: "1" }} />);
    const row = screen.getByRole("button", { name: "header A 제거" }).closest("li")!;
    const inputs = within(row).getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    inputs.forEach((i) => expect(i).toHaveClass("min-w-0"));
  });
});

describe("KeyValueGrid — bulk edit toggle", () => {
  it("opens prepopulated and Apply replaces the whole map", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1", B: "2" }} />);
    await user.click(screen.getByRole("button", { name: "Bulk Edit" }));
    const ta = screen.getByLabelText("일괄 편집 텍스트") as HTMLTextAreaElement;
    expect(ta.value).toBe("A: 1\nB: 2");
    // fireEvent (top-level import) to avoid userEvent ':' descriptor parsing.
    fireEvent.change(ta, { target: { value: "A: 9" } });
    await user.click(screen.getByRole("button", { name: "적용" }));
    expect(dump()).toEqual({ A: "9" });
    expect(screen.queryByLabelText("일괄 편집 텍스트")).not.toBeInTheDocument(); // closed
  });
});

describe("KeyValueGrid — common-header picker", () => {
  it("menu pick adds a row with seeded value", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "application/json" });
  });

  it("menu pick does NOT clobber a non-empty existing value (A3)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon initial={{ "Content-Type": "text/plain" }} />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "text/plain" });
  });

  it("menu pick seeds value when existing value is empty", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon initial={{ "Content-Type": "" }} />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(dump()).toEqual({ "Content-Type": "application/json" });
  });

  it("typing a known header name into the add-row key seeds the value (onChange branch)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon />);
    await user.type(screen.getByLabelText("새 header 키"), "Accept");
    expect(screen.getByLabelText("새 header 값")).toHaveValue("application/json");
  });

  it("does not render the picker menu when commonKeys is absent", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /자주 쓰는 헤더/ })).not.toBeInTheDocument();
  });
});

describe("KeyValueGrid — focus movement", () => {
  it("returns focus to the add-row key field after Add (spec §3-1)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("새 header 키"), "X-Custom");
    await user.type(screen.getByLabelText("새 header 값"), "abc");
    await user.click(screen.getByRole("button", { name: "추가" }));
    expect(screen.getByLabelText("새 header 키")).toHaveFocus();
  });

  it("focuses the row value field after a menu pick adds a row (spec §6)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(screen.getByLabelText("header value 0")).toHaveFocus();
  });

  it("focuses the row value field when a menu pick seeds an empty existing row (spec §6)", async () => {
    const user = userEvent.setup();
    render(<Harness withCommon initial={{ "Content-Type": "" }} />);
    await user.click(screen.getByRole("button", { name: /자주 쓰는 헤더/ }));
    await user.click(screen.getByRole("option", { name: "Content-Type" }));
    expect(screen.getByLabelText("header value 0")).toHaveFocus();
  });
});

describe("KeyValueGrid — disabled toggle", () => {
  it("toggling a row's checkbox moves it to the disabled map (and back)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} />);
    const cb = screen.getByLabelText("header enabled 0") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    await user.click(cb); // disable
    expect(dump()).toEqual({});
    expect(dumpDisabled()).toEqual({ A: "1" });
    await user.click(screen.getByLabelText("header enabled 0")); // re-enable
    expect(dump()).toEqual({ A: "1" });
    expect(dumpDisabled()).toEqual({});
  });

  it("a disabled row is still editable", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{}} initialDisabled={{ A: "1" }} />);
    const value = screen.getByLabelText("header value 0");
    await user.clear(value);
    await user.type(value, "2");
    await user.tab(); // blur commit
    expect(dumpDisabled()).toEqual({ A: "2" });
    expect(dump()).toEqual({});
  });

  it("bulk replace keeps disabled rows; active wins on key collision", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ A: "1" }} initialDisabled={{ B: "x", A: "old" }} />);
    // A exists active+disabled only transiently; split makes active win — disabled has only B.
    await user.click(screen.getByRole("button", { name: "Bulk Edit" }));
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "A: 9\nC: 3" } });
    await user.click(screen.getByRole("button", { name: /적용/i }));
    expect(dump()).toEqual({ A: "9", C: "3" }); // active replaced
    expect(dumpDisabled()).toEqual({ B: "x" }); // disabled preserved, A collision dropped from disabled
  });
});
