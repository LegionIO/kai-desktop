import { useState, useEffect, useId, useRef, useContext, createContext, type FC, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon, EyeIcon, EyeOffIcon } from 'lucide-react';

/**
 * Broadcasts the setting the user navigated to from settings search, so containers
 * that hide their own children (collapsed sections, inner tab bars) can reveal the
 * target before `SettingsPanel` tries to scroll to it.
 *
 * `anchorId` is the search entry's `id`; `fallbackId` is its always-mounted ancestor
 * (by existing convention in `search-index.ts`, that ancestor IS the collapsed
 * section's id). `nonce` changes on every navigation so re-searching the same
 * setting re-fires the effects even when the ids are unchanged.
 */
export type SettingsFocusRequest = { anchorId?: string; fallbackId?: string; nonce: number };

export const SettingsFocusContext = createContext<SettingsFocusRequest | null>(null);

/**
 * True when a focus request targets `id` either directly or as its declared
 * always-mounted ancestor — i.e. "should the container owning `id` open itself?".
 */
export function focusRequestTargets(request: SettingsFocusRequest | null, id: string | undefined): boolean {
  if (!request || !id) return false;
  return request.anchorId === id || request.fallbackId === id;
}

export function useSettingsFocus(): SettingsFocusRequest | null {
  return useContext(SettingsFocusContext);
}

export type SettingsProps = {
  config: Record<string, unknown>;
  updateConfig: (path: string, value: unknown) => Promise<void>;
  /** When set, tabbed panels should switch to this inner tab (used by settings search navigation). */
  focusTab?: string;
  /** Changes on every search navigation so `focusTab` effects re-fire even for the same tab value. */
  focusNonce?: number;
};

export const settingsSelectClass =
  'app-settings-select w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none';

export const Toggle: FC<{
  id?: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}> = ({ id, label, checked, onChange, disabled }) => (
  <label
    data-setting-id={id}
    className={`flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 px-3 py-2 ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="rounded"
    />
    <span className="text-xs">{label}</span>
  </label>
);

export const NumberField: FC<{
  id?: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}> = ({ id, label, value, onChange, min, max }) => (
  <div data-setting-id={id}>
    <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
    <input
      type="number"
      className="w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
    />
  </div>
);

/**
 * Number input that CLAMPS ON COMMIT (blur / Enter) instead of on every keystroke.
 *
 * Clamping inside `onChange` on a controlled input makes multi-digit values physically
 * untypable: with min=256, typing "4000" clamps the first "4" to 256, the field
 * re-renders as "256" with the caret at the end, and the remaining keystrokes append —
 * so you land on 16384, never 4000. Holding the raw string locally while focused and
 * clamping only on commit keeps every intermediate value typable (including a
 * transiently-empty field), while still guaranteeing the persisted value is in range.
 *
 * Blank/unparseable input reverts to the last good value rather than writing NaN or 0
 * (several schema fields are `.positive()`, and a rejected write would be swallowed by
 * ConfigProvider's catch, silently snapping the field back with no feedback).
 */
export const ClampedNumberField: FC<{
  id?: string;
  /** Omit when the caller already renders its own surrounding <label>. */
  label?: string;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
  className?: string;
  hint?: string;
}> = ({ id, label, value, onCommit, min, max, disabled, className, hint }) => {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);

  // Adopt external changes only while the user isn't typing, so a config broadcast
  // can't yank the field out from under a half-entered number.
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div data-setting-id={id}>
      {label && <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>}
      <input
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className={
          className ??
          'w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none disabled:opacity-50'
        }
      />
      {hint && <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">{hint}</span>}
    </div>
  );
};

/** Format a head/tail ratio (0–1) as "70% head, 30% tail" */
export function headTailLabel(prefix: string, ratio: number): string {
  const head = Math.round(ratio * 100);
  const tail = 100 - head;
  if (tail === 0) return `${prefix}: 100% head`;
  if (head === 0) return `${prefix}: 100% tail`;
  return `${prefix}: ${head}% head, ${tail}% tail`;
}

export const SliderField: FC<{
  id?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}> = ({ id, label, value, min, max, step, onChange }) => (
  <div data-setting-id={id}>
    <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
    <input
      type="range"
      className="w-full accent-[var(--color-primary)]"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </div>
);

/**
 * Text input that holds local state while the user types and only
 * flushes to the parent onChange on blur (or after a 600ms debounce).
 * Prevents cursor-jump issues caused by async config round-trips.
 */
export const TextField: FC<{
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
  /**
   * Emit `undefined` instead of `''` when the field is cleared — for optional
   * config keys where an empty string is not the same as "unset" (e.g. an
   * endpoint override that should fall back to a default when blank).
   */
  emptyAsUndefined?: boolean;
}> = ({ id, label, value, onChange, placeholder, mono, hint, emptyAsUndefined }) => {
  const inputId = useId();
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  // Kept in a ref so the unmount cleanup below always flushes the LATEST draft
  // without re-running (and cancelling its own timer) on every keystroke.
  const pendingRef = useRef<{ value: string; committed: string } | null>(null);

  // Sync from parent when not focused (e.g. config reload from another source)
  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const flush = (v: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    if (v !== value) onChange(emptyAsUndefined && v === '' ? (undefined as unknown as string) : v);
  };

  const handleChange = (v: string) => {
    setLocal(v);
    pendingRef.current = { value: v, committed: value };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(v), 600);
  };

  // A field unmounted mid-debounce (switching tabs/provider, collapsing a
  // section) would otherwise drop the last ≤600ms of typing on the floor.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (pending && pending.value !== pending.committed) {
        onChange(
          emptyAsUndefined && pending.value === '' ? (undefined as unknown as string) : pending.value,
        );
      }
    },
    // Mount-only: the cleanup reads the latest draft from `pendingRef`, so it
    // must NOT re-subscribe (and cancel its own timer) on every keystroke.
    [],
  );

  return (
    <div data-setting-id={id}>
      <label htmlFor={inputId} className="text-[10px] text-muted-foreground block mb-0.5">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        className={`w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-xs outline-none${mono ? ' font-mono' : ''}`}
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          flush(local);
        }}
        placeholder={placeholder}
      />
      {hint && <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">{hint}</span>}
    </div>
  );
};

/**
 * Secret-bearing sibling of {@link TextField}: same local-buffer + focus-guard +
 * debounce, plus a show/hide toggle. Three settings panels had grown their own
 * unbuffered `PasswordField` copies, so every keystroke of an API key was an IPC
 * round-trip that re-parsed the schema and rewrote the whole config file.
 */
export const PasswordField: FC<{
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}> = ({ id, label, value, onChange, placeholder, hint }) => {
  const inputId = useId();
  const [visible, setVisible] = useState(false);
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  const pendingRef = useRef<{ value: string; committed: string } | null>(null);

  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const flush = (v: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    if (v !== value) onChange(v);
  };

  const handleChange = (v: string) => {
    setLocal(v);
    pendingRef.current = { value: v, committed: value };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(v), 600);
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (pending && pending.value !== pending.committed) onChange(pending.value);
    },
    // Mount-only: the cleanup reads the latest draft from `pendingRef`, so it
    // must NOT re-subscribe (and cancel its own timer) on every keystroke.
    [],
  );

  return (
    <div data-setting-id={id}>
      <label htmlFor={inputId} className="text-[10px] text-muted-foreground block mb-0.5">
        {label}
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/80 pr-2">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs font-mono outline-none"
          value={local}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onBlur={() => {
            focusedRef.current = false;
            flush(local);
          }}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={visible ? 'Hide value' : 'Show value'}
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        >
          {visible ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
        </button>
      </div>
      {hint && <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">{hint}</span>}
    </div>
  );
};

/**
 * Multiline sibling of TextField with the SAME local-buffer + focus-guard +
 * debounce, so typing doesn't fight an async config round-trip (`updateConfig`
 * awaits IPC then replaces the whole config object — driving a raw
 * `value={…}` textarea directly resets the caret to the end on every keystroke).
 * Keeps a local value while focused; syncs from the parent only when NOT focused.
 */
export const TextArea: FC<{
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  className?: string;
}> = ({ id, label, value, onChange, placeholder, rows = 3, mono, className }) => {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);

  const flush = (v: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (v !== value) onChange(v);
  };

  const handleChange = (v: string) => {
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(v), 600);
  };

  const textarea = (
    <textarea
      className={
        className ??
        `w-full rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-[11px] outline-none${mono ? ' font-mono' : ''}`
      }
      value={local}
      rows={rows}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        flush(local);
      }}
      placeholder={placeholder}
    />
  );

  if (!label) return <div data-setting-id={id}>{textarea}</div>;
  return (
    <div data-setting-id={id}>
      <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>
      {textarea}
    </div>
  );
};

export const CollapsibleSection: FC<{ id?: string; title: string; defaultOpen?: boolean; children: ReactNode }> = ({
  id,
  title,
  defaultOpen = false,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const focus = useSettingsFocus();

  // Settings search can target a field INSIDE this section, but `{open && children}`
  // means that field isn't in the DOM while collapsed — so the panel's scroll/highlight
  // would land on this closed fieldset and stop. Open on a matching focus request so
  // the real target mounts and can be highlighted. Never auto-close: collapsing a
  // section the user opened by hand would be a surprise.
  useEffect(() => {
    if (focusRequestTargets(focus, id)) setOpen(true);
  }, [focus, id]);

  return (
    <fieldset data-setting-id={id} className="rounded-lg border p-3 space-y-3">
      <legend className="text-xs font-semibold px-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          {open ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
          {title}
        </button>
      </legend>
      {open && children}
    </fieldset>
  );
};
