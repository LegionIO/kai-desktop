import { useCallback, useEffect, useState, type FC } from 'react';

function acceleratorKeyFromEvent(e: KeyboardEvent): string | null {
  if (e.key === 'Dead' || e.key === 'Unidentified') return null;
  if (e.code.startsWith('Key')) return e.code.slice(3);
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  switch (e.key) {
    case ' ':
      return 'Space';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'Escape':
      return 'Esc';
    case 'Backspace':
      return 'Backspace';
    case 'Delete':
      return 'Delete';
    case 'Enter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    default:
      return e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
}

function modifiersFromEvent(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return mods;
}

export type HotkeyRecorderProps = {
  value: string;
  onChange: (accelerator: string) => void;
  /** Called when recording starts so the caller can release the live global shortcut. */
  onRecordingStart?: () => void;
  /** Called when recording ends (commit or cancel). */
  onRecordingEnd?: () => void;
  label?: string;
};

export const HotkeyRecorder: FC<HotkeyRecorderProps> = ({
  value,
  onChange,
  onRecordingStart,
  onRecordingEnd,
  label,
}) => {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);

  const startRecording = useCallback(() => {
    setHeld([]);
    setRecording(true);
    onRecordingStart?.();
  }, [onRecordingStart]);

  useEffect(() => {
    if (!recording) return;

    const suppress = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      suppress(e);
      const mods = modifiersFromEvent(e);
      setHeld(mods);
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key) && mods.length > 0) {
        const keyName = acceleratorKeyFromEvent(e);
        if (!keyName) return;
        onChange([...mods, keyName].join('+'));
        setHeld([]);
        setRecording(false);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      suppress(e);
      setHeld(modifiersFromEvent(e));
      if (e.key === 'Escape') {
        setHeld([]);
        setRecording(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('keypress', suppress, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('keypress', suppress, true);
      onRecordingEnd?.();
    };
  }, [recording, onChange, onRecordingEnd]);

  const display = recording ? (held.length > 0 ? `${held.join('+')}+…` : 'Press shortcut…') : value;

  return (
    <div>
      {label && <label className="text-[10px] text-muted-foreground block mb-0.5">{label}</label>}
      <button
        type="button"
        onClick={startRecording}
        className={`w-full rounded-xl border px-3 py-2 text-left text-xs font-mono outline-none transition-colors ${
          recording
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border/70 bg-card/80 hover:border-primary/50'
        }`}
      >
        {display}
      </button>
      <span className="text-[10px] text-muted-foreground/60 mt-0.5 block">
        {recording ? 'Hold modifiers then press a key. Esc to cancel.' : 'Click to record a new shortcut.'}
      </span>
    </div>
  );
};
