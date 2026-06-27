import { useRef, useState } from "react";
import { api, type DatasetUploadOptions } from "../../api/client";
import type { DatasetPreview } from "../../api/schemas";
import { useUploadDataset } from "../../api/hooks";
import { Button } from "../Button";
import { ko } from "../../i18n/ko";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Callout } from "../ui/Callout";

type Options = {
  header: boolean;
  delimiter: string; // "" = auto
  encoding: string; // "" = auto
  sheet: string; // "" = first
};

function toUploadOptions(o: Options): DatasetUploadOptions {
  return {
    header: o.header,
    delimiter: o.delimiter || undefined,
    encoding: o.encoding || undefined,
    sheet: o.sheet || undefined,
  };
}

export function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [opts, setOpts] = useState<Options>({
    header: true,
    delimiter: "",
    encoding: "",
    sheet: "",
  });
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadDataset();

  async function runPreview(f: File, o: Options) {
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewDataset(f, toUploadOptions(o));
      setPreview(p);
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function onPick(f: File | null) {
    setFile(f);
    setPreview(null);
    if (f) {
      if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
      void runPreview(f, opts);
    }
  }

  function changeOpt(patch: Partial<Options>) {
    const next = { ...opts, ...patch };
    setOpts(next);
    if (file) void runPreview(file, next);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0] ?? null;
    onPick(f);
  }

  async function save() {
    if (!file) return;
    await upload.mutateAsync({ file, opts: { ...toUploadOptions(opts), name: name || undefined } });
    // 성공: 리셋
    setFile(null);
    setPreview(null);
    setName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <section aria-label={ko.dataset.uploadAria} className="border border-slate-200 rounded-md p-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border-2 border-dashed border-slate-300 rounded-md p-6 text-center text-sm text-slate-500"
      >
        <p className="mb-2">CSV/XLSX 파일을 끌어다 놓거나</p>
        <label className="inline-block">
          <span className="sr-only">{ko.dataset.chooseFileSr}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-label={ko.dataset.chooseFileAria}
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="block text-sm"
          />
        </label>
      </div>

      {file && (
        <div className="mt-4 flex flex-wrap gap-3 items-end">
          <label className="block text-sm">
            <span className="text-slate-600">{ko.dataset.nameLabel}</span>
            <div className="mt-1 w-48">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">{ko.dataset.headerLabel}</span>
            <div className="mt-1 w-36">
              <Select
                aria-label={ko.dataset.headerLabel}
                value={opts.header ? "true" : "false"}
                onChange={(e) => changeOpt({ header: e.target.value === "true" })}
              >
                <option value="true">첫 행 = 헤더</option>
                <option value="false">헤더 없음</option>
              </Select>
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">{ko.dataset.delimiterLabel}</span>
            <div className="mt-1 w-36">
              <Select
                aria-label={ko.dataset.delimiterLabel}
                value={opts.delimiter}
                onChange={(e) => changeOpt({ delimiter: e.target.value })}
              >
                <option value="">{ko.dataset.optionAuto}</option>
                <option value=",">{ko.dataset.delimiterComma}</option>
                <option value=";">{ko.dataset.delimiterSemicolon}</option>
                <option value="\t">{ko.dataset.delimiterTab}</option>
              </Select>
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">{ko.dataset.encodingLabel}</span>
            <div className="mt-1 w-40">
              <Select
                aria-label={ko.dataset.encodingLabel}
                value={opts.encoding}
                onChange={(e) => changeOpt({ encoding: e.target.value })}
              >
                <option value="">{ko.dataset.optionAuto}</option>
                <option value="utf-8">UTF-8</option>
                <option value="cp949">CP949 (EUC-KR)</option>
              </Select>
            </div>
          </label>
          {preview?.sheets && preview.sheets.length > 1 && (
            <label className="block text-sm">
              <span className="text-slate-600">{ko.dataset.sheetLabel}</span>
              <div className="mt-1 w-36">
                <Select
                  aria-label={ko.dataset.sheetLabel}
                  value={opts.sheet}
                  onChange={(e) => changeOpt({ sheet: e.target.value })}
                >
                  {preview.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            </label>
          )}
        </div>
      )}

      {busy && (
        <p role="status" className="mt-3 text-sm text-slate-500">
          {ko.common.parsing}
        </p>
      )}
      {error && (
        <Callout variant="error" role="alert" className="mt-3">
          {error}
        </Callout>
      )}

      {preview && (
        <div className="mt-4">
          <p className="text-sm text-slate-600 mb-2">
            {preview.columns.length} columns · {preview.row_count} rows (showing{" "}
            {preview.sample.length})
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border border-slate-200">
              <thead className="bg-slate-50 text-left">
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className="px-2 py-1 border-b border-slate-200 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {preview.columns.map((c) => (
                      <td key={c} className="px-2 py-1">
                        {row[c] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Button onClick={save} disabled={upload.isPending}>
              {ko.dataset.saveDataset}
            </Button>
            {upload.error && (
              <span role="alert" className="ml-3 text-sm text-red-600">
                {(upload.error as Error).message}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
