import { ApiError } from "./client";
import { ApiErrorSchema } from "./schemas";

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
};

// Save via File System Access API when available. Bypasses the browser
// download manager — notably Chrome's Safe Browsing online check, which
// blocks downloads when the host is offline (ADR-0001). Returns true if
// handled (success OR user cancelled); false if the API is missing or threw.
async function saveBlobViaPicker(blob: Blob, filename: string, mime: string): Promise<boolean> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") return false;
  try {
    const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
    const handle = await picker({
      suggestedName: filename,
      types: ext
        ? [{ description: ext.slice(1).toUpperCase(), accept: { [mime]: [ext] } }]
        : undefined,
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return true; // user cancelled
    return false;
  }
}

function saveBlobViaUrl(blob: Blob, filename: string): void {
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

/**
 * Fetch a controller file route, surface 4xx as ApiError, then save the bytes.
 * Uses showSaveFilePicker when available; falls back to blob-URL anchor click.
 */
export async function downloadFile(url: string, filename: string, mime: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    let msg = text;
    try {
      msg = ApiErrorSchema.parse(JSON.parse(text)).error;
    } catch {
      /* keep raw text */
    }
    throw new ApiError(resp.status, msg || `${resp.status} ${resp.statusText}`);
  }
  const blob = await resp.blob();
  const saved = await saveBlobViaPicker(blob, filename, mime);
  if (!saved) saveBlobViaUrl(blob, filename);
}
