import { ko } from "../i18n/ko";
import { resolveForDisplay } from "../scenario/template";
import type { StepFacts } from "./scenarioFacts";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const TOK = "\uE000";
const OPEN = "\uE001";

/**
 * 자리표시자 `${…}`(첫 `}`까지 — 엔진·`resolveForDisplay`와 같은 닫힘 규칙)·`{{…}}`(첫 `}}`까지)를
 * 같은 길이의 TOK으로 가린다(위치 보존). 닫히지 않은 자리표시자부터 끝까지는 OPEN(모호).
 * 가린 문자열에서 구분자·`@`를 찾으므로 자리표시자 기본값 속 `/`·`@`는 판정에 끼지 않는다.
 */
function maskPlaceholders(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const close = s.startsWith("${", i) ? "}" : s.startsWith("{{", i) ? "}}" : null;
    if (close === null) {
      out += s[i];
      i += 1;
      continue;
    }
    const e = s.indexOf(close, i + 2);
    if (e === -1) return out + OPEN.repeat(s.length - i);
    const end = e + close.length;
    out += TOK.repeat(end - i);
    i = end;
  }
  return out;
}

/**
 * 가린 호스트 후보가 "호스트처럼 보이나": 자리표시자만 / IPv6 `[…]` / `localhost` / `.` 든 이름,
 * 끝에 `:숫자`·`:자리표시자` 포트 허용. 아니면 userinfo 조각일 수 있다.
 */
function looksLikeHost(masked: string): boolean {
  const h = masked.replace(/:(\d+|\uE000+)$/, "");
  if (h === "") return false;
  if (/^\uE000+$/.test(h)) return true;
  if (/^\[[0-9a-fA-F:.]+\]$/.test(h)) return true;
  if (/[:@\s\uE001]/.test(h)) return false;
  return h.toLowerCase() === "localhost" || h.includes(".");
}

/**
 * 스킴(또는 `//`·선두 자리표시자) 뒤 문자열 `t`의 권한부: 호스트 시작과 권한부 끝.
 * 권한부 = 자리표시자 밖 첫 `/`·`?`·`#` 앞까지, `@`는 그 안에서만 찾는다(쿼리·경로 속 `@`는 경로).
 * 호스트가 호스트처럼 보이지 않는데 뒤에 `@`가 또 있으면 userinfo에 날 `/`·`?`·`#`가 든 경우일 수 있어
 * 모호 → null(호출부는 아무 조각도 내보내지 않는다). 닫히지 않은 자리표시자가 권한부에 걸려도 null.
 */
function splitAuthority(t: string): { hostStart: number; end: number } | null {
  const m = maskPlaceholders(t);
  const cut = m.search(/[/?#\uE001]/);
  if (cut !== -1 && m[cut] === OPEN) return null;
  const end = cut === -1 ? t.length : cut;
  const auth = m.slice(0, end);
  const hostStart = auth.lastIndexOf("@") + 1;
  if (looksLikeHost(auth.slice(hostStart))) return { hostStart, end };
  if (t.indexOf("@", end) !== -1) return null;
  return { hostStart, end };
}

/** 권한부가 시작하는 문자열: 스킴 뒤 / `//` 뒤 / 자리표시자로 시작하면 전체. 그 밖 null. */
function authorityRest(s: string): string | null {
  const m = SCHEME.exec(s);
  if (m) return s.slice(m[0].length);
  if (s.startsWith("//")) return s.slice(2);
  if (s.startsWith("${") || s.startsWith("{{")) return s;
  return null;
}

/** 출력 호스트에서 자리표시자 기본값을 지운다(`${BASE:-…}` → `${BASE}`). */
function stripDefaults(h: string): string {
  return h.replace(/\$\{([^}]*?):-[^}]*\}/g, (_m, name: string) => "${" + name + "}");
}

/** 호스트(+포트)만 반환. 풀리지 않은 토큰이 호스트 자리에 있으면 원형 템플릿에서 호스트 부분만. "" = 건너뜀. */
export function hostOf(urlTemplate: string, env: Record<string, string>): string {
  const resolved = resolveForDisplay(urlTemplate, env);
  const rr = authorityRest(resolved);
  const ra = rr === null ? null : splitAuthority(rr);
  if (rr !== null && ra) {
    try {
      const u = new URL(resolved);
      // URL 파서와 구조 판정이 같은 호스트를 가리킬 때만 믿는다(어긋나면 자격증명 조각일 수 있다)
      const structural = rr.slice(ra.hostStart, ra.end).replace(/:\d*$/, "").toLowerCase();
      if (u.host && u.hostname === structural && !/[{$]/.test(u.host)) return u.host;
    } catch {
      // fall through to template fallback
    }
  }
  const rest = authorityRest(urlTemplate);
  if (rest === null) return "";
  const a = splitAuthority(rest);
  return a ? stripDefaults(rest.slice(a.hostStart, a.end)) : "";
}

export function targetSystems(steps: StepFacts[], env: Record<string, string>): string {
  const seen: string[] = [];
  for (const s of steps) {
    const h = hostOf(s.url, env);
    if (h && !seen.includes(h)) seen.push(h);
  }
  if (seen.length === 0) return ko.print.fmt.noTarget;
  if (seen.length <= 2) return seen.join(", ");
  return seen.slice(0, 2).join(", ") + ko.print.fmt.targetMore(seen.length - 2);
}

/** 풀지 않은 원형 경로. 쿼리는 `?…`, 프래그먼트는 제거. 권한부(자격증명 포함)는 절대 내보내지 않는다. */
export function displayPath(urlTemplate: string): string {
  let t = urlTemplate;
  if (!t.startsWith("/") || t.startsWith("//")) {
    const rest = authorityRest(t) ?? t;
    const a = splitAuthority(rest);
    if (!a) return "/";
    t = rest.slice(a.end);
  }
  if (!t.startsWith("/")) return "/";
  const hash = t.indexOf("#");
  if (hash !== -1) t = t.slice(0, hash);
  const q = t.indexOf("?");
  if (q !== -1) t = t.slice(0, q) + "?…";
  return t;
}

export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) * 0.6);
  const tail = max - 1 - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

export function requestLine(method: string, urlTemplate: string): string {
  return `${method} ${displayPath(urlTemplate)}`;
}

/** 6.8pt 영문 평균 글자 폭 ≈ 1.3mm. */
export function requestLineBudget(nameColMm: number): number {
  return Math.max(24, Math.floor(nameColMm / 1.3));
}
