import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CompareDocument } from "../CompareDocument";
import { buildCompareDoc, type CompareDoc } from "../buildCompareDoc";
import { baseProfile } from "./fixtures";
import { sceneModel } from "./scene";

// 쪽마다 다른 표지를 단 민감 값: 주소의 비밀번호·쿼리 토큰, 헤더 값, JSON 본문 값,
// 환경 변수 값, 데이터셋 id·열 이름. 어느 것도 문서 모델·화면에 나오면 안 된다.
const MARKERS = (side: "A" | "B") => [
  `PW-MARK-${side}`,
  `TKN-MARK-${side}`,
  `HDR-MARK-${side}`,
  `BODY-MARK-${side}`,
  `ENV-MARK-${side}`,
  `DS-MARK-${side}`,
  `COL-MARK-${side}`,
];
const ALL = [...MARKERS("A"), ...MARKERS("B")];

const yamlOf = (side: "A" | "B") =>
  [
    "version: 1",
    'name: "민원 신청 흐름"',
    "steps:",
    '  - id: "s1"',
    '    name: "접수"',
    "    request:",
    "      method: POST",
    `      url: "https://user:PW-MARK-${side}@host-${side.toLowerCase()}.example/x?token=TKN-MARK-${side}"`,
    "      headers:",
    `        X-Api-Key: "HDR-MARK-${side}"`,
    "      body:",
    "        kind: json",
    "        value:",
    `          secret: "BODY-MARK-${side}"`,
    "    assert:",
    "      - status: 200",
    "",
  ].join("\n");

const profileOf = (side: "A" | "B") => ({
  ...baseProfile,
  data_bindings: [
    {
      dataset_id: `DS-MARK-${side}`,
      policy: "per_vu",
      mappings: [{ kind: "column", var: "v", column: `COL-MARK-${side}` }],
    },
  ],
});

function markedDoc(): CompareDoc {
  const run = (id: string, side: "A" | "B") =>
    sceneModel({
      id,
      yaml: yamlOf(side),
      profile: profileOf(side),
      env: { SECRET_TOKEN: `ENV-MARK-${side}` },
      rep: [{ id: "s1", counts: { "200": 990, "500": 10 }, errors: 10 }],
    });
  return buildCompareDoc({
    before: run("01HBEFORE000abc111", "A"),
    after: run("01HAFTER0000def222", "B"),
    fallbackScenarioName: null,
    now: Date.UTC(2026, 10, 6, 12, 0, 0),
  });
}

describe("비교 보고서 — 민감 값 표지", () => {
  it("문서 모델 어디에도 표지가 없고, 표지가 다른 카드는 다름으로 표시된다", () => {
    const doc = markedDoc();
    const card = (k: string) => doc.fairness.cards.find((c) => c.key === k);
    expect(card("scenario")?.same).toBe(false);
    expect(card("env")?.same).toBe(false);
    expect(card("load")?.same).toBe(false);
    expect(card("env")?.line).toContain("SECRET_TOKEN");
    const dump = JSON.stringify(doc);
    for (const m of ALL) expect(dump, m).not.toContain(m);
  });

  it.each(["standard", "summary"] as const)(
    "%s 화면(속성·숨은 측정 시트 포함)에도 표지가 없다",
    async (kind) => {
      const { container } = render(<CompareDocument doc={markedDoc()} kind={kind} />);
      const root = container.querySelector(".p-doc") as HTMLElement;
      const sheet = container.querySelector(".p-sheet") as HTMLElement;
      expect(sheet.querySelectorAll("[data-measure]").length).toBeGreaterThan(0);
      expect(sheet.innerHTML).toContain("SECRET_TOKEN");
      for (const m of ALL) expect(sheet.innerHTML, m).not.toContain(m);
      await waitFor(() => expect(root).toHaveAttribute("data-layout-ready", "true"));
      const html = container.innerHTML;
      expect(html).toContain("SECRET_TOKEN");
      for (const m of ALL) expect(html, m).not.toContain(m);
    },
  );
});
