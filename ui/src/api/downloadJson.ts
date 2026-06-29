type SaveTypes = Array<{ description: string; accept: Record<string, string[]> }>;

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: SaveTypes;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available — bypasses the browser
// download manager (Chrome Safe Browsing online check blocks downloads when
// the host is offline, an actual air-gapped scenario, ADR-0001). Returns true
// if handled (success OR user cancelled); false if the API is missing or threw.
async function saveViaPicker(filename: string, text: string, types: SaveTypes): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const handle = await picker.call(window, { suggestedName: filename, types });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return true; // user cancelled
    return false;
  }
}

function saveViaBlobUrl(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to read the blob bytes.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const JSON_TYPES: SaveTypes = [{ description: "JSON", accept: { "application/json": [".json"] } }];
const YAML_TYPES: SaveTypes = [
  { description: "YAML", accept: { "application/yaml": [".yaml", ".yml"] } },
];

/** Save arbitrary `text` to a file: File System Access picker first, blob-URL anchor fallback. */
export async function downloadText(
  filename: string,
  text: string,
  mime: string,
  types: SaveTypes,
): Promise<void> {
  const saved = await saveViaPicker(filename, text, types);
  if (!saved) saveViaBlobUrl(filename, text, mime);
}

/** Save `data` as a pretty-printed JSON file. */
export async function downloadJson(filename: string, data: unknown): Promise<void> {
  await downloadText(filename, JSON.stringify(data, null, 2), "application/json", JSON_TYPES);
}

/** Save YAML `text` as a .yaml file. */
export async function downloadYaml(filename: string, text: string): Promise<void> {
  await downloadText(filename, text, "application/yaml", YAML_TYPES);
}
