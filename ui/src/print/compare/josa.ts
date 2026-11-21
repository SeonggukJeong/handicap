// 값 뒤 조사를 끝소리(마지막으로 읽히는 음절의 받침)에 맞춘다. 끝소리를 모르면 두 꼴을 함께 쓴다.

export type JosaPair = "으로/로" | "이/가" | "은/는" | "을/를";

type Final = "none" | "rieul" | "other";

const FORMS: Record<JosaPair, { withFinal: string; without: string; unknown: string }> = {
  "으로/로": { withFinal: "으로", without: "로", unknown: "(으)로" },
  "이/가": { withFinal: "이", without: "가", unknown: "(이)가" },
  "은/는": { withFinal: "은", without: "는", unknown: "(은)는" },
  "을/를": { withFinal: "을", without: "를", unknown: "(을)를" },
};

// 0 영 · 1 일 · 2 이 · 3 삼 · 4 사 · 5 오 · 6 육 · 7 칠 · 8 팔 · 9 구
const DIGIT_FINAL: Final[] = [
  "other",
  "rieul",
  "none",
  "other",
  "none",
  "none",
  "other",
  "rieul",
  "rieul",
  "none",
];

const SKIPPED = new Set([")", "]", "}", "'", '"', "’", "”", "」", "』", " "]);

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const RIEUL_FINAL = 8;

function finalOf(word: string): Final | null {
  let end = word.length;
  while (end > 0 && SKIPPED.has(word[end - 1])) end -= 1;
  if (end === 0) return null;
  const text = word.slice(0, end);
  if (text.endsWith("ms")) return "none"; // 밀리초
  const ch = text[end - 1];
  if (ch === "%") return "none"; // 퍼센트
  if (ch >= "0" && ch <= "9") return DIGIT_FINAL[Number(ch)];
  const code = ch.charCodeAt(0);
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return null;
  const jong = (code - HANGUL_FIRST) % 28;
  if (jong === 0) return "none";
  return jong === RIEUL_FINAL ? "rieul" : "other";
}

export function josa(word: string, pair: JosaPair): string {
  const f = FORMS[pair];
  const fin = finalOf(word);
  if (fin === null) return f.unknown;
  if (fin === "none") return f.without;
  if (fin === "rieul" && pair === "으로/로") return f.without;
  return f.withFinal;
}
