/**
 * CreateAgentDialog — dialog for creating a new agent.
 */

import { type FC, useState } from 'react';
import { XIcon } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAgents } from '@/providers/AgentProvider';
import { RuntimePicker } from './RuntimePicker';
import type { AgentRuntime, AgentRole } from '../../../shared/agent-types';

const ROLE_OPTIONS: { id: AgentRole; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'engineer', label: 'Engineer' },
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'researcher', label: 'Researcher' },
];

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateAgentDialog: FC<CreateAgentDialogProps> = ({ open, onOpenChange }) => {
  const { createAgent } = useAgents();

  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('engineer');
  const [runtime, setRuntime] = useState<AgentRuntime>('claude-code');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createAgent({
        name: name.trim(),
        role,
        runtime,
        description: description.trim() || undefined,
      });
      if (!result) {
        setSubmitError('Failed to create agent. Please try again.');
        return;
      }
      // Reset form and close
      setName('');
      setRole('engineer');
      setRuntime('claude-code');
      setDescription('');
      setSubmitError(null);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) setSubmitError(null); onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border/70 bg-popover p-6 shadow-2xl animate-in fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:pointer-events-none">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="text-base font-semibold">
              New Agent
            </Dialog.Title>
            <Dialog.Close className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
              <XIcon size={16} />
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Atlas, Scout, Merlin..."
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {/* Role */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Role
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ROLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setRole(opt.id)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      role === opt.id
                        ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                        : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Runtime */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Runtime
              </label>
              <RuntimePicker value={runtime} onChange={setRuntime} />
            </div>

            {/* Description (optional) */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Description <span className="text-muted-foreground/50">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent specialize in?"
                rows={2}
                className="w-full resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex flex-col gap-2">
            {submitError && (
              <p className="text-xs text-destructive">{submitError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Dialog.Close className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
