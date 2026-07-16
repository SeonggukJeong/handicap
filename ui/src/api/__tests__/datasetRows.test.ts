import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../client";
import { DatasetRowsSchema } from "../schemas";

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

describe("getDatasetRows / DatasetRowsSchema", () => {
  it("GET /datasets/{id}/rows?offset=&limit= 로 요청하고 응답을 파싱한다 (R3)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rows: [{ name: "r2", val: "2" }], offset: 2, total: 5 }),
    );
    const r = await api.getDatasetRows("01J", 2, 50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe("/api/datasets/01J/rows?offset=2&limit=50");
    expect(r.total).toBe(5);
    expect(r.offset).toBe(2);
    expect(r.rows[0]).toEqual({ name: "r2", val: "2" });
  });

  it("스키마는 plain 필드 — 누락 필드는 거부한다 (R3)", () => {
    expect(DatasetRowsSchema.safeParse({ rows: [], offset: 0, total: 0 }).success).toBe(true);
    expect(DatasetRowsSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(DatasetRowsSchema.safeParse({ rows: [{ a: 1 }], offset: 0, total: 1 }).success).toBe(
      false, // 셀 값은 string
    );
  });
});
