import { groupScenarios } from "../../scenario/grouping";

type Item = { id: string; name: string; group?: string | null };

export function ScenarioOptions({ scenarios }: { scenarios: readonly Item[] }) {
  const { groups, ungrouped } = groupScenarios(scenarios);
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.name} label={g.name}>
          {g.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
      {ungrouped.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </>
  );
}
