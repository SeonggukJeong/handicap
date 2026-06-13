import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActiveVuChart } from "../ActiveVuChart";

describe("ActiveVuChart", () => {
  it("renders a labelled region with the active-VU chart", () => {
    const { getByRole } = render(
      <ActiveVuChart
        series={[
          { ts_second: 100, desired: 0, actual: 0 },
          { ts_second: 101, desired: 3, actual: 2 },
          { ts_second: 102, desired: 3, actual: 3 },
        ]}
        width={400}
        height={200}
      />,
    );
    // accessible-name substring (literal parens in "활성 VU (시간별)" break a full-string regex)
    const region = getByRole("region", { name: /활성 VU/ });
    expect(region).toBeInTheDocument();
    expect(region.querySelector("svg")).not.toBeNull();
  });
});
