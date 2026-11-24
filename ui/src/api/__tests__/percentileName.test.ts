import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { describe, it, expect } from "vitest";
import { parsePercentileMetric, percentileMetricName } from "../percentileName";

const cases = JSON.parse(
  readFileSync(
    nodePath.resolve(__dirname, "../../../../testdata/percentile_metric_cases.json"),
    "utf8",
  ),
) as {
  names: { input: string; percentile: number | null }[];
  numbers: { input: string; name: string | null }[];
};

describe("percentileName (서버 percentile_name.rs와 같은 표)", () => {
  it.each(cases.names)("parse $input", ({ input, percentile }) => {
    expect(parsePercentileMetric(input)).toBe(percentile);
  });
  it.each(cases.numbers)("name $input", ({ input, name }) => {
    expect(percentileMetricName(input)).toBe(name);
  });
});
