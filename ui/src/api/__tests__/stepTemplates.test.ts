import { afterEach, describe, expect, it, vi } from "vitest";
import { StepTemplateConflictError, createStepTemplate, listStepTemplates } from "../stepTemplates";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const SUMMARY = {
  id: "T1",
  name: "login",
  description: "",
  step_count: 2,
  created_at: 1,
  updated_at: 2,
};

describe("stepTemplates api", () => {
  it("list는 {templates} 래퍼를 언랩한다", async () => {
    mockFetch(200, { templates: [SUMMARY] });
    const out = await listStepTemplates();
    expect(out).toEqual([SUMMARY]);
  });

  it("409 {error,id}는 StepTemplateConflictError(conflictId)로 던진다", async () => {
    mockFetch(409, { error: "같은 이름의 템플릿이 이미 있습니다", id: "T9" });
    const err = await createStepTemplate({ name: "dup", description: "", steps_yaml: "- x" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepTemplateConflictError);
    expect((err as StepTemplateConflictError).conflictId).toBe("T9");
  });

  it("409인데 id 없는 본문(race 백스톱)은 conflictId null", async () => {
    mockFetch(409, { error: "conflict" });
    const err = await createStepTemplate({ name: "dup", description: "", steps_yaml: "- x" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepTemplateConflictError);
    expect((err as StepTemplateConflictError).conflictId).toBe(null);
  });

  it("비-409 에러는 서버 {error} 메시지로 일반 Error", async () => {
    mockFetch(422, { error: "steps parse: bad" });
    await expect(
      createStepTemplate({ name: "x", description: "", steps_yaml: "bad" }),
    ).rejects.toThrow("steps parse: bad");
  });
});
