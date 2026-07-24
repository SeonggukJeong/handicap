import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useScenarioEditor } from "../../scenario/store";
import { loadNotesCollapsed, setNotesCollapsed } from "../../scenario/notesPrefs";
import { Callout } from "../ui/Callout";
import { Textarea } from "../ui/Textarea";
import { ko } from "../../i18n/ko";

/** 초기 표시 높이만 6줄(9.5rem=152px)로 클램프. max-height가 아니라 height 세팅이라
 *  네이티브 resize-y가 양방향으로 동작한다(max-height는 늘리기를 막는다 — spec R7).
 *  jsdom은 scrollHeight 0 → no-op(AutoGrowTextarea 선례), 실제 높이는 라이브 검증 담당. */
const INITIAL_CLAMP_PX = 152;

const GHOST_BTN =
  "shrink-0 rounded border border-accent-200 px-2 py-0.5 text-xs text-accent-800 " +
  "hover:bg-accent-100 disabled:opacity-50";

export function ScenarioNotesCallout() {
  const { id: scenarioId } = useParams<{ id: string }>();
  const model = useScenarioEditor((s) => s.model);
  const yamlError = useScenarioEditor((s) => s.yamlError);
  const setNotes = useScenarioEditor((s) => s.setNotes);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    scenarioId !== undefined ? loadNotesCollapsed()[scenarioId] === true : false,
  );

  const notes = model?.notes;
  const hasNotes = notes !== undefined && notes.trim() !== "";

  // 접힘 기억 정리 — 현재 시나리오 키 한정(spec R3: 전역 스캔 없음).
  useEffect(() => {
    if (scenarioId !== undefined && model !== null && !hasNotes) {
      setNotesCollapsed(scenarioId, false);
    }
  }, [scenarioId, model, hasNotes]);

  const bodyRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el: HTMLElement | null = editing ? taRef.current : bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    const full = el.scrollHeight;
    if (full === 0) return; // jsdom — 레이아웃 미구현
    el.style.height = `${Math.min(full, INITIAL_CLAMP_PX)}px`;
  }, [editing, notes, collapsed]);

  if (model === null) return null; // YAML 파싱 불가 — 죽은 진입 라인 노출 금지(spec)

  // yamlError 동안 dispatch는 no-op(무음 유실 — think-time-defaults S1) → 편집 차단.
  const locked = yamlError !== null;

  const startEdit = () => {
    setDraft(notes ?? "");
    setEditing(true);
  };
  const commit = () => {
    setNotes(draft.trim() === "" ? undefined : draft);
    setEditing(false);
  };
  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    if (scenarioId !== undefined) setNotesCollapsed(scenarioId, next);
  };

  if (!hasNotes && !editing) {
    return (
      <button
        type="button"
        disabled={locked}
        onClick={startEdit}
        aria-label={ko.scenarioNotes.addAria}
        className="rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-left text-sm text-slate-500 hover:border-accent-300 hover:text-accent-700 disabled:opacity-50"
      >
        {ko.scenarioNotes.addLine}
      </button>
    );
  }

  if (collapsed && !editing) {
    const firstLine = (notes ?? "").trim().split("\n")[0];
    return (
      <div
        role="note"
        aria-label={ko.scenarioNotes.title}
        className="flex items-center justify-between gap-2 rounded-md border border-accent-200 bg-accent-50 px-3 py-1.5 text-sm text-accent-800"
      >
        <p className="min-w-0 truncate">
          <span aria-hidden="true">📝 </span>
          <span className="font-medium">{ko.scenarioNotes.title}</span>
          <span aria-hidden="true"> · </span>
          {firstLine}
        </p>
        <button
          type="button"
          onClick={() => toggleCollapsed(false)}
          aria-label={ko.scenarioNotes.expandAria}
          className={GHOST_BTN}
        >
          {ko.scenarioNotes.expand}
        </button>
      </div>
    );
  }

  return (
    <Callout variant="info" role="note" aria-label={ko.scenarioNotes.title}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">
          <span aria-hidden="true">📝 </span>
          {ko.scenarioNotes.title}
        </p>
        {editing ? (
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={commit}
              aria-label={ko.scenarioNotes.doneAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.done}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label={ko.scenarioNotes.cancelAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.cancel}
            </button>
          </span>
        ) : (
          <span className="flex gap-1.5">
            <button
              type="button"
              onClick={() => toggleCollapsed(true)}
              aria-label={ko.scenarioNotes.collapseAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.collapse}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={startEdit}
              aria-label={ko.scenarioNotes.editAria}
              className={GHOST_BTN}
            >
              {ko.scenarioNotes.edit}
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={ko.scenarioNotes.textareaAria}
          className="mt-1.5 resize-y bg-white"
        />
      ) : (
        <pre
          ref={bodyRef}
          className="mt-1.5 resize-y overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm"
        >
          {notes}
        </pre>
      )}
    </Callout>
  );
}
