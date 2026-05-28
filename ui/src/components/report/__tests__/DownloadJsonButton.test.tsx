import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DownloadJsonButton } from "../DownloadJsonButton";

// jsdom does not implement URL.createObjectURL / revokeObjectURL.
// Define them once so vi.spyOn has a target to wrap.
if (typeof URL.createObjectURL === "undefined") {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), writable: true });
}
if (typeof URL.revokeObjectURL === "undefined") {
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
}

describe("DownloadJsonButton", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("creates a blob URL and uses it as the anchor href", () => {
    render(<DownloadJsonButton filename="report.json" data={{ hello: "world" }} />);
    const a = screen.getByRole("link", { name: /Download JSON/ }) as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("blob:mock");
    expect(a.getAttribute("download")).toBe("report.json");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the blob URL on unmount", () => {
    const { unmount } = render(
      <DownloadJsonButton filename="report.json" data={{ hello: "world" }} />,
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
