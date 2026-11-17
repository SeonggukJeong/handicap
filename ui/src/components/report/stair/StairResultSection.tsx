import type { StairReport } from "../../../api/schemas";
import { ko } from "../../../i18n/ko";
import { PageSection } from "../../ui/PageSection";
import { StairHeadline } from "./StairHeadline";
import { StairBandChart } from "./StairBandChart";
import { StairCurveChart } from "./StairCurveChart";
import { StairTable } from "./StairTable";

export function StairResultSection({ stair }: { stair: StairReport }) {
  return (
    <PageSection ariaLabel={ko.report.stair.title} title={ko.report.stair.title}>
      <StairHeadline stair={stair} />
      <PageSection
        sub
        ariaLabel={ko.report.stair.chart.curveTitle}
        title={ko.report.stair.chart.curveTitle}
      >
        <StairCurveChart steps={stair.steps} />
      </PageSection>
      <StairTable stair={stair} />
      <PageSection
        sub
        className="mt-4"
        ariaLabel={ko.report.stair.chart.bandTitle}
        title={ko.report.stair.chart.bandTitle}
      >
        <StairBandChart
          seconds={stair.seconds}
          bands={stair.bands}
          targetLine={stair.target_line}
          steps={stair.steps}
        />
      </PageSection>
    </PageSection>
  );
}
