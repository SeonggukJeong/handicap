import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DefaultRuleNote } from "../DefaultRuleNote";

describe("DefaultRuleNote", () => {
  it("목업 .why — 위 여백만, 한글은 단어 단위로 줄바꿈", () => {
    const { container } = render(<DefaultRuleNote error="status 404 (>= 400)" />);
    const tokens = (container.querySelector("p")?.className ?? "").split(/\s+/);
    expect(tokens).toContain("mt-1.5");
    expect(tokens).not.toContain("my-1");
    expect(tokens).toContain("[word-break:keep-all]");
    expect(tokens).toContain("break-words");
  });
  it("className을 덧붙인다", () => {
    const { container } = render(<DefaultRuleNote error="status 404 (>= 400)" className="mx-2" />);
    expect(container.querySelector("p")?.className.split(/\s+/)).toContain("mx-2");
  });
  it("기본 규칙 글이 아니면 아무것도 그리지 않는다", () => {
    const { container } = render(<DefaultRuleNote error="status 503 != 200" />);
    expect(container.firstChild).toBeNull();
  });
});
