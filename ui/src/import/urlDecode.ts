// HAR 가져오기 URL 안전 디코딩 (spec 2026-07-12-har-query-decode-design.md).
// 허용 = 공백(0x20)·비ASCII 가시 문자만 디코딩. 그 외 escape는 원문 텍스트 그대로 보존
// (구조·템플릿 문자를 못 만들므로 전송 바이트 불변 — 엔진 reqwest가 재인코딩).

const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
// 비ASCII 판정: 제어·포맷·구분자(보이지 않는 문자)는 YAML 유령문자 방지 위해 보존.
const INVISIBLE = /[\p{C}\p{Z}]/u;
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decodeRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return run; // 깨진 UTF-8 → run 전체 원문 보존 (R4)
  }
  let out = "";
  let byteIdx = 0;
  for (const ch of text) {
    const nBytes = encoder.encode(ch).length;
    const cp = ch.codePointAt(0) ?? 0;
    const allowed = cp === 0x20 || (cp >= 0x80 && !INVISIBLE.test(ch));
    // 비허용 문자는 run에서 그 문자의 원문 escape(바이트당 3글자)를 슬라이스 — hex 케이스 보존 (R2)
    out += allowed ? ch : run.slice(byteIdx * 3, (byteIdx + nBytes) * 3);
    byteIdx += nBytes;
  }
  return out;
}

// 연속 %XX run만 치환 — 그 외 문자는 절대 건드리지 않는다(잘린 escape·raw + 포함).
export function safeDecodeComponent(s: string): string {
  return s.replace(ESCAPE_RUN, decodeRun);
}

// scheme://authority 프리픽스와 #fragment를 보존하고 경로+쿼리에만 적용.
// new URL 재직렬화를 쓰지 않아 호스트 정규화 부수효과가 없고 상대·${VAR} URL도 균일 처리 (R3).
export function safeDecodeUrl(url: string): string {
  const hashIdx = url.indexOf("#");
  const frag = hashIdx === -1 ? "" : url.slice(hashIdx);
  const head = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const prefix = AUTHORITY.exec(head)?.[0] ?? "";
  return prefix + safeDecodeComponent(head.slice(prefix.length)) + frag;
}
