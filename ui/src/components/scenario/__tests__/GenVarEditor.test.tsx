import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GenVarEditor } from "../GenVarEditor";
import { ko } from "../../../i18n/ko";
import type { GenSpec, VarDeclValue } from "../../../scenario/genVars";

/** 표준 하니스 — GenVarEditor는 프레젠테이셔널이라 store 접촉 없이 콜백만 스파이한다.
 *  "outside" 형제 버튼은 min/max 짝-hold 테스트가 짝 *바깥*으로 포커스를 옮기는 데 쓴다
 *  (useThinkTimePair.test.tsx의 Harness 이디엄과 동일). */
function setup(value: VarDeclValue, disabled = false) {
  const onCommitGen = vi.fn();
  const onCommitStatic = vi.fn();
  render(
    <div>
      <GenVarEditor
        name="checkin"
        value={value}
        disabled={disabled}
        onCommitGen={onCommitGen}
        onCommitStatic={onCommitStatic}
      />
      <button type="button">outside</button>
    </div>,
  );
  return { onCommitGen, onCommitStatic };
}

describe("GenVarEditor — 타입 select + 전환", () => {
  it("static kind renders type select(값=static) + 값 textarea", () => {
    setup("hello");
    expect(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") })).toHaveValue(
      "static",
    );
    const ta = screen.getByRole("textbox", { name: ko.editor.variableValueAria("checkin") });
    expect(ta).toHaveValue("hello");
  });

  it("static→date 전환: 기본 스펙에 tz가 명시된다(spec §6.4)", () => {
    const { onCommitGen } = setup("hello");
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "date" },
    });
    expect(onCommitGen).toHaveBeenCalledTimes(1);
    expect(onCommitGen).toHaveBeenCalledWith({
      gen: "date",
      format: "%Y-%m-%d",
      tz: "Asia/Seoul",
    });
  });

  it("date→static 전환: onCommitStatic('')로 커밋", () => {
    const { onCommitStatic } = setup({ gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" });
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "static" },
    });
    expect(onCommitStatic).toHaveBeenCalledTimes(1);
    expect(onCommitStatic).toHaveBeenCalledWith("");
  });

  it("→uuid 전환: {gen:'uuid'} 커밋", () => {
    const { onCommitGen } = setup("x");
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "uuid" },
    });
    expect(onCommitGen).toHaveBeenCalledWith({ gen: "uuid" });
  });

  it("→random_int 전환: {gen:'random_int',min:1,max:100} 커밋", () => {
    const { onCommitGen } = setup("x");
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "random_int" },
    });
    expect(onCommitGen).toHaveBeenCalledWith({ gen: "random_int", min: 1, max: 100 });
  });

  it("→random_string 전환: {gen:'random_string',length:8} 커밋", () => {
    const { onCommitGen } = setup("x");
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "random_string" },
    });
    expect(onCommitGen).toHaveBeenCalledWith({ gen: "random_string", length: 8 });
  });

  it("같은 타입으로 '전환'하면 아무것도 커밋하지 않는다", () => {
    const { onCommitGen, onCommitStatic } = setup({ gen: "uuid" });
    fireEvent.change(screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }), {
      target: { value: "uuid" },
    });
    expect(onCommitGen).not.toHaveBeenCalled();
    expect(onCommitStatic).not.toHaveBeenCalled();
  });

  it("disabled=true면 타입 select와 날짜 필드 전부 비활성화된다", () => {
    setup({ gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" }, true);
    expect(
      screen.getByRole("combobox", { name: ko.editor.genFieldType("checkin") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: ko.editor.genFieldFormatPreset("checkin") }),
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: ko.editor.genFieldTz("checkin") })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: ko.editor.genFieldOffset("checkin") }),
    ).toBeDisabled();
  });
});

describe("GenVarEditor — 날짜 필드", () => {
  it("형식 프리셋 select 변경은 즉시 커밋된다", () => {
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    fireEvent.change(
      screen.getByRole("combobox", { name: ko.editor.genFieldFormatPreset("checkin") }),
      { target: { value: "unix" } },
    );
    expect(onCommitGen).toHaveBeenCalledTimes(1);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, format: "unix" });
  });

  it("프리셋 밖 형식(YAML에서 옴)은 프리셋 select에 '직접 입력…'으로 표시 + 커스텀 input 노출", () => {
    setup({ gen: "date", format: "%Y년 %m월 %d일", tz: "Asia/Seoul" });
    expect(
      screen.getByRole("combobox", { name: ko.editor.genFieldFormatPreset("checkin") }),
    ).toHaveValue("__custom__");
    expect(
      screen.getByRole("textbox", { name: ko.editor.genFieldFormatCustom("checkin") }),
    ).toHaveValue("%Y년 %m월 %d일");
  });

  it("프리셋 select에서 '직접 입력…' 선택 시 커밋 없이 커스텀 input이 나타난다(현재 값을 시드)", async () => {
    const user = userEvent.setup();
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    expect(
      screen.queryByRole("textbox", { name: ko.editor.genFieldFormatCustom("checkin") }),
    ).toBeNull();
    await user.selectOptions(
      screen.getByRole("combobox", { name: ko.editor.genFieldFormatPreset("checkin") }),
      ko.editor.genFormatCustomOption,
    );
    expect(onCommitGen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: ko.editor.genFieldFormatCustom("checkin") }),
    ).toHaveValue("%Y-%m-%d");
  });

  it("커스텀 형식 문자열은 draft+blur 커밋", () => {
    const spec: GenSpec = { gen: "date", format: "%Y년 %m월 %d일", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("textbox", { name: ko.editor.genFieldFormatCustom("checkin") });
    fireEvent.change(input, { target: { value: "%Y/%m/%d" } });
    fireEvent.blur(input);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, format: "%Y/%m/%d" });
  });

  it("오프셋: 유효값(+7d) blur 커밋", () => {
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("textbox", { name: ko.editor.genFieldOffset("checkin") });
    fireEvent.change(input, { target: { value: "+7d" } });
    fireEvent.blur(input);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, offset: "+7d" });
  });

  it("오프셋: 불합격 값(+7x) blur → revert(커밋 미발생, draft가 원래 값으로 복귀)", () => {
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul", offset: "+1d" };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("textbox", {
      name: ko.editor.genFieldOffset("checkin"),
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "+7x" } });
    fireEvent.blur(input);
    expect(onCommitGen).not.toHaveBeenCalled();
    expect(input.value).toBe("+1d");
  });

  it("오프셋: 빈 값 blur는 오프셋 키 제거로 커밋(오늘)", () => {
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul", offset: "+1d" };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("textbox", { name: ko.editor.genFieldOffset("checkin") });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, offset: undefined });
  });

  it("타임존 select는 즉시 커밋되고, '워커 로컬' 선택 시 tz가 undefined로 커밋된다(yamlDoc의 setVariableGen이 write-time에 clean — spec.tz 키 제거)", async () => {
    const user = userEvent.setup();
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    const select = screen.getByRole("combobox", { name: ko.editor.genFieldTz("checkin") });
    await user.selectOptions(select, ko.editor.genTzWorkerLocal);
    expect(onCommitGen).toHaveBeenCalledTimes(1);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, tz: undefined });
  });

  it("타임존 select에서 UTC로 전환하면 즉시 커밋", async () => {
    const user = userEvent.setup();
    const spec: GenSpec = { gen: "date", format: "%Y-%m-%d", tz: "Asia/Seoul" };
    const { onCommitGen } = setup(spec);
    await user.selectOptions(
      screen.getByRole("combobox", { name: ko.editor.genFieldTz("checkin") }),
      "UTC",
    );
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, tz: "UTC" });
  });
});

describe("GenVarEditor — 랜덤 정수", () => {
  it("min/max: 실제 포커스 이동으로 짝 내부(유효 중간쌍) 보류 후, 짝을 떠날 때 정확히 1회 커밋 (이빨 실증 대상)", async () => {
    const user = userEvent.setup();
    const spec: GenSpec = { gen: "random_int", min: 1, max: 5000 };
    const { onCommitGen } = setup(spec);
    const min = screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") });
    const max = screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") });

    await user.click(min);
    await user.clear(min);
    await user.type(min, "1000"); // min blur(→max)는 중간쌍 {1000,5000}(유효) — 반드시 보류
    await user.click(max);
    await user.clear(max);
    await user.type(max, "2000");
    await user.click(screen.getByRole("button", { name: "outside" })); // 짝을 완전히 떠남 — 커밋 경계

    expect(onCommitGen).toHaveBeenCalledTimes(1);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, min: 1000, max: 2000 });
  });

  it("min/max: 짝 내부로 포커스가 이동하는 동안은 커밋되지 않고 draft가 보존된다", async () => {
    const user = userEvent.setup();
    const spec: GenSpec = { gen: "random_int", min: 1, max: 5000 };
    const { onCommitGen } = setup(spec);
    const min = screen.getByRole("spinbutton", {
      name: ko.editor.genFieldMin("checkin"),
    }) as HTMLInputElement;
    const max = screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") });

    await user.click(min);
    await user.clear(min);
    await user.type(min, "1000");
    await user.click(max); // min이 blur되지만 짝 내부라 보류돼야 함

    expect(onCommitGen).not.toHaveBeenCalled();
    expect(min.value).toBe("1000"); // 값이 사라지지 않았다(이 단언이 진짜 이빨)
  });

  it("random_int: 단독 필드 step은 draft+blur 커밋", () => {
    const spec: GenSpec = { gen: "random_int", min: 1, max: 100, step: 5 };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") });
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, step: 10 });
  });

  it("random_int: step 무효값(0) blur → revert(커밋 없음, draft 원복)", () => {
    const spec: GenSpec = { gen: "random_int", min: 1, max: 100, step: 5 };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", {
      name: ko.editor.genFieldStep("checkin"),
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(onCommitGen).not.toHaveBeenCalled();
    expect(input.value).toBe("5");
  });
});

describe("GenVarEditor — 랜덤 문자열", () => {
  it("길이(1~64) draft+blur 커밋", () => {
    const spec: GenSpec = { gen: "random_string", length: 8 };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(onCommitGen).toHaveBeenCalledWith({ ...spec, length: 12 });
  });

  it("길이 65 blur → revert(범위 밖)", () => {
    const spec: GenSpec = { gen: "random_string", length: 8 };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", {
      name: ko.editor.genFieldLength("checkin"),
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "65" } });
    fireEvent.blur(input);
    expect(onCommitGen).not.toHaveBeenCalled();
    expect(input.value).toBe("8");
  });
});

describe("GenVarEditor — 샘플 미리보기 (US4)", () => {
  it("지원 밖 포맷(%j)은 '미리보기 불가' 문구를 보인다(거짓 미리보기 금지)", () => {
    setup({ gen: "date", format: "%j", tz: "UTC" });
    expect(screen.getByText(ko.editor.genSampleUnsupported)).toBeInTheDocument();
  });

  it("지원 포맷은 '예:' 접두 샘플을 보인다", () => {
    setup({ gen: "date", format: "%Y-%m-%d", tz: "UTC" });
    expect(screen.getByText(new RegExp(`^${ko.editor.genSamplePrefix}`))).toBeInTheDocument();
  });

  it("US4: 값 prop이 갱신되면(커밋 후 부모 재전달을 흉내) 샘플이 즉시 재계산된다", () => {
    const onCommitGen = vi.fn();
    const { rerender } = render(
      <GenVarEditor
        name="checkin"
        value={{ gen: "date", format: "%j", tz: "UTC" }}
        disabled={false}
        onCommitGen={onCommitGen}
        onCommitStatic={vi.fn()}
      />,
    );
    expect(screen.getByText(ko.editor.genSampleUnsupported)).toBeInTheDocument();
    rerender(
      <GenVarEditor
        name="checkin"
        value={{ gen: "date", format: "%Y-%m-%d", tz: "UTC" }}
        disabled={false}
        onCommitGen={onCommitGen}
        onCommitStatic={vi.fn()}
      />,
    );
    expect(screen.queryByText(ko.editor.genSampleUnsupported)).toBeNull();
    expect(screen.getByText(new RegExp(`^${ko.editor.genSamplePrefix}`))).toBeInTheDocument();
  });
});
