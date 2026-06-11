/**
 * 홈 시작 가이드(U2, spec §3.1)의 진행 플래그.
 * ①(시나리오 존재)은 서버 진실이므로 여기 없음 — ②(run 생성)·③(리포트 열람)·dismiss만 저장.
 * localStorage 불가 환경(사파리 프라이빗 등)에선 조용히 no-op (가이드는 항상 미완으로 보임).
 */
export type OnboardingState = {
  runCreated: boolean;
  reportViewed: boolean;
  dismissed: boolean;
};

const KEY = "handicap.onboarding.v1";

const DEFAULTS: OnboardingState = {
  runCreated: false,
  reportViewed: false,
  dismissed: false,
};

export function readOnboarding(): OnboardingState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULTS };
    }
    const o = parsed as Record<string, unknown>;
    return {
      runCreated: o.runCreated === true,
      reportViewed: o.reportViewed === true,
      dismissed: o.dismissed === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch: Partial<OnboardingState>): void {
  try {
    const next = { ...readOnboarding(), ...patch };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // fail-soft: 저장 불가면 가이드가 계속 보일 뿐, 기능엔 영향 없음
  }
}

export function markRunCreated(): void {
  write({ runCreated: true });
}

export function markReportViewed(): void {
  write({ reportViewed: true });
}

export function dismissOnboarding(): void {
  write({ dismissed: true });
}
