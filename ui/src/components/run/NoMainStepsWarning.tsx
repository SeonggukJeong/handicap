import { ko } from "../../i18n/ko";
import { setupSteps, type Scenario } from "../../scenario/model";
import { Callout } from "../ui/Callout";

export function NoMainStepsWarning({ scenario }: { scenario: Scenario | null }) {
  if (!scenario || scenario.steps.length > 0) return null;
  const T = ko.runDialog.setupNotice;
  return (
    <Callout variant="warn" role="status" className="mb-3">
      {setupSteps(scenario).length > 0 ? T.noMainSetupOnly : T.noMainEmpty}
    </Callout>
  );
}
