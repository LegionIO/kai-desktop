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
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  useEffect(() => {
    // Reset when the question set changes (e.g. switching between alerts).
    setActiveTab(0);
    setAnswers({});
    setOtherTexts({});
  }, [questions]);

  const handleSelect = useCallback(
    (qIdx: number, value: string) => {
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
    [questions.length],
  );

  const handleOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIdx]: text }));
    setAnswers((prev) => ({ ...prev, [qIdx]: OTHER }));
  }, []);

  const handleSubmit = useCallback(() => {
    const result: Record<string, string> = {};
    questions.forEach((q, i) => {
      const a = answers[i];
      if (a === OTHER) result[q.question] = otherTexts[i] ?? '';
      else if (a) result[q.question] = a;
    });
    onSubmit(result);
  }, [questions, answers, otherTexts, onSubmit]);

  if (questions.length === 0) return null;

  const active = questions[activeTab];
  const hasAllAnswers = questions.every((_, i) => {
    const a = answers[i];
    return a && (a !== OTHER || otherTexts[i]?.trim());
  });

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      {questions.length > 1 && (
        <div className="flex items-center border-b border-border/30">
          <div className="flex flex-1 min-w-0">
            {questions.map((q, i) => {
              const isAnswered = answers[i] && (answers[i] !== OTHER || otherTexts[i]?.trim());
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
        <div className="mb-2 text-sm font-medium text-foreground">{active.question}</div>
        <div className="flex flex-col gap-1.5">
          {active.options.map((opt) => {
            const selected = answers[activeTab] === opt.label;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleSelect(activeTab, opt.label)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/50 text-foreground/80 hover:border-border hover:bg-muted/50'
                }`}
              >
                <div className="font-medium">{opt.label}</div>
                {opt.description && <div className="text-xs text-muted-foreground">{opt.description}</div>}
              </button>
            );
          })}
          <div
            className={`rounded-lg border px-3 py-2 transition-colors ${
              answers[activeTab] === OTHER ? 'border-primary bg-primary/10' : 'border-border/50'
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
