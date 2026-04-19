import { useState, type FC } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RoadmapPhase } from '../../../shared/workspace-types';
import { RoadmapFeatureCard } from './RoadmapFeatureCard';

interface RoadmapPhaseCardProps {
  phase: RoadmapPhase;
}

export const RoadmapPhaseCard: FC<RoadmapPhaseCardProps> = ({ phase }) => {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/80">
        {/* Header */}
        <Collapsible.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/10"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">{phase.name}</h3>
                <span className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-muted/30 px-1.5 text-[10px] font-medium text-muted-foreground">
                  {phase.features.length}
                </span>
              </div>
              {phase.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground/60">
                  {phase.description}
                </p>
              )}
            </div>
            <ChevronDownIcon
              className={cn(
                'ml-2 h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </button>
        </Collapsible.Trigger>

        {/* Content */}
        <Collapsible.Content>
          <div className="flex flex-col gap-2 border-t border-border/40 p-3">
            {phase.features.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground/40">
                No features in this phase
              </p>
            ) : (
              phase.features.map((feature) => (
                <RoadmapFeatureCard key={feature.id} feature={feature} />
              ))
            )}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
};
