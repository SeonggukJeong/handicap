import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Field } from "../Field";
import { Input } from "../Input";

describe("Field", () => {
  it("label↔control을 htmlFor로 연결해 getByLabelText가 해소된다", () => {
    render(
      <Field label="동시 사용자(VU)" htmlFor="vu">
        <Input id="vu" defaultValue="2" />
      </Field>,
    );
    const el = screen.getByLabelText("동시 사용자(VU)") as HTMLInputElement;
    expect(el.value).toBe("2");
  });
  it("recommended Badge·help·hint를 렌더하되 accname을 오염시키지 않는다 (U3)", () => {
    render(
      <Field
        label="VU"
        htmlFor="v"
        recommended="추천 2"
        help={<span>도움말</span>}
        hint="이 값으로 바로 실행해도 됩니다"
      >
        <Input id="v" />
      </Field>,
    );
    expect(screen.getByText("추천 2")).toBeInTheDocument();
    expect(screen.getByText("이 값으로 바로 실행해도 됩니다")).toBeInTheDocument();
    // Badge/help가 <label> 밖이라 컨트롤 accname은 정확히 라벨 텍스트("VU")만 — exact 매치 성공
    // (오염됐으면 "VU 추천 도움말"이 되어 exact "VU"가 throw). teeth: Field가 help/badge를
    // label 안에 넣으면 이 줄이 FAIL.
    expect(screen.getByLabelText("VU")).toBeInTheDocument();
  });
  it("error/errorId를 외부 컨트롤과 연결 가능하게 렌더한다", () => {
    render(
      <Field label="타임아웃" htmlFor="t" error="범위 밖" errorId="t-err">
        <Input id="t" aria-invalid="true" aria-describedby="t-err" />
      </Field>,
    );
    const err = screen.getByText("범위 밖");
    expect(err.id).toBe("t-err");
    expect(screen.getByLabelText("타임아웃").getAttribute("aria-describedby")).toBe("t-err");
  });
});
