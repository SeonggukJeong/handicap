import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("datasets api", () => {
  it("listDatasets parses the list response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        datasets: [
          { id: "01J", name: "u", columns: ["a"], row_count: 1, byte_size: 9, created_at: 1 },
        ],
      }),
    );
    const out = await api.listDatasets();
    expect(out.datasets[0].id).toBe("01J");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/datasets",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uploadDataset posts FormData and omits the JSON content-type", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: "01J",
        name: "u",
        columns: ["a"],
        row_count: 1,
        byte_size: 9,
        created_at: 1,
        sample: [{ a: "x" }],
      }),
    );
    const file = new File(["a\nx\n"], "u.csv", { type: "text/csv" });
    const out = await api.uploadDataset(file, { delimiter: "," });
    expect(out.id).toBe("01J");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const headers = new Headers(init.headers ?? {});
    expect(headers.has("content-type")).toBe(false);
    const fd = init.body as FormData;
    expect(fd.get("file")).toBeInstanceOf(File);
    expect(fd.get("delimiter")).toBe(",");
  });

  it("deleteDataset issues DELETE", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteDataset("01J");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/datasets/01J",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
