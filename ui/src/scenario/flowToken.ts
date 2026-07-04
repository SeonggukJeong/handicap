// 엔진 CAST_KEYWORDS와 동일 목록(cast.ts). 무의존 유지를 위해 여기서 재선언하고,
// flowToken.test.ts가 cast.ts의 것과 동치임을 단언해 드리프트를 막는다(spec §3-1/§4.1).
const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool", "json"];

// cast.ts::trailingCast와 동일 정규식 — trailing `:kw`를 `kw ∈ CAST_KEYWORDS`일 때만 cast로 분리.
const TRAILING_CAST = /(?:^|[^-]):\s*([A-Za-z][A-Za-z0-9]*)$/;

/**
 * `{{INNER}}` 토큰의 inner를 base 변수명과 optional cast로 분리한다.
 * trailing `:kw`는 kw가 엔진 CAST_KEYWORDS(str/num/bool/json)일 때만 cast로 떼고,
 * 그 외 `:word`는 base의 일부다(엔진은 `{{count:foo}}`를 변수명 `count:foo`로 읽는다).
 * base는 trim된다. 순수·무의존.
 */
export function splitFlowToken(inner: string): { base: string; cast: string | null } {
  const m = TRAILING_CAST.exec(inner);
  if (m && CAST_KEYWORDS.includes(m[1])) {
    // 매치된 콜론 = 마지막 콜론(뒤엔 `\s*kw$`뿐, 콜론 없음).
    const colon = inner.lastIndexOf(":");
    return { base: inner.slice(0, colon).trim(), cast: m[1] };
  }
  return { base: inner.trim(), cast: null };
}
