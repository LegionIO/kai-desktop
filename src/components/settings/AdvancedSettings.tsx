import { type FC, useState, useEffect } from 'react';
import { InfoIcon, AlertTriangleIcon, TrendingUpIcon, CheckCircle2Icon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { Toggle, NumberField, settingsSelectClass, type SettingsProps } from './shared';

type StepUsageStats = {
  totalResponses: number;
  limitHitCount: number;
  limitHitRate: number;
  averageSteps: number;
  maxStepsUsed: number;
  recommendation: number | null;
};

export const AdvancedSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const advanced = config.advanced as {
    temperature: number;
    maxSteps: number;
    maxRetries: number;
    useResponsesApi: boolean;
  };

  const [stats, setStats] = useState<StepUsageStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);

  // Load usage statistics
  useEffect(() => {
    if (!showUsageStats) return;
    
    setLoadingStats(true);
    // This would call the backend API when implemented
    // For now, we'll simulate it
    setTimeout(() => {
      // Mock data - in production this would come from the backend
      const mockStats: StepUsageStats = {
        totalResponses: 0,
        limitHitCount: 0,
        limitHitRate: 0,
        averageSteps: 0,
        maxStepsUsed: 0,
        recommendation: null,
      };
      setStats(mockStats);
      setLoadingStats(false);
    }, 500);
  }, [showUsageStats]);

  const handleApplyRecommendation = () => {
    if (stats?.recommendation) {
      updateConfig('advanced.maxSteps', stats.recommendation);
    }
  };

  const shouldShowRecommendation = stats && stats.limitHitRate > 0.3 && stats.recommendation && stats.recommendation > advanced.maxSteps;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Advanced Settings</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Fine-tune model behavior, step limits, and retry logic.
        </p>
      </div>

      {/* Step Limit Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Task Execution</legend>
        
        <div className="space-y-3">
          <NumberField
            label="Max steps per task"
            value={advanced.maxSteps}
            onChange={(v) => updateConfig('advanced.maxSteps', Math.max(5, Math.min(100, v || 25)))}
            min={5}
            max={100}
          />
          
          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              Controls how many reasoning steps the AI can take before stopping. 
              Higher values allow more complex tasks but take longer. 
              Default: <strong>25 steps</strong>.
            </p>
          </div>

          {/* Usage Statistics Toggle */}
          <button
            type="button"
            onClick={() => setShowUsageStats(!showUsageStats)}
            className="flex items-center gap-2 text-xs text-primary hover:underline"
          >
            <TrendingUpIcon className="h-3.5 w-3.5" />
            {showUsageStats ? 'Hide' : 'Show'} your usage statistics
          </button>

          {/* Usage Statistics Display */}
          {showUsageStats && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-background/50 p-3">
              {loadingStats ? (
                <p className="text-xs text-muted-foreground">Loading statistics...</p>
              ) : stats ? (
                <>
                  {stats.totalResponses === 0 ? (
                    <div className="flex items-start gap-2 text-xs text-muted-foreground">
                      <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <p>
                        No usage data yet. Statistics will appear after you use Kai for a while.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="text-[10px] font-semibold text-foreground/90">
                        Your Step Usage
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3 text-[10px]">
                        <div>
                          <div className="text-muted-foreground">Total tasks</div>
                          <div className="text-sm font-semibold">{stats.totalResponses}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Times hit limit</div>
                          <div className="text-sm font-semibold">{stats.limitHitCount}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Average steps</div>
                          <div className="text-sm font-semibold">{stats.averageSteps.toFixed(1)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Max steps used</div>
                          <div className="text-sm font-semibold">{stats.maxStepsUsed}</div>
                        </div>
                      </div>

                      {/* Recommendation */}
                      {shouldShowRecommendation && (
                        <div className="mt-3 space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                          <div className="flex items-start gap-2">
                            <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                            <div className="flex-1 space-y-2">
                              <p className="text-[10px] text-amber-900 dark:text-amber-100">
                                <strong>Recommendation:</strong> You've hit the step limit in{' '}
                                {(stats.limitHitRate * 100).toFixed(0)}% of tasks. 
                                Consider increasing max steps to <strong>{stats.recommendation}</strong> for better results.
                              </p>
                              <button
                                type="button"
                                onClick={handleApplyRecommendation}
                                className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-amber-700 transition-colors"
                              >
                                <CheckCircle2Icon className="h-3 w-3" />
                                Apply Recommendation ({stats.recommendation} steps)
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {!shouldShowRecommendation && stats.totalResponses > 0 && (
                        <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-2 text-[10px] text-green-700 dark:text-green-300">
                          <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <p>
                            Your current limit of <strong>{advanced.maxSteps} steps</strong> seems adequate. 
                            You rarely hit the limit.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      </fieldset>

      {/* Temperature Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Response Style</legend>
        
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-muted-foreground mb-1 flex items-center justify-between">
              <span>Temperature</span>
              <span className="font-mono font-semibold text-foreground">{advanced.temperature.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={advanced.temperature}
              onChange={(e) => updateConfig('advanced.temperature', parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
              <span>Focused (0.0)</span>
              <span>Balanced (0.7)</span>
              <span>Creative (2.0)</span>
            </div>
          </div>
          
          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              Lower values make responses more focused and deterministic. 
              Higher values increase creativity and variation. 
              Default: <strong>0.4</strong> (balanced).
            </p>
          </div>
        </div>
      </fieldset>

      {/* Retry Logic Section */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">Error Handling</legend>
        
        <div className="space-y-3">
          <NumberField
            label="Max retries on transient errors"
            value={advanced.maxRetries}
            onChange={(v) => updateConfig('advanced.maxRetries', Math.max(0, Math.min(10, v || 4)))}
            min={0}
            max={10}
          />
          
          <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
            <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <p>
              How many times to retry when encountering network errors or rate limits. 
              Default: <strong>4 retries</strong>.
            </p>
          </div>
        </div>
      </fieldset>

      {/* API Options */}
      <fieldset className="rounded-lg border p-4 space-y-4">
        <legend className="text-xs font-semibold px-1">API Options</legend>
        
        <Toggle
          label="Use Responses API (where available)"
          checked={advanced.useResponsesApi}
          onChange={(v) => updateConfig('advanced.useResponsesApi', v)}
        />
        
        <div className="flex items-start gap-2 rounded-md bg-muted/40 p-3 text-[10px] leading-relaxed text-muted-foreground">
          <InfoIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            Enable the OpenAI Responses API format for models that support it. 
            This provides better streaming and error handling.
          </p>
        </div>
      </fieldset>

      {/* Warning */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-900 dark:text-amber-100">
        <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <p>
          <strong>Note:</strong> These are global defaults. Individual profiles and conversations can override these values.
        </p>
      </div>
    </div>
  );
};
