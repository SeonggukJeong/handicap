import type { Report } from "../api/schemas";
import { ko } from "../i18n/ko";

export function basisNotice(
  reports: Array<Pick<Report, "run" | "basis">>,
  labels: Record<string, string>,
): string | null {
  const bases = reports.map((r) => r.basis?.selected ?? "whole");
  if (bases.every((b) => b === bases[0])) return null;
  const parts = reports
    .map((r, i) => {
      const name = ko.report.basis[bases[i]];
      return `${labels[r.run.id] ?? r.run.id}: ${name}`;
    })
    .join(", ");
  return ko.compare.basisMismatch(parts);
}
