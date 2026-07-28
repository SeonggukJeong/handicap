import { describe, expect, it } from "vitest";
import type { Environment } from "../../api/environments";
import type { PreviewEntry } from "../filters";
import {
  buildEnvInput,
  defaultHostVars,
  hostsByRequestCount,
  matchHostsToEnvs,
  originOf,
  resolveHostVars,
  validateEnv,
  type HostEnvMatch,
} from "../hostEnv";

const preview: PreviewEntry[] = [
  { index: 0, method: "GET", url: "https://api.example.com/a" },
  { index: 1, method: "GET", url: "https://cdn.example.com/b" },
  { index: 2, method: "GET", url: "https://api.example.com/c" }, // api 2회
];

describe("hostEnv (R8/R10/R11)", () => {
  it("hostsByRequestCount: 요청 수 desc, 동률 first-seen", () => {
    expect(hostsByRequestCount(preview)).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("defaultHostVars: 첫 BASE_URL, 이후 BASE_URL_2…", () => {
    expect(defaultHostVars(["api.example.com", "cdn.example.com"])).toEqual({
      "api.example.com": "BASE_URL",
      "cdn.example.com": "BASE_URL_2",
    });
  });

  it("originOf: first-seen origin", () => {
    expect(originOf("api.example.com", preview)).toBe("https://api.example.com");
  });

  it("buildEnvInput: {name, vars:{변수명: origin}}", () => {
    const input = buildEnvInput(
      { "api.example.com": "BASE_URL", "cdn.example.com": "CDN" },
      preview,
      "  스테이징  ",
    );
    expect(input).toEqual({
      name: "스테이징",
      vars: { BASE_URL: "https://api.example.com", CDN: "https://cdn.example.com" },
    });
  });

  it("validateEnv: 정상이면 ok", () => {
    expect(validateEnv({ "a.com": "BASE_URL" }, "env").ok).toBe(true);
  });

  it("validateEnv: 빈/패턴위반/중복/빈환경이름이면 ok=false", () => {
    expect(validateEnv({ "a.com": "" }, "env").ok).toBe(false);
    expect(validateEnv({ "a.com": "1bad" }, "env").invalidHosts).toEqual(["a.com"]);
    expect(validateEnv({ "a.com": "X", "b.com": "X" }, "env").dupNames).toEqual(["X"]);
    expect(validateEnv({ "a.com": "BASE_URL" }, "   ").ok).toBe(false);
  });

  it("validateEnv: 예약어는 soft 경고지만 ok에 영향 없음", () => {
    const v = validateEnv({ "a.com": "vu_id" }, "env");
    expect(v.reservedHosts).toEqual(["a.com"]);
    expect(v.ok).toBe(true);
  });
});

// 픽스처 헬퍼 (테스트 파일 로컬)
const env = (id: string, name: string, vars: Record<string, string>, updated = 1): Environment => ({
  id,
  name,
  vars,
  created_at: 1,
  updated_at: updated,
});
const pv = (...urls: string[]): PreviewEntry[] =>
  urls.map((url, index) => ({ url, method: "GET", index }));

describe("matchHostsToEnvs", () => {
  const preview = pv("https://api.example.com/users", "https://cdn.example.com/a.js");
  const hosts = ["api.example.com", "cdn.example.com"];

  it("origin 정확 일치만 매치 — 값 후행 슬래시는 흡수", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "스테이징", { BASE_URL: "https://api.example.com/" }),
    ]);
    expect(out["api.example.com"]).toEqual([
      { envId: "E1", envName: "스테이징", varName: "BASE_URL" },
    ]);
    expect(out["cdn.example.com"]).toBeUndefined();
  });

  it("경로/쿼리/해시 붙은 값·URL 파싱 불가 값은 제외", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "경로", { A: "https://api.example.com/api" }),
      env("E2", "쿼리", { B: "https://api.example.com/?x=1" }),
      env("E3", "해시", { C: "https://api.example.com/#f" }),
      env("E4", "비URL", { D: "그냥 문자열" }),
    ]);
    expect(out).toEqual({});
  });

  it("다중 매치는 updated_at desc → 이름 asc 정렬", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "b-old", { X: "https://api.example.com" }, 10),
      env("E2", "a-new", { Y: "https://api.example.com" }, 20),
      env("E3", "a-old", { Z: "https://api.example.com" }, 10),
    ]);
    expect(out["api.example.com"].map((m) => m.envId)).toEqual(["E2", "E3", "E1"]);
  });

  it("한 환경 안 다중 일치는 var 이름 asc 첫 1건", () => {
    const out = matchHostsToEnvs(hosts, preview, [
      env("E1", "s", { ZZZ: "https://api.example.com", AAA: "https://api.example.com" }),
    ]);
    expect(out["api.example.com"]).toEqual([{ envId: "E1", envName: "s", varName: "AAA" }]);
  });

  it("빈 envs → 빈 결과", () => {
    expect(matchHostsToEnvs(hosts, preview, [])).toEqual({});
  });

  // S-I1 (security Important): non-special scheme의 URL.origin은 문자열 "null" —
  // env 값·HAR host 양쪽에서 이 리터럴이 동치가 되어 거짓 매칭이 생긴다.
  it("S-I1: env 값이 non-special scheme(mysql://…, pure-origin 형태)이면 매치 안 됨", () => {
    // HAR의 유일한 엔트리도 non-special(webcal://) — origin이 old code에서 "null" 문자열로 반환돼
    // env 값(mysql://…)의 pure-origin("null")과 거짓 동치가 났던 경로를 그대로 재현한다.
    const nonSpecialPreview = pv("webcal://api.example.com/cal");
    const out = matchHostsToEnvs(["api.example.com"], nonSpecialPreview, [
      env("E1", "db-env", { DB: "mysql://db.example.com/" }),
    ]);
    expect(out).toEqual({});
  });

  it("S-I1/S-I2: preview가 non-special scheme(webcal://)뿐인 host는 결과에서 제외됨", () => {
    const mixedPreview = pv("https://api.example.com/x", "webcal://cal.example.com/x");
    const out = matchHostsToEnvs(["api.example.com", "cal.example.com"], mixedPreview, [
      env("E1", "s", { BASE_URL: "https://api.example.com" }),
      // "null" pure-origin과 거짓 동치될 수 있는 후보 — cal.example.com에 안 붙어야 함
      env("E2", "db", { DB: "mysql://anything/" }),
    ]);
    expect(out["cal.example.com"]).toBeUndefined();
    expect(out["api.example.com"]).toEqual([{ envId: "E1", envName: "s", varName: "BASE_URL" }]);
  });
});

describe("resolveHostVars", () => {
  const m = (varName: string): HostEnvMatch[] => [{ envId: "E1", envName: "s", varName }];

  it("우선순위: override > 매치 > 기본", () => {
    expect(
      resolveHostVars(["a.com", "b.com", "c.com"], { "b.com": m("API_URL") }, { "a.com": "MINE" }),
    ).toEqual({ "a.com": "MINE", "b.com": "API_URL", "c.com": "BASE_URL_3" });
  });

  it("매치 0건·override 0건 → defaultHostVars와 동일 (R8)", () => {
    expect(resolveHostVars(["a.com", "b.com"], {}, {})).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL_2",
    });
  });

  it("두 행 같은 매치명 → 뒤 행은 defaults 폴백 (FR1)", () => {
    const matches = { "a.com": m("BASE_URL"), "b.com": m("BASE_URL") };
    expect(resolveHostVars(["a.com", "b.com"], matches, {})).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL_2",
    });
  });

  it("뒤 행 override + 앞 행 같은 이름 매치 → 앞 행 defaults 폴백 (MF1 시드)", () => {
    expect(
      resolveHostVars(["a.com", "b.com"], { "a.com": m("API_URL") }, { "b.com": "API_URL" }),
    ).toEqual({ "a.com": "BASE_URL", "b.com": "API_URL" });
  });

  it("stale override(목록 밖 host)는 이름 예약 안 함", () => {
    expect(
      resolveHostVars(["a.com"], { "a.com": m("API_URL") }, { "gone.com": "API_URL" }),
    ).toEqual({ "a.com": "API_URL" });
  });

  it("매치 0건 + override가 다른 행 기본명과 충돌 → 기본명 유지 (R8 byte-identical)", () => {
    expect(resolveHostVars(["a.com", "b.com"], {}, { "b.com": "BASE_URL" })).toEqual({
      "a.com": "BASE_URL",
      "b.com": "BASE_URL",
    });
  });

  it("기본명까지 점유되면 BASE_URL_{k} k=2부터 첫 미사용", () => {
    // 앞 행 매치가 뒤 행 기본명(BASE_URL_2)을 점유 → 뒤 행은 BASE_URL_3
    const matches = { "a.com": m("BASE_URL_2") };
    expect(resolveHostVars(["a.com", "b.com"], matches, {})).toEqual({
      "a.com": "BASE_URL_2",
      "b.com": "BASE_URL_3",
    });
  });

  it("자격 미달 매치명(형식 위반·예약어)은 프리필 제외", () => {
    expect(resolveHostVars(["a.com"], { "a.com": m("my-var") }, {})).toEqual({
      "a.com": "BASE_URL",
    });
    expect(resolveHostVars(["a.com"], { "a.com": m("vu_id") }, {})).toEqual({
      "a.com": "BASE_URL",
    });
  });

  it("override 빈 문자열도 override로 존중 (기존 ?? 시맨틱)", () => {
    expect(resolveHostVars(["a.com"], { "a.com": m("API_URL") }, { "a.com": "" })).toEqual({
      "a.com": "",
    });
  });

  // F1 (final review): BASE_URL_{k} 루프의 overrideNames-단독 스킵 분기 —
  // b.com 후보 BASE_URL_2는 usedByPrefill(a.com)이 점유, k=3은 overrideNames(c.com override)가
  // 점유 → k=4까지 진행해야 한다. 이 분기가 없으면 b.com이 BASE_URL_3을 잡아 c.com override와는
  // 안 겹치지만(override가 뒤에 별도 out[h]=o로 덮으므로) "점유된 이름을 건너뛴다"는 불변식이 깨진다.
  it("BASE_URL_{k} 생성 시 usedByPrefill과 overrideNames를 모두 건너뛴다 (F1)", () => {
    expect(
      resolveHostVars(
        ["a.com", "b.com", "c.com"],
        { "a.com": m("BASE_URL_2") },
        { "c.com": "BASE_URL_3" },
      ),
    ).toEqual({ "a.com": "BASE_URL_2", "b.com": "BASE_URL_4", "c.com": "BASE_URL_3" });
  });
});
