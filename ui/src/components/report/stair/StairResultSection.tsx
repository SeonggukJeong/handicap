import type { StairReport } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { PageSection } from "../../ui/PageSection";
import { StairHeadline } from "./StairHeadline";
import { StairTable } from "./StairTable";

export function StairResultSection({ stair }: { stair: StairReport }) {
  return (
    <PageSection ariaLabel={ko.report.stair.title} title={ko.report.stair.title}>
      <StairHeadline stair={stair} />
      <StairTable stair={stair} />
    </PageSection>
  );
}
