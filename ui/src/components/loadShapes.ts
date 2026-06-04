import type { Stage } from "../api/schemas";

export type LoadShape = { id: string; label: string; stages: Stage[] };

/** UI-only starting curves (0-based ramps). Selecting one seeds the stage rows;
 *  the user then edits the numbers. Backend-agnostic. */
export const LOAD_SHAPES: LoadShape[] = [
  {
    id: "ramp_hold",
    label: "점증·유지",
    stages: [
      { target: 200, duration_seconds: 30 },
      { target: 200, duration_seconds: 120 },
      { target: 0, duration_seconds: 30 },
    ],
  },
  {
    id: "spike",
    label: "스파이크",
    stages: [
      { target: 50, duration_seconds: 20 },
      { target: 500, duration_seconds: 10 },
      { target: 500, duration_seconds: 20 },
      { target: 50, duration_seconds: 20 },
    ],
  },
  {
    id: "step",
    label: "계단 스트레스",
    stages: [
      { target: 100, duration_seconds: 30 },
      { target: 200, duration_seconds: 30 },
      { target: 300, duration_seconds: 30 },
      { target: 400, duration_seconds: 30 },
      { target: 500, duration_seconds: 30 },
    ],
  },
  {
    id: "soak",
    label: "소크",
    stages: [
      { target: 100, duration_seconds: 60 },
      { target: 100, duration_seconds: 1800 },
      { target: 0, duration_seconds: 60 },
    ],
  },
];
