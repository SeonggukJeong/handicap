import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriggerBuilder } from "../TriggerBuilder";
import * as api from "../../api/schedules";

beforeEach(() => {
  vi.spyOn(api, "previewNext").mockResolvedValue([1_700_000_000_000]);
});

describe("TriggerBuilder", () => {
  it("daily mode emits compiled cron trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TriggerBuilder onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /매일/ }));
    const time = screen.getByLabelText(/시각/);
    await user.clear(time);
    await user.type(time, "02:00");
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ kind: "cron", cron_expr: "0 2 * * *" }),
    );
  });

  it("shows preview-next results", async () => {
    const user = userEvent.setup();
    render(<TriggerBuilder onChange={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: /간격/ }));
    await waitFor(() => expect(api.previewNext).toHaveBeenCalled());
    expect(await screen.findByText(/다음 발사/)).toBeInTheDocument();
  });
});
