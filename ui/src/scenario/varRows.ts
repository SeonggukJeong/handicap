import type { Scenario } from "./model";
import {
  collectProducedVars,
  parallelExtractNames,
  buildVarRefIndex,
  undefinedVarRefs,
  parallelVarIdentities,
  flatExtractNames,
  collectNamespacedProducers,
} from "./scanVars";
import type { VarDeclValue } from "./genVars";

export type VarRow =
  | {
      kind: "declared";
      name: string;
      value: VarDeclValue;
      renamable: boolean;
      overwritten: boolean;
      refIds: string[];
    }
  | { kind: "flat-extract"; name: string; refIds: string[] }
  | {
      kind: "parallel-extract";
      branchName: string;
      varName: string;
      display: string;
      isShadow: boolean;
      refIds: string[];
    }
  | {
      kind: "undefined";
      name: string;
      refIds: string[];
      candidates: string[];
      refKind: "downstream" | "sibling";
    };

/** VariablesPanel의 행 빌더 — `trust.ts`의 C 판정과 **같은 소스**여야 하므로 추출됐다
 *  (spec D15). 규칙은 이동 전 코드가 정본이다: 바꾸지 말 것. */
export function buildVarRows(model: Scenario | null): VarRow[] {
  if (!model) return [];
  const declaredKeys = new Set(Object.keys(model.variables));
  const produced = collectProducedVars(model);
  const parallelNames = parallelExtractNames(model);
  const refIndex = buildVarRefIndex(model);
  const undef = undefinedVarRefs(model);
  const flatEx = flatExtractNames(model);
  const namespaced = collectNamespacedProducers(model);
  const out: VarRow[] = [];
  // 선언(연필은 flat non-shadow일 때만)
  for (const [name, value] of Object.entries(model.variables))
    out.push({
      kind: "declared",
      name,
      value,
      renamable: !parallelNames.has(name),
      overwritten: flatEx.has(name) || namespaced.has(name),
      refIds: refIndex.get(name) ?? [],
    });
  // flat-extract = produced − 선언 − parallel(shadow) — 비-parallel 스텝에서만 추출된 이름
  for (const name of produced)
    if (!declaredKeys.has(name) && !parallelNames.has(name))
      out.push({ kind: "flat-extract", name, refIds: refIndex.get(name) ?? [] });
  // parallel-extract(구조적 identity — non-shadow는 분기-내부∪다운스트림 refIds)
  for (const id of parallelVarIdentities(model)) {
    const refIds = id.isShadow
      ? id.namespacedRefIds
      : [...new Set([...id.branchRefIds, ...id.namespacedRefIds])];
    out.push({
      kind: "parallel-extract",
      branchName: id.branchName,
      varName: id.varName,
      display: id.display,
      isShadow: id.isShadow,
      refIds,
    });
  }
  // 미정의(위치 인식 — refIds는 UndefinedRef.stepIds만, refIndex 전체가 아니다.
  // 정당한 분기 내부 참조를 usage 팝오버가 안 가리키게).
  for (const [name, ref] of undef)
    out.push({
      kind: "undefined",
      name,
      refIds: ref.stepIds,
      candidates: ref.candidates,
      refKind: ref.kind,
    });
  return out;
}
