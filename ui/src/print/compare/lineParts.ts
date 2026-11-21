// 요약 문장 조각: 굵은 부분(값·판정 낱말)과 보통 글을 나눠 두고, 글 전체는 조각을 이어 만든다.

export type LineTone = "ok" | "bad";
export type LinePart = { text: string; strong?: true; tone?: LineTone };

export const plain = (text: string): LinePart => ({ text });

export const strong = (text: string, tone?: LineTone): LinePart =>
  tone ? { text, strong: true, tone } : { text, strong: true };

const sameLook = (a: LinePart, b: LinePart): boolean => a.strong === b.strong && a.tone === b.tone;

/** 조각 목록들을 이어 붙이고, 모양이 같은 이웃 조각은 하나로 합친다(빈 조각은 버린다). */
export function joinParts(...lists: LinePart[][]): LinePart[] {
  const out: LinePart[] = [];
  for (const p of lists.flat()) {
    if (p.text === "") continue;
    const last = out[out.length - 1];
    if (last && sameLook(last, p)) out[out.length - 1] = { ...last, text: last.text + p.text };
    else out.push(p);
  }
  return out;
}

export const partsText = (parts: LinePart[]): string => parts.map((p) => p.text).join("");
