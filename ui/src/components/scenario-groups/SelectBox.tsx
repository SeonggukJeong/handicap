import { useEffect, useRef } from "react";

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
  /** 위아래 패딩만큼 누르는 면적을 늘린다(레이아웃은 음수 마진으로 상쇄). */
  tall: "row" | "head";
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  const pad = tall === "row" ? "-my-3 py-3" : "-my-2 py-2";
  return (
    <label className={`flex h-full cursor-pointer items-center justify-center ${pad}`}>
      <input
        ref={ref}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 cursor-pointer"
      />
    </label>
  );
}
