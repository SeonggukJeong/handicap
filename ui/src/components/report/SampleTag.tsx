import { Badge } from "../ui/Badge";

/** 표본을 바꿔 보는 동안, 값이 표본을 따르는 구획에 지금 표본의 이름을 붙인다. */
export function SampleTag({ name, className }: { name: string; className?: string }) {
  return (
    <Badge
      tone="accent"
      weight="medium"
      className={`whitespace-nowrap${className ? ` ${className}` : ""}`}
    >
      {name}
    </Badge>
  );
}
