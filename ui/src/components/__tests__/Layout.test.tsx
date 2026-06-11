import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ko } from "../../i18n/ko";
import { Layout } from "../Layout";

describe("Layout nav", () => {
  it("네비 4개가 한국어 라벨로 올바른 경로를 가리킨다", () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: ko.nav.scenarios })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: ko.nav.datasets })).toHaveAttribute(
      "href",
      "/datasets",
    );
    expect(screen.getByRole("link", { name: ko.nav.environments })).toHaveAttribute(
      "href",
      "/environments",
    );
    expect(screen.getByRole("link", { name: ko.nav.schedules })).toHaveAttribute(
      "href",
      "/schedules",
    );
  });
});
