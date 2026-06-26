type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available — bypasses the browser
// download manager (Chrome Safe Browsing online check blocks downloads when
// the host is offline, an actual air-gapped scenario, ADR-0001). Returns true
// if handled (success OR user cancelled); false if the API is missing or threw.
async function saveViaPicker(filename: string, json: string): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const handle = await picker.call(window, {
      suggestedName: filename,
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return true; // user cancelled
    return false;
  }
}

function saveViaBlobUrl(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
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

/** Save `data` as a pretty-printed JSON file. Extracted from the former
 *  DownloadJsonButton so menu items (and any caller) can invoke it directly. */
export async function downloadJson(filename: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const saved = await saveViaPicker(filename, json);
  if (!saved) saveViaBlobUrl(filename, json);
}
