import { ko } from "../../i18n/ko";
import type { PrintDoc } from "../buildPrintDoc";

const C = ko.print.conditions;
const CL = ko.print.claims;

/** 4절: 측정 조건 상자 + (있으면) 해석 상자를 나란히. 해석 상자는 별도 측정 id가 없어 이 블록 높이에 포함된다. */
export function ConditionsSection({ doc }: { doc: PrintDoc }) {
  const cond = doc.conditions;
  const claims = doc.claims;
  return (
    <section>
      <h2 className="p-h2">{ko.print.section.conditions}</h2>
      <div className={claims ? "p-two" : undefined}>
        <div className="p-box">
          <h3 className="p-h3">{C.title}</h3>
          {cond.ok ? (
            <dl className="p-cond">
              {cond.rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="p-muted">{C.unreadable}</div>
          )}
        </div>
        {claims && (
          <div className="p-box">
            <h3 className="p-h3">{CL.title}</h3>
            {claims.can.length > 0 && (
              <>
                <div className="p-box-sub">{CL.can}</div>
                <ul>
                  {claims.can.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            {claims.cannot.length > 0 && (
              <>
                <div className="p-box-sub">{CL.cannot}</div>
                <ul>
                  {claims.cannot.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
