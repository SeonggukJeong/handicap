import { useEffect, useMemo } from "react";

type Props = { filename: string; data: unknown };

export function DownloadJsonButton({ filename, data }: Props) {
  const url = useMemo(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    return URL.createObjectURL(blob);
  }, [data]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <a
      href={url}
      download={filename}
      className="inline-block px-3 py-1.5 text-sm bg-slate-700 text-white rounded hover:bg-slate-800"
    >
      Download JSON
    </a>
  );
}
