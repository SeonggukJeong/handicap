/**
 * Read a File as UTF-8 text via FileReader. jsdom does not implement
 * File.text()/Blob.text(), so the import-read path uses FileReader
 * (works in both jsdom and browsers). Mirrors ScenarioImportPage.readText.
 */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsText(file);
  });
}
