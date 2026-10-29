import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisSchema,
  ImportConflictError,
  analyzeImport,
  applyImport,
  exportBoards,
  exportFileName,
} from "../monitorTransfer";
import { ApiError } from "../client";
import { ko } from "../../i18n/ko";

const board = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  name: "b",
  pc_name: null,
  conflict: true,
  exists: true,
  enabled: false,
  scenarios: [{ id: "s", name: "sc", state: "different" }],
  environments: [],
  warnings: [],
};

function mockFetch(status: number, body: string) {
  const f = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("monitorTransfer", () => {
  it("applyImport_splices_raw_text", async () => {
    const f = mockFetch(
      200,
      JSON.stringify({
        boards: [],
        scenarios: { added: 0, updated: 0, copied: 0, unchanged: 0 },
        environments: { added: 0, updated: 0, copied: 0, unchanged: 0 },
        renamed: [],
      }),
    );
    const text = '{"b":1.0,"a":2}';
    await applyImport(text);
    expect((f.mock.calls[0][1] as RequestInit).body).toBe('{"bundle":' + text + "}");
  });

  it("applyImport_409_conflicts_throws_ImportConflictError", async () => {
    mockFetch(409, JSON.stringify({ error: "conflicts", boards: [board] }));
    const err = await applyImport("{}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportConflictError);
    expect((err as ImportConflictError).boards[0].name).toBe("b");
  });

  it("applyImport_409_other_is_ApiError", async () => {
    mockFetch(409, JSON.stringify({ error: "something else" }));
    const err = await applyImport("{}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ImportConflictError);
    expect((err as ApiError).status).toBe(409);
  });

  it("analyzeImport_413_message", async () => {
    mockFetch(413, "length limit exceeded");
    const err = await analyzeImport("{}").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
    expect((err as ApiError).message).toBe(ko.monitor.transfer.tooLarge);
  });

  it("analysis_accepts_null_pc_name", () => {
    const a = AnalysisSchema.parse({
      boards: [board],
      summary: { boards: 1, conflicts: 1, scenarios: 1, environments: 0 },
    });
    expect(a.boards[0].pc_name).toBeNull();
  });

  it("exportBoards returns raw text and fails with server message", async () => {
    mockFetch(200, '{\n  "x": 1\n}');
    expect(await exportBoards(["a"])).toBe('{\n  "x": 1\n}');
    mockFetch(400, JSON.stringify({ error: "없음" }));
    const err = await exportBoards(["a"]).catch((e: unknown) => e);
    expect((err as ApiError).message).toBe("없음");
    mockFetch(422, "plain text");
    const err2 = await exportBoards(["a"]).catch((e: unknown) => e);
    expect((err2 as ApiError).message).toBe("HTTP 422");
  });

  it("exportBoards_404_message", async () => {
    mockFetch(404, JSON.stringify({ error: "not found" }));
    const err = await exportBoards(["a"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe(
      "내보낼 보드 중 이미 지워진 것이 있습니다. 목록을 새로 고친 뒤 다시 고르세요.",
    );
  });

  it("exportFileName_single_sanitized", () => {
    expect(exportFileName(["a/b:c"])).toBe("abc.handicap-board.json");
  });
  it("exportFileName_empty_name_fallback", () => {
    expect(exportFileName(["///"])).toBe("monitor-board.handicap-board.json");
  });
  it("exportFileName_multiple", () => {
    expect(exportFileName(["a", "b", "c"])).toBe("monitor-boards-3.handicap-board.json");
  });
});
