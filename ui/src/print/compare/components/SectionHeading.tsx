import { ko } from "../../../i18n/ko";

const V = ko.print.cmp.view;

export function SectionHeading({
  no,
  title,
  continued,
  warn,
}: {
  no: string;
  title: string;
  continued?: boolean;
  warn?: boolean;
}) {
  return (
    <h2 className="p-h2">
      <span className="p-cmp-no">{V.sectionNo(no)}</span>
      {warn && (
        <>
          <span className="p-cmp-warn">{V.warnGlyph}</span>{" "}
        </>
      )}
      {title}
      {continued ? V.continued : ""}
    </h2>
  );
}
