import type { Ref } from "react";
import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";
import { Field } from "../ui/Field";
import { validateGroupName } from "../../scenario/grouping";

function groupNameError(value: string): string | null {
  const r = validateGroupName(value);
  if (r.ok) return null;
  return r.reason === "too_long" ? ko.scenarioGroups.errTooLong : ko.scenarioGroups.errForbidden;
}

/**
 * 그룹 이름 입력 칸. 입력 아래 한 줄은 늘 자리를 잡고(min-h) 그 안에 글자 규칙 사유 →
 * 서버 실패 → 안내(`note`) 중 하나만 보인다 — 무엇이 나타나도 아래 버튼 줄이 움직이지 않는다.
 */
export function GroupField({
  id,
  value,
  onChange,
  names,
  placeholder,
  inputRef,
  note,
  failure,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  names: string[];
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** 규칙 위반·실패가 없을 때 보일 안내(합치기 안내 등). */
  note?: string | null;
  /** 서버가 거절한 사유. */
  failure?: string | null;
}) {
  const error = groupNameError(value);
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  return (
    <Field label={ko.scenarioGroups.fieldLabel} htmlFor={id}>
      <Input
        ref={inputRef}
        id={id}
        list={listId}
        value={value}
        placeholder={placeholder ?? ko.scenarioGroups.fieldPlaceholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error != null}
        aria-describedby={error != null ? errorId : undefined}
        autoComplete="off"
      />
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="mt-2 min-h-[1.5em] text-sm">
        {error != null ? (
          <p id={errorId} className="text-red-600">
            {error}
          </p>
        ) : failure != null ? (
          <p role="alert" className="text-red-600">
            {ko.scenarioGroups.failed(failure)}
          </p>
        ) : note != null ? (
          <p className="text-slate-600">{note}</p>
        ) : null}
      </div>
    </Field>
  );
}
