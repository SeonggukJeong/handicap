import { describe, expect, it } from "vitest";
import { conditionsBox, loadConditionLine, measuredWindow } from "../conditions";
import { ProfileSchema } from "../../api/schemas";

const t = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("measuredWindow", () => {
  it("measured_window", () => {
    expect(measuredWindow(t(2026, 11, 4, 14, 0), t(2026, 11, 4, 14, 10), "completed")).toBe(
      "2026-11-04 14:00 ~ 14:10",
    );
    expect(measuredWindow(t(2026, 11, 4, 23, 50), t(2026, 11, 5, 0, 10), "completed")).toBe(
      "2026-11-04 23:50 ~ 2026-11-05 00:10",
    );
    expect(measuredWindow(t(2026, 11, 4, 14, 0), null, "completed")).toBe("2026-11-04 14:00 ~ –");
    expect(measuredWindow(null, null, "completed")).toBe("– ~ –");
    expect(measuredWindow(t(2026, 11, 4, 14, 0), t(2026, 11, 4, 14, 3), "aborted")).toBe(
      "2026-11-04 14:00 ~ 14:03 (중단됨)",
    );
    expect(measuredWindow(t(2026, 11, 4, 14, 0), t(2026, 11, 4, 14, 3), "failed")).toBe(
      "2026-11-04 14:00 ~ 14:03 (실패)",
    );
  });
});

const prof = (o: Record<string, unknown>) =>
  ProfileSchema.parse({ vus: 0, duration_seconds: 0, ...o });

describe("loadConditionLine", () => {
  it("load_line", () => {
    expect(loadConditionLine(prof({ vus: 200, duration_seconds: 600 }))).toBe(
      "동시 사용자 200명 · 10분",
    );
    expect(loadConditionLine(prof({ target_rps: 50, duration_seconds: 300 }))).toBe(
      "초당 50회 목표 · 5분",
    );
    expect(
      loadConditionLine(
        prof({
          vu_stages: [
            { target: 100, duration_seconds: 300 },
            { target: 300, duration_seconds: 300 },
            { target: 0, duration_seconds: 300 },
          ],
        }),
      ),
    ).toBe("동시 사용자 곡선 최대 300명 · 15분");
    expect(
      loadConditionLine(
        prof({
          stages: [
            { target: 20, duration_seconds: 100 },
            { target: 80, duration_seconds: 200 },
          ],
        }),
      ),
    ).toBe("초당 목표 곡선 최대 80회 · 5분");
  });
});

describe("conditionsBox", () => {
  const full = {
    vus: 200,
    duration_seconds: 600,
    ramp_up_seconds: 30,
    think_time: { min_ms: 500, max_ms: 1500 },
    http_timeout_seconds: 30,
    data_bindings: [
      { dataset_id: "a", policy: "per_vu", mappings: [] },
      { dataset_id: "b", policy: "per_vu", mappings: [] },
    ],
  };
  it("conditions_rows", () => {
    const r = conditionsBox({ profileRaw: full, workerBreakdownLen: 2, envCount: 3 });
    expect(r).toEqual({
      ok: true,
      rows: [
        { label: "부하 모델", value: "동시 사용자 고정" },
        { label: "크기", value: "200명" },
        { label: "기간", value: "10분" },
        { label: "시작 늘림", value: "30초에 걸쳐 늘림" },
        { label: "단계 사이 쉼", value: "0.50초–1.5초 무작위" },
        { label: "요청 제한 시간", value: "30초" },
        { label: "워커 수", value: "워커 2대" },
        { label: "데이터", value: "데이터 2개 연결" },
        { label: "환경 변수", value: "환경 변수 3개 사용" },
      ],
    });
  });
  it("optional rows omitted", () => {
    const r = conditionsBox({
      profileRaw: { vus: 5, duration_seconds: 60 },
      workerBreakdownLen: 1,
      envCount: 0,
    });
    expect(r.ok && r.rows.map((x) => x.label)).toEqual([
      "부하 모델",
      "크기",
      "기간",
      "요청 제한 시간",
    ]);
  });
  it("curve size, open worker_count, legacy binding", () => {
    const r = conditionsBox({
      profileRaw: {
        vus: 0,
        duration_seconds: 0,
        stages: [
          { target: 20, duration_seconds: 100 },
          { target: 80, duration_seconds: 200 },
        ],
        worker_count: 4,
        data_binding: { dataset_id: "a", policy: "per_vu", mappings: [] },
      },
      workerBreakdownLen: 0,
      envCount: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const m = Object.fromEntries(r.rows.map((x) => [x.label, x.value]));
      expect(m["부하 모델"]).toBe("초당 목표 곡선");
      expect(m["크기"]).toBe("최대 초당 80회 · 2단계");
      expect(m["워커 수"]).toBe("워커 4대");
      expect(m["데이터"]).toBe("데이터 1개 연결");
    }
  });
  it("closed curve and open fixed sizes", () => {
    const a = conditionsBox({
      profileRaw: { vus: 0, duration_seconds: 0, vu_stages: [{ target: 7, duration_seconds: 10 }] },
      workerBreakdownLen: 0,
      envCount: 0,
    });
    expect(a.ok && a.rows[0].value).toBe("동시 사용자 곡선");
    expect(a.ok && a.rows[1].value).toBe("최대 7명 · 1단계");
    const b = conditionsBox({
      profileRaw: { vus: 0, duration_seconds: 60, target_rps: 50 },
      workerBreakdownLen: 0,
      envCount: 0,
    });
    expect(b.ok && b.rows[0].value).toBe("초당 목표 고정");
    expect(b.ok && b.rows[1].value).toBe("초당 50회");
  });
  it("invalid profile", () => {
    expect(conditionsBox({ profileRaw: { vus: "x" }, workerBreakdownLen: 0, envCount: 0 })).toEqual(
      { ok: false },
    );
  });
});
