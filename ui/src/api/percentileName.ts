// 백분위 판정 기준 이름 문법 — 서버 crates/controller/src/percentile_name.rs와 같은 규칙
// (공유 표 testdata/percentile_metric_cases.json). 정본 이름 = `p` + N + `_ms`.

const NUMBER_RE = /^(0|[1-9][0-9]?)(\.[0-9]{1,3})?$/;

function canonicalNumber(text: string): number | null {
  if (!NUMBER_RE.test(text)) return null;
  const x = Number(text);
  if (!(x > 0 && x < 100)) return null;
  if (Math.abs(x * 1000 - Math.round(x * 1000)) >= 1e-6) return null;
  return x;
}

/** 정본 이름(`p99.9_ms`)이면 N, 아니면 null. 정본으로 다시 쓴 글자와 같아야 한다. */
export function parsePercentileMetric(name: string): number | null {
  if (!name.startsWith("p") || !name.endsWith("_ms")) return null;
  const mid = name.slice(1, -3);
  const n = canonicalNumber(mid);
  if (n === null) return null;
  return String(n) === mid ? n : null;
}

/** 입력 글자(`90`, `99.90`) → 정본 이름. 0 < N < 100·소수 3자리까지가 아니면 null. */
export function percentileMetricName(input: string): string | null {
  const n = canonicalNumber(input.trim());
  return n === null ? null : `p${n}_ms`;
}
