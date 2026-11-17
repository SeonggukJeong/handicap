import type { StairReport, StairSecondSchema } from "../../../api/schemas";
import type { z } from "zod";

export type StairBandSecondRow = Pick<
  z.infer<typeof StairSecondSchema>,
  "offset_s" | "launched" | "count" | "p99_us"
>;

export type StairBandProps = {
  seconds: StairBandSecondRow[];
  bands: StairReport["bands"];
  targetLine: StairReport["target_line"];
  steps: StairReport["steps"];
  width?: number;
  height?: number;
};
