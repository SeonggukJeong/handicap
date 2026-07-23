import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent, RefObject } from "react";

/** min/max 짝 정수 입력의 draft 상태기계 — `useThinkTimePair`(ThinkTime{min_ms,max_ms} +
 *  {0,0}="think 없음" 특수 의미론에 결합된 훅)의 파트너-hold·재시드 규칙을 **미러**하되
 *  직접 재사용하지 않는다:
 *  - `GenSpec.random_int`의 `{min,max}`는 `ThinkTime`과 필드명·의미가 다르고, 0은 그냥
 *    유효한 정수값이라(think time처럼 "0=미설정" sentinel이 없다) `useThinkTimePair`의
 *    4분기(clear/noop/commit/revert) 중 "clear"(빈 값→undefined 키 삭제로 커밋)가
 *    통째로 불필요하다.
 *  - "revert"(불합격 시 draft를 마지막 커밋값으로 되돌림)도 이 필드엔 요구되지 않는다 —
 *    UI 계약(§spec 6.2/브리프): "아니면 draft 보존 no-op(빈 칸 revert 금지 — S-B 가드)".
 *  남는 건 2분기뿐: 둘 다 유효 정수 && min<=max → commit / 그 외 → no-op(draft 보존,
 *  아무것도 되돌리지 않는다).
 *
 *  파트너-hold 메커니즘(`partner.current !== null` 필수 — 없으면 미마운트 시 null===null로
 *  전 커밋이 조용히 사라진다)과 재시드 원시값 dep 규칙(객체 dep 금지 — 표에서 한 행 커밋이
 *  다른 행의 draft를 날린다)은 `useThinkTimePair`와 동일 함정이 그대로 적용된다. */

export type IntPairFieldProps = {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
  // `RefObject<HTMLInputElement>`(=`useRef<HTMLInputElement>(null)`) — `RefObject<HTMLInputElement | null>`은
  // `pnpm test`(esbuild)는 통과하지만 `pnpm build`(`tsc -b`)가 네이티브 `<input ref>` 스프레드에서
  // TS2322로 거부한다(useThinkTimePair.ts의 동일 함정 노트 참고).
  ref: RefObject<HTMLInputElement>;
};

function parseValidInt(s: string): number | null {
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

export function useIntPairDraft({
  value,
  resetKey,
  onCommit,
}: {
  value: { min: number; max: number } | null;
  resetKey?: string;
  onCommit: (min: number, max: number) => void;
}): {
  minProps: IntPairFieldProps;
  maxProps: IntPairFieldProps;
} {
  const cfgMin = value?.min;
  const cfgMax = value?.max;

  const [minDraft, setMinDraft] = useState(cfgMin === undefined ? "" : String(cfgMin));
  const [maxDraft, setMaxDraft] = useState(cfgMax === undefined ? "" : String(cfgMax));

  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);

  const reseed = useCallback(() => {
    setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
    setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
  }, [cfgMin, cfgMax]);

  useEffect(() => {
    reseed();
  }, [resetKey, reseed]);

  const commit = () => {
    const minN = parseValidInt(minDraft);
    const maxN = parseValidInt(maxDraft);
    if (minN === null || maxN === null || minN > maxN) return; // no-op — draft 보존
    onCommit(minN, maxN);
  };

  const blurHandler =
    (partner: RefObject<HTMLInputElement>) => (e: FocusEvent<HTMLInputElement>) => {
      // `partner.current !== null`이 필수다 — 빼면 relatedTarget과 partner가 둘 다 null일
      // 때 null === null이 참이 되어 모든 커밋이 조용히 사라진다(useThinkTimePair 함정 그대로).
      if (partner.current !== null && e.relatedTarget === partner.current) return;
      commit();
    };

  return {
    minProps: {
      value: minDraft,
      onChange: (e) => setMinDraft(e.target.value),
      onBlur: blurHandler(maxRef),
      ref: minRef,
    },
    maxProps: {
      value: maxDraft,
      onChange: (e) => setMaxDraft(e.target.value),
      onBlur: blurHandler(minRef),
      ref: maxRef,
    },
  };
}
