import { ko } from "../../i18n/ko";
import { PageSection } from "../ui/PageSection";

interface Props {
  kinds: { kind: string; count: number }[];
}

export function ErrorKindTable({ kinds }: Props) {
  if (kinds.length === 0) return null;
  const total = kinds.reduce((s, k) => s + k.count, 0);
  const t = ko.report.errorKinds;
  return (
    // className 미전달 = 기본 여백 유지 — 형제 StatusDistribution 관례 (리뷰 P9)
    <PageSection ariaLabel={t.title} title={t.title}>
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-200 text-left text-slate-600">
          <tr>
            <th className="py-2 pr-4 font-medium">{t.headerKind}</th>
            <th className="py-2 pr-4 font-medium">{t.headerCount}</th>
            <th className="py-2 font-medium">{t.headerShare}</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((k) => (
            <tr key={k.kind} className="border-b border-slate-100">
              <td className="py-2 pr-4">{t.labels[k.kind] ?? k.kind}</td>
              <td className="py-2 pr-4 tabular-nums">{k.count.toLocaleString("en-US")}</td>
              <td className="py-2 tabular-nums">
                {total > 0 ? `${((k.count / total) * 100).toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageSection>
  );
}
