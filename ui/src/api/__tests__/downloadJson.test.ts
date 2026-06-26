import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadJson } from "../downloadJson";

// jsdom does not implement URL.createObjectURL / revokeObjectURL.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), writable: true });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

describe("downloadJson", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as PickerWindow).showSaveFilePicker;
  });

  it("uses showSaveFilePicker when available and bypasses the blob URL path", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    (window as PickerWindow).showSaveFilePicker = picker;

    await downloadJson("report.json", { hello: "world" });

    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "report.json" }));
    expect(write).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }, null, 2));
    expect(close).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a blob URL anchor click when showSaveFilePicker is unavailable", async () => {
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("does not fall back when the user cancels the picker (AbortError)", async () => {
    const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(abortError);
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to blob URL when showSaveFilePicker fails with a non-Abort error", async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new Error("denied"));
    await downloadJson("report.json", { hello: "world" });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the blob URL after a delay (no leak)", async () => {
    vi.useFakeTimers();
    try {
      await downloadJson("report.json", { hello: "world" });
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    } finally {
      vi.useRealTimers();
    }
  });
});
