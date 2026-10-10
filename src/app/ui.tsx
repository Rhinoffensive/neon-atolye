import { useState, type ReactNode } from 'react';

export function Section({ title, children, open = true, right }: { title: string; children: ReactNode; open?: boolean; right?: ReactNode }) {
  const [o, setO] = useState(open);
  return (
    <section className="section">
      <header onClick={() => setO(!o)}>
        <span className="chev">{o ? '▾' : '▸'}</span>
        <span className="title">{title}</span>
        {right && (
          <span className="right" onClick={(e) => e.stopPropagation()}>
            {right}
          </span>
        )}
      </header>
      {o && <div className="body">{children}</div>}
    </section>
  );
}

export function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  unit,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const shown = txt ?? String(+value.toFixed(3)).replace('.', ',');
  return (
    <label className="field" title={hint}>
      <span className="lbl">{label}</span>
      <span className="inp">
        <input
          inputMode="decimal"
          value={shown}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setTxt(e.target.value);
            const v = parseFloat(e.target.value.replace(',', '.'));
            if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
          }}
          onBlur={() => setTxt(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const k = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
              setTxt(null);
              onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, +(value + k).toFixed(4))));
            }
          }}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  const f = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className={`bar ${value > max ? 'over' : ''}`}>
      <div className="fill" style={{ width: `${f * 100}%`, background: color }} />
    </div>
  );
}
