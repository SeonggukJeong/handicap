import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadFile } from "../download";
import { ApiError } from "../client";

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

describe("downloadFile", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as PickerWindow).showSaveFilePicker;
    // Restore global fetch
    vi.unstubAllGlobals();
  });

  it("200 path (no picker): triggers blob-URL anchor download and resolves", async () => {
    const mockBlob = new Blob(["a,b\n1,2"], { type: "text/csv" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => mockBlob,
    });
    // showSaveFilePicker unavailable (not set)

    await expect(
      downloadFile("/api/runs/r1/report.csv", "report.csv", "text/csv"),
    ).resolves.toBeUndefined();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("200 path (with picker): uses showSaveFilePicker and does NOT fall back to blob URL", async () => {
    const mockBlob = new Blob(["a,b\n1,2"], { type: "text/csv" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => mockBlob,
    });

    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    (window as PickerWindow).showSaveFilePicker = picker;

    await expect(
      downloadFile("/api/runs/r1/report.csv", "report.csv", "text/csv"),
    ).resolves.toBeUndefined();
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "report.csv" }));
    expect(write).toHaveBeenCalledWith(mockBlob);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("4xx path: throws ApiError with the server {error} message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: "run is not finished" }),
    });

    await expect(
      downloadFile("/api/runs/r1/report.csv", "report.csv", "text/csv"),
    ).rejects.toSatisfy((e: unknown) => {
      return e instanceof ApiError && e.message.includes("run is not finished");
    });
  });
});
