import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DownloadJsonButton } from "../DownloadJsonButton";

// jsdom does not implement URL.createObjectURL / revokeObjectURL.
// Define them once so vi.spyOn has a target to wrap.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), writable: true });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

describe("DownloadJsonButton", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as PickerWindow).showSaveFilePicker;
  });

  it("renders as a button (not a link) so onClick gates the save logic", () => {
    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    expect(screen.getByRole("button", { name: /Download JSON/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download JSON/ })).toBeNull();
  });

  it("uses showSaveFilePicker when available and bypasses the blob URL path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    (window as PickerWindow).showSaveFilePicker = picker;

    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Download JSON/ }));

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: "report.json" }),
    );
    expect(write).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }, null, 2));
    expect(close).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a blob URL anchor click when showSaveFilePicker is unavailable", async () => {
    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Download JSON/ }));

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("does not fall back when the user cancels the picker (AbortError)", async () => {
    const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(abortError);

    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Download JSON/ }));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to blob URL when showSaveFilePicker fails with a non-Abort error", async () => {
    (window as PickerWindow).showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new Error("denied"));

    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Download JSON/ }));

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
});
