import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { HttpStepNode, type HttpStepNodeData } from "../HttpStepNode";

type HttpNode = Node<HttpStepNodeData, "http">;

// 컴포넌트는 data만 읽는다 — 나머지 NodeProps 필드는 v12 타입을 만족시키는 고정값.
// (tsc -b가 필드 과부족을 지적하면 node_modules/@xyflow/react/dist/esm/types의
//  NodeProps 정의에 맞춰 이 헬퍼만 조정한다.)
function nodeProps(data: HttpStepNodeData): NodeProps<HttpNode> {
  return {
    id: "n1",
    type: "http",
    data,
    dragging: false,
    draggable: false,
    selectable: false,
    deletable: false,
    selected: false,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

const DATA: HttpStepNodeData = {
  name: "login",
  method: "POST",
  url: "/login",
  urlMissing: false,
  selected: false,
};

function renderNode(data: HttpStepNodeData) {
  return render(
    <ReactFlowProvider>
      <HttpStepNode {...nodeProps(data)} />
    </ReactFlowProvider>,
  );
}

describe("HttpStepNode", () => {
  it("renders the step's name and method+URL", () => {
    renderNode(DATA);
    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByTitle("POST /login")).toBeInTheDocument();
  });

  it("applies a 'selected' style when the data.selected flag is true", () => {
    const { container: off } = renderNode(DATA);
    expect((off.firstElementChild as HTMLElement).className).not.toContain("ring-1");

    const { container: on } = renderNode({ ...DATA, selected: true });
    expect((on.firstElementChild as HTMLElement).className).toContain("ring-1");
  });
});
