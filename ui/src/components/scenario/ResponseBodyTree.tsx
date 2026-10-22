import type { Extract } from "../../scenario/model";
import { suggestVarName } from "../../scenario/jsonPath";
import { JsonValueTree } from "../response/JsonValueTree";
import { ExtractConfirmRow } from "./ExtractConfirmRow";

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Renders parsed JSON as a tree; scalar leaves expose "+추출" → inline confirm row
 *  → onCreate(body extract). Object/array containers are shown but not extractable
 *  (R6 — path/value would be ambiguous). */
export function ResponseBodyTree({
  value,
  onCreate,
}: {
  value: unknown;
  onCreate: (extract: Extract) => void;
}) {
  return (
    <JsonValueTree
      value={value}
      actionLabel="+추출"
      renderConfirm={(leaf, close) => (
        <ExtractConfirmRow
          proposed={{ var: suggestVarName(leaf.key), from: "body", path: leaf.path }}
          preview={preview(leaf.value)}
          onConfirm={(ex) => {
            onCreate(ex);
            close();
          }}
          onCancel={close}
        />
      )}
    />
  );
}
