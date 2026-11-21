import { describe, expect, it } from "vitest";
import { josa } from "../josa";

describe("josa", () => {
  it("으로/로: 받침이 있으면 으로, 없거나 ㄹ 받침이면 로", () => {
    expect(josa("적합", "으로/로")).toBe("으로");
    expect(josa("부적합", "으로/로")).toBe("으로");
    expect(josa("✕ 부적합", "으로/로")).toBe("으로");
    expect(josa("0.1% 미만", "으로/로")).toBe("으로");
    expect(josa("3.1초", "으로/로")).toBe("로");
    expect(josa("240건/초", "으로/로")).toBe("로");
    expect(josa("오류율", "으로/로")).toBe("로");
  });

  it("숫자는 한국어 읽기의 끝소리로", () => {
    expect(josa("12%", "으로/로")).toBe("로");
    expect(josa("8", "으로/로")).toBe("로");
    expect(josa("7", "으로/로")).toBe("로");
    expect(josa("1", "으로/로")).toBe("로");
    expect(josa("3", "으로/로")).toBe("으로");
    expect(josa("6", "으로/로")).toBe("으로");
    expect(josa("10", "으로/로")).toBe("으로");
    expect(josa("2", "으로/로")).toBe("로");
    expect(josa("1", "이/가")).toBe("이");
    expect(josa("2", "이/가")).toBe("가");
    expect(josa("5", "은/는")).toBe("는");
    expect(josa("3", "을/를")).toBe("을");
  });

  it("이/가·은/는·을/를", () => {
    expect(josa("환경 변수", "이/가")).toBe("가");
    expect(josa("판정 기준", "이/가")).toBe("이");
    expect(josa("부하 조건·환경 변수", "이/가")).toBe("가");
    expect(josa("외 2개", "이/가")).toBe("가");
    expect(josa("처리량", "은/는")).toBe("은");
    expect(josa("95% 응답시간", "은/는")).toBe("은");
    expect(josa("시나리오", "을/를")).toBe("를");
  });

  it("닫는 괄호·따옴표·공백은 건너뛰고 그 앞 글자로", () => {
    expect(josa("'접수'", "으로/로")).toBe("로");
    expect(josa("'목록'", "으로/로")).toBe("으로");
    expect(josa('"단계"', "이/가")).toBe("가");
    expect(josa("기준(3초)", "으로/로")).toBe("로");
    expect(josa("적합 ", "으로/로")).toBe("으로");
  });

  it("%는 퍼센트, ms는 밀리초로 읽어 받침이 없다", () => {
    expect(josa("5%", "이/가")).toBe("가");
    expect(josa("12ms", "으로/로")).toBe("로");
    expect(josa("12ms", "이/가")).toBe("가");
  });

  it("읽을 수 없는 끝이면 두 꼴을 함께 쓴다", () => {
    expect(josa("abc", "으로/로")).toBe("(으)로");
    expect(josa("abc", "이/가")).toBe("(이)가");
    expect(josa("–", "은/는")).toBe("(은)는");
    expect(josa("", "을/를")).toBe("(을)를");
    expect(josa("●", "으로/로")).toBe("(으)로");
  });
});
