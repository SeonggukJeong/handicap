import { render, screen } from "@testing-library/react";
import type { ErrorKindCount } from "../../../api/schemas";
import { ErrorKindTable } from "../ErrorKindTable";

describe("ErrorKindTable", () => {
  it("renders ko labels, counts and shares", () => {
    // Props typed as ErrorKindCount[] (schema-derived, review fix) — this fixture
    // proves the array is assignable without a cast, i.e. Props isn't a
    // structurally-identical-but-independent inline type (review Important finding).
    const kinds: ErrorKindCount[] = [
      { kind: "connection_reset", count: 90 },
      { kind: "timeout", count: 10 },
    ];
    render(<ErrorKindTable kinds={kinds} />);
    expect(screen.getByText("Transport 실패 분류")).toBeInTheDocument();
    expect(screen.getByText("연결 끊김(reset)")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
    expect(screen.getByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText("요청 타임아웃")).toBeInTheDocument();
  });

  it("renders nothing when empty (byte-identical axis)", () => {
    const { container } = render(<ErrorKindTable kinds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to raw kind for unknown wire strings (forward-compat)", () => {
    render(<ErrorKindTable kinds={[{ kind: "quic_goaway", count: 1 }]} />);
    expect(screen.getByText("quic_goaway")).toBeInTheDocument();
  });
});
