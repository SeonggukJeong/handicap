import { ko } from "../../../i18n/ko";

const V = ko.print.cmp.view;

export function SectionHeading({
  no,
  title,
  continued,
}: {
  no: string;
  title: string;
  continued?: boolean;
}) {
  return (
    <h2 className="p-h2">
      <span className="p-cmp-no">{no}.</span> {title}
      {continued ? V.continued : ""}
    </h2>
  );
}
