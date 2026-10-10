import { create } from 'zustand';
import { produce } from 'immer';
import type { Doc, DesignStroke, PlanResult } from '../core/model/types';
import { newDoc } from '../core/model/defaults';

export type View = 'design' | 'plan' | 'preview' | 'build';
export type Tool = 'select' | 'draw';

interface State {
  doc: Doc;
  past: Doc[];
  future: Doc[];
  lastKey: string | null;
  lastAt: number;
  selectedItemId: string | null;
  selectedPieceId: string | null;
  view: View;
  tool: Tool;
  strokes: DesignStroke[];
  plan: PlanResult | null;
  planMs: number;
  planError: string | null;
  /** build mode: 0 = preparation, k = piece k */
  buildStep: number;
  buildDone: Record<string, boolean>;
  /** viewport in mm: centre + mm per pixel */
  cam: { cx: number; cy: number; mmPerPx: number };

  update: (fn: (d: Doc) => void, coalesceKey?: string) => void;
  replaceDoc: (d: Doc) => void;
  undo: () => void;
  redo: () => void;
  set: (p: Partial<State>) => void;
}

const STORAGE_KEY = 'neon-atolye-doc-v1';

function loadDoc(): Doc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as Doc;
      if (d?.version === 1 && Array.isArray(d.items) && d.profiles?.length) return d;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return newDoc();
}

export const useStore = create<State>((set, get) => ({
  doc: loadDoc(),
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,
  selectedItemId: null,
  selectedPieceId: null,
  view: 'plan',
  tool: 'select',
  strokes: [],
  plan: null,
  planMs: 0,
  planError: null,
  cam: { cx: 150, cy: -40, mmPerPx: 0.6 },
  buildStep: 0,
  buildDone: (() => {
    try {
      return JSON.parse(localStorage.getItem('neon-atolye-build-v1') ?? '{}');
    } catch {
      return {};
    }
  })(),

  update: (fn, coalesceKey) => {
    const s = get();
    const next = produce(s.doc, fn);
    if (next === s.doc) return;
    const now = Date.now();
    const coalesce = coalesceKey && coalesceKey === s.lastKey && now - s.lastAt < 800;
    set({
      doc: next,
      past: coalesce ? s.past : [...s.past.slice(-80), s.doc],
      future: [],
      lastKey: coalesceKey ?? null,
      lastAt: now,
    });
  },
  replaceDoc: (d) => {
    const s = get();
    set({ doc: d, past: [...s.past.slice(-80), s.doc], future: [], selectedItemId: null, selectedPieceId: null });
  },
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], lastKey: null });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ doc: next, past: [...s.past, s.doc], future: s.future.slice(1), lastKey: null });
  },
  set: (p) => set(p),
}));

// autosave
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s.doc));
    } catch {
      /* storage full or blocked */
    }
  }, 400);
});

useStore.subscribe((s, prev) => {
  if (s.buildDone === prev.buildDone) return;
  try {
    localStorage.setItem('neon-atolye-build-v1', JSON.stringify(s.buildDone));
  } catch {
    /* ignore */
  }
});

// planning in a worker
const worker = new Worker(new URL('../workers/plan.worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
let planTimer: ReturnType<typeof setTimeout> | undefined;
worker.onmessage = (e: MessageEvent) => {
  const { id, strokes, plan, ms, error } = e.data;
  if (id !== reqId) return; // stale
  if (error) {
    console.error(error);
    useStore.setState({ planError: error });
    return;
  }
  useStore.setState({ strokes, plan, planMs: ms, planError: null });
};
export function requestPlan(): void {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    reqId++;
    worker.postMessage({ id: reqId, doc: useStore.getState().doc, base: import.meta.env.BASE_URL });
  }, 60);
}
useStore.subscribe((s, prev) => {
  if (s.doc !== prev.doc) requestPlan();
});
requestPlan();

if (import.meta.env.DEV) (window as unknown as { __store: typeof useStore }).__store = useStore;
