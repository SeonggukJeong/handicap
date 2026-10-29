import { z } from "zod";
import { ApiError } from "./client";
import { errorMessage } from "./monitors";
import { downloadText, JSON_TYPES } from "./downloadJson";
import { sanitizeFilename } from "./sanitizeFilename";
import { ko } from "../i18n/ko";

const BASE = "/api/monitor-boards";

export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export const ResStateSchema = z.enum(["absent", "same", "different"]);

export const ResourceInfoSchema = z
  .object({ id: z.string(), name: z.string(), state: ResStateSchema })
  .strict();

// pc_name: Rust Option without skip_serializing_if -> always serialized, null when absent.
export const BoardAnalysisSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pc_name: z.string().nullable(),
    conflict: z.boolean(),
    exists: z.boolean(),
    enabled: z.boolean(),
    scenarios: z.array(ResourceInfoSchema),
    environments: z.array(ResourceInfoSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export const AnalysisSchema = z
  .object({
    boards: z.array(BoardAnalysisSchema),
    summary: z
      .object({
        boards: z.number(),
        conflicts: z.number(),
        scenarios: z.number(),
        environments: z.number(),
      })
      .strict(),
  })
  .strict();

const CountsSchema = z
  .object({ added: z.number(), updated: z.number(), copied: z.number(), unchanged: z.number() })
  .strict();

export const ImportResultSchema = z
  .object({
    boards: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          action: z.string(),
          warnings: z.array(z.string()),
        })
        .strict(),
    ),
    scenarios: CountsSchema,
    environments: CountsSchema,
    renamed: z.array(
      z.object({ kind: z.string(), from: z.string(), to: z.string(), reason: z.string() }).strict(),
    ),
  })
  .strict();

export const ConflictBodySchema = z
  .object({ error: z.literal("conflicts"), boards: z.array(BoardAnalysisSchema) })
  .strict();

export type ResState = z.infer<typeof ResStateSchema>;
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;
export type BoardAnalysis = z.infer<typeof BoardAnalysisSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;

export class ImportConflictError extends Error {
  constructor(public readonly boards: BoardAnalysis[]) {
    super("conflicts");
    this.name = "ImportConflictError";
  }
}

async function fail(res: Response): Promise<never> {
  if (res.status === 413) throw new ApiError(413, ko.monitor.transfer.tooLarge);
  throw new ApiError(res.status, await errorMessage(res));
}

export async function exportBoards(ids: string[]): Promise<string> {
  const res = await fetch(`${BASE}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board_ids: ids }),
  });
  if (!res.ok) return fail(res);
  return res.text();
}

export async function downloadBoardFile(filename: string, text: string): Promise<void> {
  await downloadText(filename, text, "application/json", JSON_TYPES);
}

export function exportFileName(boardNames: string[]): string {
  if (boardNames.length === 1) {
    return ko.monitor.transfer.defaultFileSingle(sanitizeFilename(boardNames[0]));
  }
  return ko.monitor.transfer.defaultFileMulti(boardNames.length);
}

export async function analyzeImport(text: string): Promise<Analysis> {
  const res = await fetch(`${BASE}/import/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
  if (!res.ok) return fail(res);
  return AnalysisSchema.parse(await res.json());
}

export async function applyImport(text: string): Promise<ImportResult> {
  const res = await fetch(`${BASE}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Raw splice, never re-serialized (spec J13): the server sees the file bytes as-is.
    body: '{"bundle":' + text + "}",
  });
  if (res.status === 409) {
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // non-JSON body
    }
    const c = ConflictBodySchema.safeParse(parsed);
    if (c.success) throw new ImportConflictError(c.data.boards);
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : "HTTP 409";
    throw new ApiError(409, msg);
  }
  if (!res.ok) return fail(res);
  return ImportResultSchema.parse(await res.json());
}
