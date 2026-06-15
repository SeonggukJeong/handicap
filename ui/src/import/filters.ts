// HAR 1.2 (필요한 부분만). request.headers / postData.params는 배열이다.
export interface HarHeader {
  name: string;
  value: string;
}
export interface HarPostParam {
  name: string;
  value?: string;
}
export interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: HarPostParam[];
}
export interface HarRequest {
  method: string;
  url: string;
  headers?: HarHeader[];
  postData?: HarPostData;
}
export interface HarResponse {
  status?: number;
  content?: { mimeType?: string };
}
export interface HarEntry {
  request: HarRequest;
  response?: HarResponse;
}
export interface HarPage {
  title?: string;
}
export interface Har {
  log: { entries: HarEntry[]; pages?: HarPage[] };
}

// 정적 리소스: 확장자 또는 응답 content-type.
const STATIC_EXT =
  /\.(jpe?g|png|gif|webp|svg|ico|bmp|css|m?js|woff2?|ttf|otf|eot|map|mp4|webm|mp3|wav|pdf)(\?|#|$)/i;
const STATIC_CT =
  /^(image\/|font\/|video\/|audio\/|text\/css|application\/javascript|text\/javascript)/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function isStaticAsset(entry: HarEntry): boolean {
  if (STATIC_EXT.test(pathOf(entry.request.url))) return true;
  return STATIC_CT.test(entry.response?.content?.mimeType ?? "");
}

export function entryHost(entry: HarEntry): string | null {
  try {
    return new URL(entry.request.url).host;
  } catch {
    return null;
  }
}

export function distinctHosts(entries: HarEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const h = entryHost(e);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

export interface SelectOptions {
  excludeStatic: boolean;
  includedHosts: ReadonlySet<string> | null; // null = 모든 호스트
  excludedIndices: ReadonlySet<number>; // har.log.entries 기준 인덱스
}

export function selectEntries(entries: HarEntry[], opts: SelectOptions): HarEntry[] {
  return entries.filter((e, i) => {
    if (opts.excludedIndices.has(i)) return false;
    if (opts.excludeStatic && isStaticAsset(e)) return false;
    if (opts.includedHosts) {
      const h = entryHost(e);
      // 파싱불가(상대) URL = null host는 호스트 체크박스로 못 거르므로 항상 통과(미리보기와 일치).
      // 요청별 체크박스(excludedIndices)로만 제외 가능.
      if (h !== null && !opts.includedHosts.has(h)) return false;
    }
    return true;
  });
}
