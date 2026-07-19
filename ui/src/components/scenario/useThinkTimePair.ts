import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent, RefObject } from "react";
import { resolveThinkDraft } from "../../scenario/thinkTime";
import type { ThinkTime } from "../../scenario/model";

export type ThinkPairFieldProps = {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
  // `RefObject<HTMLInputElement>`(= `useRef<HTMLInputElement>(null)`), *not*
  // `RefObject<HTMLInputElement | null>` — @types/react 18.3.12의 `RefObject<T>`는
  // `current`가 readonly라 T에 대해 공변(covariant)으로 측정되고, JSX 네이티브
  // `<input ref>`는 정확히 `RefObject<HTMLInputElement>`를 기대한다. `T=HTMLInputElement|null`을
  // 쓰면 `pnpm test`(esbuild)는 통과하지만 `pnpm build`(`tsc -b`)가 "`HTMLInputElement|null`이
  // `HTMLInputElement`에 할당 불가"로 거부한다(런타임 `.current` 값 자체는 항상
  // `T|null`이라 동일 — 순수 제네릭 인자 표기 문제).
  ref: RefObject<HTMLInputElement>;
};

/** min/max 짝 입력의 draft 상태기계 + 커밋 시점 판정 단일 소스.
 *
 *  4분기 *규칙*은 thinkTime.ts::resolveThinkDraft가 소유하고(0-diff), 여기선
 *  ① 규칙을 언제 돌릴지 ② outcome에 따른 setState/콜백 호출만 한다.
 *
 *  커밋 경계는 "입력을 떠날 때"가 아니라 "**짝**을 떠날 때"다. min→max 포커스
 *  이동의 암묵 blur를 커밋으로 취급하면 중간 쌍({new_min, old_max})이 min>max로
 *  판정돼 revert로 떨어지고, 사용자가 방금 친 값이 사라진다(범위를 올릴 때만
 *  발현 — 내릴 땐 중간 쌍이 유효해서 조용히 부분 커밋된다).
 *
 *  재시드 dep은 반드시 **원시값**이다. 객체 dep을 쓰면 표(ThinkTimeBoard)에서
 *  한 행을 커밋할 때 모든 행이 재생성돼 다른 행에 반쯤 친 값이 날아간다. */
export function useThinkTimePair({
  value,
  resetKey,
  onCommit,
  onClear,
}: {
  value: ThinkTime | undefined;
  resetKey?: string;
  onCommit: (v: ThinkTime) => void;
  onClear: () => void;
}): {
  minProps: ThinkPairFieldProps;
  maxProps: ThinkPairFieldProps;
  reseed: () => void;
} {
  // 시드는 `=== undefined` 비교다. truthy 검사로 원시값을 쓰면 0이 falsy라
  // {0,0}이 빈 칸으로 시드되고 다음 blur가 clear로 떨어져 키를 지운다.
  const cfgMin = value?.min_ms;
  const cfgMax = value?.max_ms;

  const [minDraft, setMinDraft] = useState(cfgMin === undefined ? "" : String(cfgMin));
  const [maxDraft, setMaxDraft] = useState(cfgMax === undefined ? "" : String(cfgMax));

  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);

  // identity-stable해야 한다 — 소비처(ThinkTimeBoard 기본값 행)가 effect dep으로
  // 쓰는데, 매 렌더 새 클로저면 exhaustive-deps가 dep 추가를 요구하고 effect가
  // 매 렌더 재발화한다(lint는 --max-warnings=0).
  const reseed = useCallback(() => {
    setMinDraft(cfgMin === undefined ? "" : String(cfgMin));
    setMaxDraft(cfgMax === undefined ? "" : String(cfgMax));
  }, [cfgMin, cfgMax]);

  useEffect(() => {
    reseed();
  }, [resetKey, reseed]);

  const commit = () => {
    const outcome = resolveThinkDraft(minDraft, maxDraft);
    switch (outcome.kind) {
      case "clear":
        onClear();
        return;
      case "noop":
        // 정확히 한 칸만 빈 미완성 쌍 — draft 보존.
        return;
      case "commit":
        onCommit(outcome.value);
        return;
      case "revert":
        reseed();
        return;
    }
  };

  const blurHandler =
    (partner: RefObject<HTMLInputElement>) => (e: FocusEvent<HTMLInputElement>) => {
      // `partner.current !== null`이 필수다. 빼면 relatedTarget과 partner가 둘 다
      // null일 때 null === null이 참이 되어 모든 커밋이 조용히 사라진다.
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
    reseed,
  };
}
