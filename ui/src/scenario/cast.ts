/**
 * JSON request body의 캐스트 토큰 검증 (엔진: executor.rs / cast.rs와 짝).
 * STANDALONE JSON 문자열 leaf의 `{{var:num|bool|str|json}}`/`${var:num|bool|str|json}`을
 * 지원한다(flow·env/시스템 토큰 둘 다). 반환 배열이 비면 valid.
 * 캐스트 없는 토큰·리터럴·`${VAR:-default}`는 절대 flag하지 않는다.
 */
export const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool", "json"];

const FLOW_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ENV_TOKEN = /\$\{([^}]*)\}/g;
const PURE_FLOW = /^\{\{\s*([^{}]*?)\s*\}\}$/;
const PURE_ENV = /^\$\{([^}]*)\}$/;

export function jsonBodyCastErrors(value: unknown): string[] {
  const errors: string[] = [];
  walk(value, errors);
  return errors;
}

function walk(v: unknown, errors: string[]): void {
  if (typeof v === "string") checkLeaf(v, errors);
  else if (Array.isArray(v)) for (const item of v) walk(item, errors);
  else if (v !== null && typeof v === "object")
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, errors);
}

function checkLeaf(s: string, errors: string[]): void {
  const trimmed = s.trim();
  const pureFlow = PURE_FLOW.exec(trimmed);
  const pureFlowInner = pureFlow ? pureFlow[1] : null;
  const pureEnv = PURE_ENV.exec(trimmed);
  const pureEnvInner = pureEnv ? pureEnv[1] : null;

  let m: RegExpExecArray | null;

  FLOW_TOKEN.lastIndex = 0;
  while ((m = FLOW_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in {{${inner}}} — use :num, :bool, :str, or :json`);
    } else if (pureFlowInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }

  ENV_TOKEN.lastIndex = 0;
  while ((m = ENV_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님(`${VAR:-default}` 포함)
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in \${${inner}} — use :num, :bool, :str, or :json`);
    } else if (pureEnvInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }
}

/** 토큰 inner의 trailing `:word` 캐스트 keyword, 없으면 null. env 기본값 연산자
 *  `:-default`는 제외(캐스트 콜론 앞은 `-`가 아님). 콜론 뒤 공백은 허용 —
 *  엔진 parse_cast_leaf이 `kw.trim()`이라 `{{ age : num }}`도 캐스트로 보기 때문(lockstep). */
export function trailingCast(inner: string): string | null {
  const m = /(?:^|[^-]):\s*([A-Za-z][A-Za-z0-9]*)$/.exec(inner);
  return m ? m[1] : null;
}
