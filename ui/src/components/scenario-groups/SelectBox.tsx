import { useEffect, useRef } from "react";

/** 행 위아래 패딩과 같은 값 — 누르는 면적을 행 높이만큼 넓히고 음수 마진으로 레이아웃을 상쇄한다. */
const PAD = {
  row: "-my-2.5 py-2.5",
  group: "-my-2 py-2",
  columns: "-my-1.5 py-1.5",
} as const;

/** 목록의 체크 칸. 라벨이 칸 폭 × 행 높이를 덮어 누를 면적을 넓히고, 일부 선택은 indeterminate로 보인다. */
export function SelectBox({
  label,
  checked,
  indeterminate = false,
  onChange,
  tall,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  /** 이 칸이 놓인 행의 종류(행마다 위아래 패딩이 다르다). */
  tall: keyof typeof PAD;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label className={`flex h-full cursor-pointer items-center justify-center ${PAD[tall]}`}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 cursor-pointer accent-accent-600"
      />
    </label>
  );
}
