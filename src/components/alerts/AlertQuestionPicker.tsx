import { useCallback, useEffect, useState, type FC } from 'react';
import { CheckIcon } from 'lucide-react';
import type { AlertQuestion } from '@/lib/ipc-client';

const OTHER = '__other__';

/**
 * Multi-tab multiple-choice picker for answering a `question` Alert. Modeled on
 * the ask_user QuestionnaireView in ToolGroup, but self-contained and returning
 * a `{ questionText: choice }` map via onSubmit (the caller sends it to
 * `app.alerts.answer`). Each question is a tab; an "Other" free-text option is
 * always offered.
 */
export const AlertQuestionPicker: FC<{
  questions: AlertQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  submitting?: boolean;
}> = ({ questions, onSubmit, submitting }) => {
  const [activeTab, setActiveTab] = useState(0);
  // Single-select: answers[qIdx] holds the chosen option label, or OTHER.
  const [answers, setAnswers] = useState<Record<number, string>>({});
  // Multi-select: a Set of chosen option labels per question (NEVER contains OTHER;
  // free text is tracked separately so an option label containing "," or matching
  // the OTHER sentinel can't corrupt state or collide).
  const [multiSel, setMultiSel] = useState<Record<number, Set<string>>>({});
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  useEffect(() => {
    // Reset when the question set changes (e.g. switching between alerts).
    setActiveTab(0);
    setAnswers({});
    setMultiSel({});
    setOtherOn({});
    setOtherTexts({});
  }, [questions]);

  const handleSelect = useCallback(
    (qIdx: number, value: string) => {
      const multi = questions[qIdx]?.multiSelect === true;
      if (multi) {
        // Toggle this option in the Set; never auto-advance (the user may pick
        // several). Selecting a real option leaves any Other text intact.
        setMultiSel((prev) => {
          const cur = new Set(prev[qIdx] ?? []);
          if (cur.has(value)) cur.delete(value);
          else cur.add(value);
          return { ...prev, [qIdx]: cur };
        });
        return;
      }
      setAnswers((prev) => ({ ...prev, [qIdx]: value }));
      if (value !== OTHER) {
        setOtherTexts((prev) => {
          const next = { ...prev };
          delete next[qIdx];
          return next;
        });
        if (qIdx < questions.length - 1) setTimeout(() => setActiveTab(qIdx + 1), 160);
      }
    },
    [questions],
  );

  const handleOtherText = useCallback(
    (qIdx: number, text: string) => {
      setOtherTexts((prev) => ({ ...prev, [qIdx]: text }));
      const multi = questions[qIdx]?.multiSelect === true;
      if (multi) {
        setOtherOn((prev) => ({ ...prev, [qIdx]: text.trim().length > 0 }));
      } else {
        setAnswers((prev) => ({ ...prev, [qIdx]: OTHER }));
      }
    },
    [questions],
  );

  const handleSubmit = useCallback(() => {
    const result: Record<string, string> = {};
    questions.forEach((q, i) => {
      if (q.multiSelect) {
        const parts = [...(multiSel[i] ?? [])];
        if (otherOn[i] && otherTexts[i]?.trim()) parts.push(otherTexts[i].trim());
        if (parts.length) result[q.question] = parts.join(', ');
      } else {
        const raw = answers[i];
        if (raw === OTHER) result[q.question] = otherTexts[i] ?? '';
        else if (raw) result[q.question] = raw;
      }
    });
    onSubmit(result);
  }, [questions, answers, multiSel, otherOn, otherTexts, onSubmit]);

  if (questions.length === 0) return null;

  const active = questions[activeTab];
  const isSelected = (qIdx: number, value: string): boolean => {
    if (questions[qIdx]?.multiSelect) {
      return value === OTHER ? !!otherOn[qIdx] : !!multiSel[qIdx]?.has(value);
    }
    return answers[qIdx] === value;
  };
  const isQuestionAnswered = (i: number): boolean => {
    if (questions[i]?.multiSelect) {
      return (multiSel[i]?.size ?? 0) > 0 || (!!otherOn[i] && !!otherTexts[i]?.trim());
    }
    const raw = answers[i];
    if (!raw) return false;
    return raw === OTHER ? !!otherTexts[i]?.trim() : true;
  };
  const hasAllAnswers = questions.every((_, i) => isQuestionAnswered(i));

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {questions.length > 1 && (
        <div className="flex items-center border-b border-border/30">
          <div className="flex flex-1 min-w-0">
            {questions.map((q, i) => {
              const isAnswered = isQuestionAnswered(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveTab(i)}
                  className={`relative flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors ${
                    i === activeTab
                      ? 'text-primary border-b-2 border-primary -mb-px'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isAnswered && <CheckIcon className="h-2.5 w-2.5 text-emerald-500" />}
                  {q.header}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="p-3">
        <div className="mb-0.5 text-sm font-medium text-foreground">{active.question}</div>
        {active.multiSelect && <div className="mb-2 text-[11px] text-muted-foreground">Select all that apply</div>}
        <div className="flex flex-col gap-1.5">
          {active.options.map((opt) => {
            const selected = isSelected(activeTab, opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleSelect(activeTab, opt.label)}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/50 text-foreground/80 hover:border-border hover:bg-muted/50'
                }`}
              >
                {active.multiSelect && (
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border/60'
                    }`}
                  >
                    {selected && <CheckIcon className="h-3 w-3" />}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block font-medium">{opt.label}</span>
                  {opt.description && <span className="block text-xs text-muted-foreground">{opt.description}</span>}
                </span>
              </button>
            );
          })}
          <div
            className={`rounded-lg border px-3 py-2 transition-colors ${
              isSelected(activeTab, OTHER) ? 'border-primary bg-primary/10' : 'border-border/50'
            }`}
          >
            <input
              type="text"
              placeholder="Other…"
              value={otherTexts[activeTab] ?? ''}
              onChange={(e) => handleOtherText(activeTab, e.target.value)}
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={!hasAllAnswers || submitting}
            onClick={handleSubmit}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {submitting ? 'Sending…' : 'Submit answer'}
          </button>
        </div>
      </div>
    </div>
  );
};
