import { stringify } from "yaml";
import { jsonBodyCastErrors } from "../scenario/cast";
import { newStepId } from "../scenario/ulid";
import {
  type Har,
  type HarEntry,
  type HarPostData,
  type SelectOptions,
  selectEntries,
} from "./filters";

export type HeaderMode = "all" | "strip-volatile" | "semantic-only";

export interface ConvertOptions extends SelectOptions {
  headerMode: HeaderMode;
  statusAssert: boolean;
  name: string;
  hostVars?: Record<string, string>;
}

const VOLATILE = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "proxy-connection",
]);

function isSemantic(lower: string): boolean {
  return (
    lower === "content-type" ||
    lower === "authorization" ||
    lower === "accept" ||
    lower.startsWith("x-")
  );
}

// HAR headers 배열 → wire map (중복 키 last-wins). :의사헤더는 전 모드 제거.
function foldHeaders(
  headers: HarEntry["request"]["headers"],
  mode: HeaderMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h.name.startsWith(":")) continue; // HTTP/2 pseudo-header — 전송 불가
    const lower = h.name.toLowerCase();
    if (mode === "strip-volatile" && VOLATILE.has(lower)) continue;
    if (mode === "semantic-only" && !isSemantic(lower)) continue;
    out[h.name] = h.value; // last-wins
  }
  return out;
}

function formRecord(post: HarPostData): Record<string, string> {
  const rec: Record<string, string> = {};
  if (post.params && post.params.length > 0) {
    for (const p of post.params) rec[p.name] = p.value ?? ""; // last-wins
    return rec;
  }
  for (const [k, v] of new URLSearchParams(post.text ?? "")) rec[k] = v;
  return rec;
}

// 와이어-형 body: {json|form|raw: value}. 모델-형(kind/value) 금지.
function wireBody(post: HarPostData | undefined): Record<string, unknown> | undefined {
  if (!post) return undefined;
  const mime = (post.mimeType ?? "").toLowerCase();
  const text = post.text ?? "";
  if (mime.includes("x-www-form-urlencoded")) return { form: formRecord(post) };
  if (mime.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      // 미지원 cast keyword({{x:int}})·env-cast(${X:num})·혼합 리터럴이 있으면 BodyModel.superRefine이
      // 거부 → raw 폴백. (표준 {{x:num}}/{{x:str}}/{{x:bool}} 단독값은 유효라 안 걸려 json 유지)
      if (jsonBodyCastErrors(parsed).length === 0) return { json: parsed };
      return { raw: text };
    } catch {
      return { raw: text };
    }
  }
  return text.length > 0 ? { raw: text } : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// 매핑된 호스트의 origin(scheme://host[:port])을 ${변수}로 치환. 미매핑·상대 URL은 불변.
export function parameterizeUrl(url: string, hostVars?: Record<string, string>): string {
  if (!hostVars) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const varName = hostVars[parsed.host];
  if (!varName) return url;
  return `\${${varName}}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// fold 후 후처리: Referer/Origin 헤더 값의 매핑된 호스트를 ${변수}로 치환.
// Referer는 parameterizeUrl 규칙(경로·쿼리 보존), Origin은 bare ${VAR}
// (RFC 6454 — origin에 trailing slash가 붙으면 안 되므로 parameterizeUrl 재사용 불가).
// 미매핑 호스트·파싱 불가 값(Origin: null 등)·그 외 이름은 불변.
export function parameterizeRefHeaders(
  headers: Record<string, string>,
  hostVars?: Record<string, string>,
): Record<string, string> {
  if (!hostVars) return headers;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "referer") {
      out[name] = parameterizeUrl(value, hostVars);
    } else if (lower === "origin") {
      out[name] = originVar(value, hostVars) ?? value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function originVar(value: string, hostVars: Record<string, string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const varName = hostVars[parsed.host];
  if (!varName) return null;
  return `\${${varName}}`;
}

function wireStep(entry: HarEntry, opts: ConvertOptions): Record<string, unknown> {
  const method = entry.request.method.toUpperCase();
  const rawUrl = entry.request.url;
  const url = parameterizeUrl(rawUrl, opts.hostVars);
  const request: Record<string, unknown> = {
    method,
    url,
    headers: parameterizeRefHeaders(
      foldHeaders(entry.request.headers, opts.headerMode),
      opts.hostVars,
    ),
  };
  const body = wireBody(entry.request.postData);
  if (body) request.body = body;
  const status = entry.response?.status;
  const assert = opts.statusAssert && typeof status === "number" ? [{ status }] : [];
  return {
    id: newStepId(),
    name: `${method} ${pathOf(rawUrl)}`,
    type: "http",
    request,
    assert,
    extract: [],
  };
}

export function parseHar(text: string): Har {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${(e as Error).message}`);
  }
  const log = (json as { log?: { entries?: unknown } }).log;
  if (!log || !Array.isArray(log.entries)) throw new Error("log.entries 배열이 없습니다");
  if (log.entries.length === 0) throw new Error("HAR에 요청이 없습니다");
  return json as Har;
}

export function inferName(har: Har): string {
  const title = har.log.pages?.find((p) => p.title && p.title.trim())?.title?.trim();
  if (title) return title;
  for (const e of har.log.entries) {
    try {
      return new URL(e.request.url).host;
    } catch {
      // 파싱불가 URL은 건너뛰고 다음 entry
    }
  }
  return "Imported scenario";
}

export function harToScenarioYaml(har: Har, opts: ConvertOptions): string {
  const steps = selectEntries(har.log.entries, opts).map((e) => wireStep(e, opts));
  return stringify({ version: 1, name: opts.name, cookie_jar: "auto", variables: {}, steps });
}
