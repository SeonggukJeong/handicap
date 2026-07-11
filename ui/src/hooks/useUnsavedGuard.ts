import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * 저장 안 됨 이탈 가드 (spec 2026-07-12-unsaved-changes-guard §4.2).
 * dirty일 때 pathname이 바뀌는 라우터 이동을 차단(useBlocker)하고, dirty일 때만
 * beforeunload 브라우저 확인창을 켠다. bypassNext()는 의도된 프로그램적 이동
 * (생성 성공·복제 확정) 1회를 통과시키는 one-shot 플래그.
 *
 * 주의 1 — react-router는 라우터당 blocker 1개만 지원한다: 이 훅은 상호배타로
 * 마운트되는 leaf 라우트(에디터 페이지)에서만 호출할 것(동시 마운트 금지).
 * 주의 2 — bypass 소비는 dirty 검사보다 반드시 먼저(무조건): dirty 검사 뒤에
 * 두면 clean 이동에서 short-circuit로 플래그가 잔존해, param-only 이동으로
 * 살아남은 컴포넌트의 나중 dirty 이동을 조용히 통과시킨다(spec §3-5).
 */
export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypassRef = useRef(false);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypassRef.current) {
      bypassRef.current = false; // one-shot 무조건 소비 — 순서 normative
      return false;
    }
    return dirtyRef.current && currentLocation.pathname !== nextLocation.pathname;
  });

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 레거시 브라우저 경로 (Chrome <119 등) — 모던은 preventDefault만으로 충분
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const bypassNext = () => {
    bypassRef.current = true;
  };

  return { blocker, bypassNext };
}
