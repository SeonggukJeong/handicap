import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { plain, strong } from "../../i18n/lineParts";
import { SetupPrintTable, SetupTableTitle } from "../components/SetupPrintTable";
import type { SetupPrintModel, SetupRow } from "../setupTable";

const row = (o: Partial<SetupRow> & { stepId: string }): SetupRow => ({
  no: 1,
  name: "로그인",
  requestLine: "POST /api/auth/login",
  count: 50,
  errors: 0,
  p50Ms: 84,
  p95Ms: 120,
  maxMs: 163,
  codes: [{ label: "200", count: 50 }],
  ...o,
});

const model = (rows: SetupRow[]): SetupPrintModel => ({
  open: false,
  ok: 47,
  failed: 3,
  interrupted: 0,
  lead: [
    plain("가상 사용자 50명 중 "),
    strong("47명"),
    plain("이 준비를 마쳤고 "),
    strong("3명이 실패", "bad"),
    plain("했습니다."),
  ],
  rows,
  kindsLine: null,
});

const TITLE = "3. 준비 스텝 결과";

describe("SetupPrintTable", () => {
  it("머리 칸 글자", () => {
    render(<SetupPrintTable model={model([row({ stepId: "a" })])} from={0} to={1} />);
    const heads = screen.getAllByRole("columnheader");
    expect(heads.map((h) => h.childNodes[0]?.textContent)).toEqual([
      "준비 스텝",
      "요청 수",
      "오류",
      "50% 응답",
      "95% 응답",
      "최대",
      "응답 코드별 건수",
    ]);
    expect(heads[3]).toHaveTextContent("ms");
    expect(heads[5]).toHaveTextContent("ms");
  });

  it("오류 행 표시와 칸 글자", () => {
    const m = model([
      row({
        stepId: "a",
        errors: 3,
        maxMs: 5004,
        codes: [
          { label: "응답 없음", count: 1 },
          { label: "200", count: 47 },
          { label: "503", count: 2 },
        ],
      }),
      row({ stepId: "b", no: 2, name: "권한", count: 0, p50Ms: null, p95Ms: null, maxMs: null }),
    ]);
    const { container } = render(<SetupPrintTable model={m} from={0} to={2} />);
    const trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(2);
    expect(trs[0]).toHaveClass("p-row--bad");
    expect(trs[0].children[2]).toHaveClass("p-bad");
    expect(trs[0].children[5].textContent).toBe("5,004");
    expect(trs[0].children[6].textContent).toBe("응답 없음: 1 · 200: 47 · 503: 2");
    expect(trs[1]).not.toHaveClass("p-row--bad");
    expect(trs[1].children[2]).not.toHaveClass("p-bad");
    expect(trs[1].children[3].textContent).toBe("–");
    expect(trs[1].children[4].textContent).toBe("–");
    expect(trs[1].children[5].textContent).toBe("–");
  });

  it("from/to 조각만 그린다", () => {
    const m = model([
      row({ stepId: "a", name: "가" }),
      row({ stepId: "b", name: "나" }),
      row({ stepId: "c", name: "다" }),
    ]);
    const { container } = render(<SetupPrintTable model={m} from={1} to={2} />);
    const trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(1);
    expect(trs[0].textContent).toContain("나");
  });

  it("코드 칸은 짝마다 줄바꿈 금지 요소 하나이고 글자는 그대로", () => {
    const m = model([
      row({
        stepId: "a",
        codes: [
          { label: "응답 없음", count: 1 },
          { label: "200", count: 47 },
          { label: "503", count: 2 },
        ],
      }),
    ]);
    const { container } = render(<SetupPrintTable model={m} from={0} to={1} />);
    const cell = container.querySelector("tbody tr")!.children[6];
    const pairs = Array.from(cell.querySelectorAll(".p-setup-code"));
    expect(pairs.map((p) => p.textContent)).toEqual(["응답 없음: 1", "200: 47", "503: 2"]);
    expect(cell.textContent).toBe("응답 없음: 1 · 200: 47 · 503: 2");
  });

  it("측정 시트에서는 행마다 data-measure", () => {
    const { container } = render(
      <SetupPrintTable model={model([row({ stepId: "a" })])} from={0} to={1} measure />,
    );
    expect(container.querySelector('[data-measure="setup:row:a"]')).not.toBeNull();
    expect(container.querySelector('[data-measure="setup:header"]')).not.toBeNull();
  });
});

describe("SetupTableTitle", () => {
  const lead = model([]).lead;

  it("처음 조각: h2 + 요약 줄(굵은 조각 b, 실패 조각 p-bad)", () => {
    const { container } = render(<SetupTableTitle title={TITLE} lead={lead} continued={false} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^3\. 준비 스텝 결과$/);
    const p = container.querySelector(".p-setup-lead");
    expect(p).not.toBeNull();
    const bolds = Array.from(p!.querySelectorAll("b"));
    expect(bolds.map((b) => b.textContent)).toEqual(["47명", "3명이 실패"]);
    expect(bolds[0]).not.toHaveClass("p-bad");
    expect(bolds[1]).toHaveClass("p-bad");
  });

  it("이어짐 조각: 제목에 (이어짐), 요약 줄 없음", () => {
    const { container } = render(<SetupTableTitle title={TITLE} lead={lead} continued />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "3. 준비 스텝 결과 (이어짐)",
    );
    expect(container.querySelector(".p-setup-lead")).toBeNull();
  });
});
