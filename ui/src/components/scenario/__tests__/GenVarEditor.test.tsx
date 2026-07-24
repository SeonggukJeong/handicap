import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GenVarEditor } from "../GenVarEditor";
import { ko } from "../../../i18n/ko";
import { samplePreview, type GenSpec, type VarDeclValue } from "../../../scenario/genVars";

/** 표준 하니스 — GenVarEditor는 프레젠테이셔널이라 store 접촉 없이 콜백만 스파이한다.
 *  "outside" 형제 버튼은 min/max 짝-hold 테스트가 짝 *바깥*으로 포커스를 옮기는 데 쓴다
 *  (useThinkTimePair.test.tsx의 Harness 이디엄과 동일). sampleTick/onSampleRefresh는 T2
 *  신규 필수 props — 모든 기존 케이스는 tick=0(결정적) + no-op 스파이로 동작-보존. */
function setup(value: VarDeclValue, disabled = false) {
  const onCommitGen = vi.fn();
  const onCommitStatic = vi.fn();
  const onSampleRefresh = vi.fn();
  render(
    <div>
      <GenVarEditor
        name="checkin"
        value={value}
        disabled={disabled}
        sampleTick={0}
        onSampleRefresh={onSampleRefresh}
        onCommitGen={onCommitGen}
        onCommitStatic={onCommitStatic}
      />
      <button type="button">outside</button>
    </div>,
  );
  return { onCommitGen, onCommitStatic, onSampleRefresh };
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

  it("시각 라벨은 name 프리픽스 없는 bare 문구('날짜 형식'/'오프셋'/'타임존'/'형식 문자열') — aria-label은 name 프리픽스 유지 (Finding 1)", () => {
    setup({ gen: "date", format: "%Y년 %m월 %d일", tz: "Asia/Seoul" });
    expect(screen.getByText(ko.editor.genFieldLabelFormat)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.genFieldLabelOffset)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.genFieldLabelTz)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.genFieldLabelCustomFormat)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: ko.editor.genFieldFormatPreset("checkin") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: ko.editor.genFieldFormatCustom("checkin") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: ko.editor.genFieldOffset("checkin") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: ko.editor.genFieldTz("checkin") }),
    ).toBeInTheDocument();
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

  it("random_int: step 필드를 편집 없이 blur만 하면(spec에 step 키 없음) 커밋 0회 (Finding 2, 왕복 불변식)", () => {
    const spec: GenSpec = { gen: "random_int", min: 1, max: 100 };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") });
    fireEvent.blur(input);
    expect(onCommitGen).not.toHaveBeenCalled();
  });

  it("disabled=true면 min/max/step 필드가 비활성화된다 (Finding 3)", () => {
    setup({ gen: "random_int", min: 1, max: 100, step: 5 }, true);
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") }),
    ).toBeDisabled();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") }),
    ).toBeDisabled();
  });

  it("시각 라벨은 name 프리픽스 없는 bare 문구('최소'/'최대'/'단위') — aria-label은 name 프리픽스 유지 (Finding 1)", () => {
    setup({ gen: "random_int", min: 1, max: 100, step: 5 });
    expect(screen.getByText(ko.editor.genFieldLabelMin)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.genFieldLabelMax)).toBeInTheDocument();
    expect(screen.getByText(ko.editor.genStepUnit)).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") }),
    ).toBeInTheDocument();
  });

  it("US1: min/max draft 변경 즉시 예시가 새 구간을 반영한다", () => {
    const spec: GenSpec = { gen: "random_int", min: 1, max: 100 };
    setup(spec);
    fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") }), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") }), {
      target: { value: "600" },
    });
    const expected = samplePreview({ gen: "random_int", min: 500, max: 600 }, "checkin", 0);
    if (expected.kind !== "ok") throw new Error("expected ok");
    expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
  });

  it("단위(step) 무효 draft 안내 + min=1 속성 + aria-describedby 배선(US: per-field 무효 안내)", () => {
    setup({ gen: "random_int", min: 1, max: 100, step: 5 });
    const st = screen.getByRole("spinbutton", { name: ko.editor.genFieldStep("checkin") });
    expect(st).toHaveAttribute("min", "1");
    for (const bad of ["0", "-1", "1.5"]) {
      fireEvent.change(st, { target: { value: bad } });
      const hint = screen.getByText(ko.editor.genStepInvalid);
      expect(st).toHaveAttribute("aria-invalid", "true");
      expect(st.getAttribute("aria-describedby")).toBe(hint.id);
    }
    fireEvent.change(st, { target: { value: "5" } }); // 유효 복귀 — describedby 해제
    expect(st).not.toHaveAttribute("aria-describedby");
  });

  it("최소/최대 비정수 draft는 per-field 안내 + 각자 별도 id로 aria-describedby(US: per-field 무효 안내)", () => {
    // "abc" 등 순수 비숫자 문자열은 브리프 원안이지만, HTML5 number-input value
    // sanitization(스펙+jsdom 실측 — /tmp probe로 확인)이 저장 *전에* ""로 지워버려
    // 검증 로직에 도달 못 한다. "1.5"는 유효 float 문자열이라 살아남으면서도
    // parseValidInt(정수 전용 regex)엔 걸려 같은 genIntInvalid 분기를 태운다.
    setup({ gen: "random_int", min: 1, max: 100 });
    const min = screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") });
    fireEvent.change(min, { target: { value: "1.5" } });
    const minHint = screen.getByText(ko.editor.genIntInvalid); // max는 아직 유효 — 단일 매치
    expect(min.getAttribute("aria-describedby")).toBe(minHint.id);
    fireEvent.change(min, { target: { value: "1" } });
    expect(min).not.toHaveAttribute("aria-describedby");

    // min/max 둘 다 비정수면 같은 문구의 hint가 둘 존재 — 각 input은 *자기* id만 가리켜야 한다.
    const max = screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") });
    fireEvent.change(min, { target: { value: "1.5" } });
    fireEvent.change(max, { target: { value: "2.5" } });
    const minId = min.getAttribute("aria-describedby");
    const maxId = max.getAttribute("aria-describedby");
    expect(minId).toBeTruthy();
    expect(maxId).toBeTruthy();
    expect(minId).not.toBe(maxId);
    expect(document.getElementById(minId!)).toHaveTextContent(ko.editor.genIntInvalid);
    expect(document.getElementById(maxId!)).toHaveTextContent(ko.editor.genIntInvalid);
  });

  it("US4: min>max면 적용되지 않음 안내 + 양측 aria-invalid + describedby, blur해도 no-op(정책 불변)", () => {
    const { onCommitGen } = setup({ gen: "random_int", min: 1, max: 100 });
    const min = screen.getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") });
    const max = screen.getByRole("spinbutton", { name: ko.editor.genFieldMax("checkin") });
    fireEvent.change(min, { target: { value: "500" } });
    fireEvent.change(max, { target: { value: "200" } });
    const msg = screen.getByText(ko.editor.genMinMaxConflict); // 전문 exact
    expect(min).toHaveAttribute("aria-invalid", "true");
    expect(max).toHaveAttribute("aria-invalid", "true");
    expect(min.getAttribute("aria-describedby")).toBe(msg.id);
    fireEvent.blur(max); // relatedTarget=null → 짝-hold 미발동 → commit 경로 → min>max no-op
    expect(onCommitGen).not.toHaveBeenCalled();
    expect((min as HTMLInputElement).value).toBe("500"); // draft 보존(기존 동작)
    expect(screen.getByText(ko.editor.genMinMaxConflict)).toBeInTheDocument(); // 안내는 남는다
  });

  it("random_int 필드 컨테이너는 폭-적응 그리드", () => {
    setup({ gen: "random_int", min: 1, max: 100 });
    const grid = screen
      .getByRole("spinbutton", { name: ko.editor.genFieldMin("checkin") })
      .closest("div.grid")!; // 그리드 전환 전(RED)엔 null → `!` deref throw = RED
    const tokens = grid.className.split(/\s+/);
    expect(tokens).toContain("grid");
    expect(tokens).toContain("grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))]");
  });
});

describe("GenVarEditor — 랜덤 문자열", () => {
  it("길이 필드는 w-16 폭 유지(random_int 그리드 전환과 무관)", () => {
    setup({ gen: "random_string", length: 8 });
    const input = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    const tokens = input.className.split(/\s+/);
    expect(tokens).toContain("w-16");
  });

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

  it("US3: 길이 input은 native 구속 속성(min/max/step)을 갖는다", () => {
    setup({ gen: "random_string", length: 8 });
    const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    expect(len).toHaveAttribute("min", "1");
    expect(len).toHaveAttribute("max", "64");
    expect(len).toHaveAttribute("step", "1");
  });

  it("US3: 범위 밖 길이 draft는 그 자리에서 안내 + aria-invalid + aria-describedby(US: per-field 무효 안내)", () => {
    setup({ gen: "random_string", length: 8 });
    const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    for (const bad of ["0", "-1", "65", "3.5"]) {
      fireEvent.change(len, { target: { value: bad } });
      const hint = screen.getByText(ko.editor.genLengthInvalid); // 전문 exact
      expect(len).toHaveAttribute("aria-invalid", "true");
      expect(len.getAttribute("aria-describedby")).toBe(hint.id);
    }
    fireEvent.change(len, { target: { value: "12" } });
    expect(screen.queryByText(ko.editor.genLengthInvalid)).not.toBeInTheDocument();
    expect(len).not.toHaveAttribute("aria-invalid");
    expect(len).not.toHaveAttribute("aria-describedby");
  });

  it("US3 특성화: 무효 길이는 blur 시 기존대로 revert되고 안내도 사라진다(정책 불변)", () => {
    const { onCommitGen } = setup({ gen: "random_string", length: 8 });
    const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    fireEvent.change(len, { target: { value: "65" } });
    fireEvent.blur(len);
    expect(onCommitGen).not.toHaveBeenCalled();
    expect((len as HTMLInputElement).value).toBe("8"); // revert(기존 동작)
    expect(screen.queryByText(ko.editor.genLengthInvalid)).not.toBeInTheDocument();
  });

  it("길이 필드를 편집 없이 blur만 하면(spec에 length 키 없음, draft 기본값 8) 커밋 0회 (Finding 2, 왕복 불변식)", () => {
    const spec: GenSpec = { gen: "random_string" };
    const { onCommitGen } = setup(spec);
    const input = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    fireEvent.blur(input);
    expect(onCommitGen).not.toHaveBeenCalled();
  });

  it("disabled=true면 길이 필드가 비활성화된다 (Finding 3)", () => {
    setup({ gen: "random_string", length: 8 }, true);
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") }),
    ).toBeDisabled();
  });

  it("시각 라벨은 name 프리픽스 없는 bare 문구('길이') — aria-label은 name 프리픽스 유지 (Finding 1)", () => {
    setup({ gen: "random_string", length: 8 });
    expect(screen.getByText(ko.editor.genFieldLabelLength)).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") }),
    ).toBeInTheDocument();
  });

  it("US1: 길이 draft 변경(blur 없이) 즉시 예시가 새 길이를 반영한다", () => {
    const spec: GenSpec = { gen: "random_string", length: 8 };
    const { onCommitGen } = setup(spec);
    const len = screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") });
    fireEvent.change(len, { target: { value: "12" } });
    const expected = samplePreview({ gen: "random_string", length: 12 }, "checkin", 0);
    if (expected.kind !== "ok") throw new Error("expected ok");
    expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
    expect(onCommitGen).not.toHaveBeenCalled(); // 커밋 경계는 여전히 blur(동작-보존)
  });

  it("US1: 무효 길이 draft(0)는 예시를 커밋값 기준으로 유지한다", () => {
    const spec: GenSpec = { gen: "random_string", length: 8 };
    setup(spec);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: ko.editor.genFieldLength("checkin") }),
      {
        target: { value: "0" },
      },
    );
    const expected = samplePreview(spec, "checkin", 0);
    if (expected.kind !== "ok") throw new Error("expected ok");
    expect(screen.getByTitle(`${ko.editor.genSamplePrefix} ${expected.text}`)).toBeInTheDocument();
  });
});

describe("GenVarEditor — 샘플 미리보기", () => {
  it("지원 밖 포맷(%j)은 '미리보기 불가' 문구를 보인다(거짓 미리보기 금지)", () => {
    setup({ gen: "date", format: "%j", tz: "UTC" });
    expect(screen.getByText(ko.editor.genSampleUnsupported)).toBeInTheDocument();
  });

  it("지원 포맷은 '예:' 접두 샘플을 보인다", () => {
    setup({ gen: "date", format: "%Y-%m-%d", tz: "UTC" });
    expect(screen.getByText(new RegExp(`^${ko.editor.genSamplePrefix}`))).toBeInTheDocument();
  });

  it("값 prop이 갱신되면(커밋 후 부모 재전달을 흉내) 샘플이 즉시 재계산된다", () => {
    const onCommitGen = vi.fn();
    const { rerender } = render(
      <GenVarEditor
        name="checkin"
        value={{ gen: "date", format: "%j", tz: "UTC" }}
        disabled={false}
        sampleTick={0}
        onSampleRefresh={vi.fn()}
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
        sampleTick={0}
        onSampleRefresh={vi.fn()}
        onCommitGen={onCommitGen}
        onCommitStatic={vi.fn()}
      />,
    );
    expect(screen.queryByText(ko.editor.genSampleUnsupported)).toBeNull();
    expect(screen.getByText(new RegExp(`^${ko.editor.genSamplePrefix}`))).toBeInTheDocument();
  });

  it("↻ 버튼: onSampleRefresh 호출 + aria/title 계약 + yamlError(disabled)에도 활성", () => {
    const spec: GenSpec = { gen: "random_string", length: 8 };
    const onSampleRefresh = vi.fn();
    render(
      <GenVarEditor
        name="checkin"
        value={spec}
        disabled={true}
        sampleTick={0}
        onSampleRefresh={onSampleRefresh}
        onCommitGen={vi.fn()}
        onCommitStatic={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: ko.editor.genSampleRefreshAria("checkin") });
    expect(btn).toHaveAttribute("title", ko.editor.genSampleRefreshTitle);
    expect(btn).toBeEnabled(); // 미리보기-전용 로컬 조작 — 읽기 전용 크롬
    fireEvent.click(btn);
    expect(onSampleRefresh).toHaveBeenCalledTimes(1);
  });
});
