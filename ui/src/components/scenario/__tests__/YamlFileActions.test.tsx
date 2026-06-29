import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { YamlFileActions } from "../YamlFileActions";
import { useScenarioEditor } from "../../../scenario/store";
import { ko } from "../../../i18n/ko";
import { downloadYaml } from "../../../api/downloadJson";
import { readTextFile } from "../../../api/readTextFile";

vi.mock("../../../api/downloadJson", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/downloadJson")>()),
  downloadYaml: vi.fn(),
}));
vi.mock("../../../api/readTextFile", () => ({ readTextFile: vi.fn() }));

const EMPTY_YAML = 'version: 1\nname: "Untitled"\ncookie_jar: auto\nvariables: {}\nsteps: []\n';
const IMPORTED_YAML = "version: 1\nname: Imported\ncookie_jar: auto\nvariables: {}\nsteps: []\n";

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}
function dummyFile() {
  return new File(["ignored — readTextFile is mocked"], "s.yaml", { type: "application/yaml" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readTextFile).mockResolvedValue(IMPORTED_YAML);
  useScenarioEditor.getState().loadFromString(EMPTY_YAML);
});

describe("YamlFileActions — export", () => {
  it("downloads YAML with the filename derived from the scenario name", async () => {
    useScenarioEditor
      .getState()
      .loadFromString(
        'version: 1\nname: "Login Flow"\ncookie_jar: auto\nvariables: {}\nsteps: []\n',
      );
    render(<YamlFileActions />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.exportYamlAria }));
    await waitFor(() => expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1));
    const [filename, text] = vi.mocked(downloadYaml).mock.calls[0];
    expect(filename).toBe("Login Flow.yaml");
    expect(text).toContain("Login Flow");
  });

  it("falls back to scenario.yaml when the current buffer is invalid", async () => {
    // version literal 1 required → ScenarioModel fails → model null, yamlText kept.
    useScenarioEditor.getState().loadFromString("version: 2\nname: x\n");
    render(<YamlFileActions />);
    fireEvent.click(screen.getByRole("button", { name: ko.editor.exportYamlAria }));
    await waitFor(() => expect(vi.mocked(downloadYaml)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadYaml).mock.calls[0][0]).toBe("scenario.yaml");
  });
});

describe("YamlFileActions — import", () => {
  it("loads the file without confirming when the editor is empty", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("confirms before replacing when steps exist, and replaces on accept", async () => {
    useScenarioEditor.getState().loadFromString(EMPTY_YAML);
    useScenarioEditor.getState().addStep("Step one"); // guaranteed-valid http step
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(confirmSpy).toHaveBeenCalledWith(ko.editor.importReplaceConfirm);
  });

  it("keeps current content when the replace confirm is cancelled", async () => {
    useScenarioEditor.getState().loadFromString(EMPTY_YAML);
    useScenarioEditor.getState().addStep("Step one");
    const nameBefore = useScenarioEditor.getState().model?.name;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(useScenarioEditor.getState().model?.name).toBe(nameBefore);
  });

  it("confirms when the current buffer is non-empty but invalid (yamlError set)", async () => {
    useScenarioEditor.getState().loadFromString("version: 2\nname: broken\n");
    expect(useScenarioEditor.getState().model).toBeNull();
    expect(useScenarioEditor.getState().yamlError).not.toBeNull();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
  });

  it("resets the input value so the same file can be re-picked", async () => {
    const { container } = render(<YamlFileActions />);
    const input = fileInput(container);
    fireEvent.change(input, { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().model?.name).toBe("Imported"));
    expect(input.value).toBe("");
  });

  it("loads invalid YAML leniently — sets yamlError, does not throw (acceptance #5)", async () => {
    // Empty editor → no confirm; invalid file content loads as text via loadFromString (lenient, spec §3.3).
    vi.mocked(readTextFile).mockResolvedValueOnce("version: 2\nname: bad\n");
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    await waitFor(() => expect(useScenarioEditor.getState().yamlError).not.toBeNull());
    expect(useScenarioEditor.getState().model).toBeNull();
  });

  it("shows an alert when the file read fails", async () => {
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error("read boom"));
    const { container } = render(<YamlFileActions />);
    fireEvent.change(fileInput(container), { target: { files: [dummyFile()] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("read boom");
  });
});
