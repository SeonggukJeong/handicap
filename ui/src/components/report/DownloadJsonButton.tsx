import { useCallback } from "react";

type Props = { filename: string; data: unknown };

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available. Bypasses the browser
// download manager — notably Chrome's Safe Browsing online check, which
// blocks downloads when the host is offline (an actual scenario for
// air-gapped staging targets, ADR-0001). Returns true if handled (success
// OR user cancelled); false if the API itself is missing or threw, in
// which case the caller falls back to the blob anchor path.
async function saveViaPicker(filename: string, json: string): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return true;
  } catch (e) {
    // Cancel is a normal outcome — don't re-trigger via the fallback path.
    if ((e as { name?: string })?.name === "AbortError") return true;
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

export function DownloadJsonButton({ filename, data }: Props) {
  const handleClick = useCallback(async () => {
    const json = JSON.stringify(data, null, 2);
    const saved = await saveViaPicker(filename, json);
    if (!saved) saveViaBlobUrl(filename, json);
  }, [filename, data]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
    >
      Download JSON
    </button>
  );
}
