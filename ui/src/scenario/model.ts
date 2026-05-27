import { z } from "zod";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const BodyModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("form"), value: z.record(z.string(), z.string()) }).strict(),
  z.object({ kind: z.literal("raw"), value: z.string() }).strict(),
]);
export type Body = z.infer<typeof BodyModel>;

export const RequestModel = z
  .object({
    method: HttpMethod,
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    body: BodyModel.optional(),
  })
  .strict();
export type RequestSpec = z.infer<typeof RequestModel>;

export const AssertionModel = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), code: z.number().int().min(100).max(599) }).strict(),
]);
export type Assertion = z.infer<typeof AssertionModel>;

export const StepModel = z
  .object({
    id: z.string().regex(ULID_RE, "step id must be a ULID"),
    name: z.string().min(1, "step name required"),
    type: z.literal("http"),
    request: RequestModel,
    assert: z.array(AssertionModel).default([]),
  })
  .strict();
export type Step = z.infer<typeof StepModel>;

export const CookieJarMode = z.enum(["auto", "off"]);
export type CookieJarMode = z.infer<typeof CookieJarMode>;

export const ScenarioModel = z
  .object({
    version: z.literal(1),
    name: z.string().min(1, "name required"),
    cookie_jar: CookieJarMode.default("auto"),
    variables: z.record(z.string(), z.string()).default({}),
    steps: z.array(StepModel).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioModel>;

export function newEmptyScenario(name = "Untitled"): Scenario {
  return {
    version: 1,
    name,
    cookie_jar: "auto",
    variables: {},
    steps: [],
  };
}
