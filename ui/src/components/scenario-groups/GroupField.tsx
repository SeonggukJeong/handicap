import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";
import { Field } from "../ui/Field";
import { validateGroupName } from "../../scenario/grouping";

function groupNameError(value: string): string | null {
  const r = validateGroupName(value);
  if (r.ok) return null;
  return r.reason === "too_long"
    ? ko.scenarioGroups.errTooLong
    : ko.scenarioGroups.errForbidden;
}

export function GroupField({
  id,
  value,
  onChange,
  names,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  names: string[];
  placeholder?: string;
}) {
  const error = groupNameError(value);
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  return (
    <Field label={ko.scenarioGroups.fieldLabel} htmlFor={id} error={error} errorId={errorId}>
      <Input
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
    </Field>
  );
}
