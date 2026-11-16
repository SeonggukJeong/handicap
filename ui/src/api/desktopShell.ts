import { z } from "zod";

// 데스크톱 셸이 컨트롤러가 서빙하는 페이지에 심는 표지(`window.__HANDICAP_DESKTOP__`).
// 필드는 정확히 하나 — 여분 필드(토큰 등)가 끼면 표지로 인정하지 않는다.
export const DesktopShellSchema = z.object({ rolePageUrl: z.string().min(1) }).strict();

export function readDesktopShell(w: unknown = window): { rolePageUrl: string } | null {
  const raw = (w as Record<string, unknown> | null | undefined)?.__HANDICAP_DESKTOP__;
  const parsed = DesktopShellSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
