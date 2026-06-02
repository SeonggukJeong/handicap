/**
 * JSON request body의 캐스트 토큰 검증 (엔진: executor.rs / cast.rs와 짝).
 * v1은 STANDALONE JSON 문자열 leaf의 `{{var:num}}`/`{{var:bool}}`(+선택 `:str`)만
 * 지원한다. 반환 배열이 비면 valid. 캐스트 없는 토큰·리터럴은 절대 flag하지 않는다.
 */
const CAST_KEYWORDS: readonly string[] = ["str", "num", "bool"];

const FLOW_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ENV_TOKEN = /\$\{([^}]*)\}/g;
const PURE_FLOW = /^\{\{\s*([^{}]*?)\s*\}\}$/;

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
  const pure = PURE_FLOW.exec(s.trim());
  const pureInner = pure ? pure[1] : null;

  let m: RegExpExecArray | null;
  FLOW_TOKEN.lastIndex = 0;
  while ((m = FLOW_TOKEN.exec(s)) !== null) {
    const inner = m[1];
    const cast = trailingCast(inner);
    if (cast === null) continue; // 캐스트 시도 아님
    if (!CAST_KEYWORDS.includes(cast)) {
      errors.push(`unknown cast ':${cast}' in {{${inner}}} — use :num, :bool, or :str`);
    } else if (pureInner !== inner) {
      errors.push(`cast ':${cast}' only applies to a standalone value, not inside "${s}"`);
    }
  }

  ENV_TOKEN.lastIndex = 0;
  while ((m = ENV_TOKEN.exec(s)) !== null) {
    const cast = trailingCast(m[1]);
    if (cast !== null && CAST_KEYWORDS.includes(cast)) {
      errors.push(`env/system token cast not supported yet — flow {{var}} only (in \${${m[1]}})`);
    }
  }
}

/** 토큰 inner의 trailing `:word` 캐스트 keyword, 없으면 null. env 기본값 연산자
 *  `:-default`는 제외(캐스트 콜론 앞은 `-`가 아님). 콜론 뒤 공백은 허용 —
 *  엔진 parse_cast_leaf이 `kw.trim()`이라 `{{ age : num }}`도 캐스트로 보기 때문(lockstep). */
function trailingCast(inner: string): string | null {
  const m = /(?:^|[^-]):\s*([A-Za-z][A-Za-z0-9]*)$/.exec(inner);
  return m ? m[1] : null;
}
