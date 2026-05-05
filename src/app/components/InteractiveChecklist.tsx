"use client";

import { useEffect, useState, useCallback, ReactNode } from "react";

interface CheckItem {
  id: string;            // stable ID — used as localStorage key
  content: ReactNode;    // what to render when not done
  doneClassName?: string;// extra classes when done
  className?: string;    // wrapper classes when not done
}

interface Props {
  items: CheckItem[];
  storagePrefix: string;       // namespaced key, e.g. "actionZone" or "actionItem"
  emptyMessage?: string;
  showResetButton?: boolean;
  hideWhenAllDone?: boolean;
  onChange?: (doneIds: string[]) => void;
}

interface DoneRecord {
  doneAt: number; // unix ms
}

export default function InteractiveChecklist({
  items,
  storagePrefix,
  emptyMessage = "Nothing to action.",
  showResetButton = true,
  hideWhenAllDone = false,
  onChange,
}: Props) {
  const [done, setDone] = useState<Record<string, DoneRecord>>({});
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage once on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`cg-checklist::${storagePrefix}`);
      setDone(raw ? JSON.parse(raw) : {});
    } catch {
      setDone({});
    }
    setHydrated(true);
  }, [storagePrefix]);

  // Persist
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(`cg-checklist::${storagePrefix}`, JSON.stringify(done));
      onChange?.(Object.keys(done));
    } catch {
      // ignore quota errors silently
    }
  }, [done, storagePrefix, hydrated, onChange]);

  const toggle = useCallback((id: string) => {
    setDone((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { doneAt: Date.now() };
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    if (confirm("Clear all completed items?")) setDone({});
  }, []);

  // Sort: pending first, completed at bottom
  const sortedItems = items.slice().sort((a, b) => {
    const aDone = !!done[a.id];
    const bDone = !!done[b.id];
    if (aDone === bDone) return 0;
    return aDone ? 1 : -1;
  });

  const doneCount = Object.keys(done).filter((id) => items.some((i) => i.id === id)).length;
  const allDone = items.length > 0 && doneCount === items.length;

  if (items.length === 0) return <p className="text-xs text-gray-400 italic">{emptyMessage}</p>;
  if (hideWhenAllDone && allDone) {
    return (
      <div className="text-xs text-emerald-400 italic flex items-center justify-between">
        <span>✓ All {items.length} items done</span>
        {showResetButton && <button onClick={reset} className="text-gray-500 hover:text-gray-300 underline text-[10px]">reset</button>}
      </div>
    );
  }

  return (
    <div>
      {showResetButton && doneCount > 0 && (
        <div className="flex justify-end mb-2">
          <button onClick={reset} className="text-[10px] text-gray-500 hover:text-gray-300 underline font-mono">
            reset {doneCount} done
          </button>
        </div>
      )}
      <div className="space-y-2">
        {sortedItems.map((item) => {
          const isDone = !!done[item.id];
          const doneAt = done[item.id]?.doneAt;
          return (
            <div key={item.id} className="flex items-start gap-2">
              <button
                onClick={() => toggle(item.id)}
                aria-label={isDone ? "Mark not done" : "Mark done"}
                className={`mt-1 w-4 h-4 shrink-0 rounded border-2 flex items-center justify-center text-[10px] font-bold transition-colors ${
                  isDone
                    ? "bg-emerald-600 border-emerald-600 text-white"
                    : "border-gray-600 hover:border-emerald-500 text-transparent hover:text-emerald-500"
                }`}
              >
                ✓
              </button>
              <div className={`flex-1 transition-opacity ${isDone ? `opacity-40 line-through ${item.doneClassName ?? ""}` : item.className ?? ""}`}>
                {item.content}
                {isDone && doneAt && (
                  <p className="text-[9px] text-gray-600 font-mono mt-0.5 no-underline opacity-100">
                    done {new Date(doneAt).toLocaleString("en-US", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
