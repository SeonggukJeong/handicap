import { expect } from "vitest";

/** NaN·Infinity·undefined 값과 그 글자가 든 문자열이 어디에도 없다(JSON.stringify는 NaN을 null로 바꿔 못 잡는다). */
export function expectClean(v: unknown, path = "$"): void {
  if (typeof v === "number") expect(Number.isFinite(v), path).toBe(true);
  else if (v === undefined) throw new Error(`undefined at ${path}`);
  else if (typeof v === "string") {
    expect(v.includes("NaN"), path).toBe(false);
    expect(v.includes("undefined"), path).toBe(false);
  } else if (Array.isArray(v)) v.forEach((x, i) => expectClean(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) expectClean(x, `${path}.${k}`);
  }
}
