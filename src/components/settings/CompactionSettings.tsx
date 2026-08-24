import type { FC } from 'react';
import { Toggle, NumberField, SliderField, headTailLabel, settingsSelectClass, type SettingsProps } from './shared';

const MIB = 1024 * 1024;

export const CompactionSettings: FC<SettingsProps & { hideTitle?: boolean }> = ({
  config,
  updateConfig,
  hideTitle,
}) => {
  const compaction = config.compaction as {
    tool: {
      enabled: boolean;
      useAI: boolean;
      triggerTokens: number;
      outputMaxTokens: number;
      truncateMinChars: number;
      truncateHeadRatio: number;
      truncateMinTailChars: number;
    };
    conversation: {
      enabled: boolean;
      mode: string;
      triggerPercent: number;
      ignoreRecentUserMessages: number;
      ignoreRecentAssistantMessages: number;
      outputMaxTokens: number;
      promptReserveTokens: number;
    };
    media: {
      enabled: boolean;
      strategy: 'downscale' | 'drop';
      minDimension: number;
      minQuality: number;
      reserveTokens: number;
      maxImageBytes: number;
      maxTotalBytes: number;
    };
  };

  return (
    <div className="space-y-6">
      {!hideTitle && <h3 className="text-sm font-semibold">Compaction</h3>}

      {/* Tool compaction */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Tool Result Compaction</legend>
        <Toggle
          label="Enabled"
          checked={compaction.tool.enabled}
          onChange={(v) => updateConfig('compaction.tool.enabled', v)}
        />
        <Toggle
          label="Use AI extraction"
          checked={compaction.tool.useAI}
          onChange={(v) => updateConfig('compaction.tool.useAI', v)}
        />
        <NumberField
          label="Trigger threshold (tokens)"
          value={compaction.tool.triggerTokens}
          onChange={(v) => updateConfig('compaction.tool.triggerTokens', v)}
        />
        <NumberField
          label="Max output tokens"
          value={compaction.tool.outputMaxTokens}
          onChange={(v) => updateConfig('compaction.tool.outputMaxTokens', v)}
        />
        <NumberField
          label="Truncate min chars"
          value={compaction.tool.truncateMinChars}
          onChange={(v) => updateConfig('compaction.tool.truncateMinChars', v)}
        />
        <NumberField
          label="Truncate min tail chars"
          value={compaction.tool.truncateMinTailChars}
          onChange={(v) => updateConfig('compaction.tool.truncateMinTailChars', v)}
        />
        <SliderField
          label={headTailLabel('Head ratio', compaction.tool.truncateHeadRatio)}
          value={compaction.tool.truncateHeadRatio}
          min={0.1}
          max={0.9}
          step={0.05}
          onChange={(v) => updateConfig('compaction.tool.truncateHeadRatio', v)}
        />
      </fieldset>

      {/* Conversation compaction */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Chat Compaction</legend>
        <Toggle
          label="Enabled"
          checked={compaction.conversation.enabled}
          onChange={(v) => updateConfig('compaction.conversation.enabled', v)}
        />
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground block">Mode</label>
          <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-xs text-foreground">
            Observational Memory
          </div>
          <p className="text-[10px] text-muted-foreground">
            {__BRAND_PRODUCT_NAME} compacts older chat context into observational memory so durable context stays
            available without bloating the active chat.
          </p>
        </div>
        <SliderField
          label={`Trigger at ${Math.round(compaction.conversation.triggerPercent * 100)}% context`}
          value={compaction.conversation.triggerPercent}
          min={0.5}
          max={0.95}
          step={0.05}
          onChange={(v) => updateConfig('compaction.conversation.triggerPercent', v)}
        />
        <NumberField
          label="Ignore recent user messages"
          value={compaction.conversation.ignoreRecentUserMessages}
          onChange={(v) => updateConfig('compaction.conversation.ignoreRecentUserMessages', v)}
        />
        <NumberField
          label="Ignore recent assistant messages"
          value={compaction.conversation.ignoreRecentAssistantMessages}
          onChange={(v) => updateConfig('compaction.conversation.ignoreRecentAssistantMessages', v)}
        />
        <NumberField
          label="Summary max tokens"
          value={compaction.conversation.outputMaxTokens}
          onChange={(v) => updateConfig('compaction.conversation.outputMaxTokens', v)}
        />
        <NumberField
          label="Prompt reserve tokens"
          value={compaction.conversation.promptReserveTokens}
          onChange={(v) => updateConfig('compaction.conversation.promptReserveTokens', v)}
        />
      </fieldset>

      {/* Media fitting */}
      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Media Fitting</legend>
        <p className="text-[10px] text-muted-foreground">
          Controls how tool-result images/files that would exceed the model&apos;s context window (or a fixed size cap)
          are handled before sending. Downscaling shrinks images toward the floor; oversized parts that still don&apos;t
          fit are dropped with a note.
        </p>
        <Toggle
          label="Enabled"
          checked={compaction.media.enabled}
          onChange={(v) => updateConfig('compaction.media.enabled', v)}
        />
        <div>
          <label className="text-[10px] text-muted-foreground block mb-0.5">Strategy</label>
          <select
            className={settingsSelectClass}
            value={compaction.media.strategy}
            onChange={(e) => updateConfig('compaction.media.strategy', e.target.value)}
          >
            <option value="downscale">Downscale (shrink toward floor, then drop if still too big)</option>
            <option value="drop">Drop (omit oversized media with a note)</option>
          </select>
        </div>
        <NumberField
          label="Min dimension (px, downscale floor)"
          value={compaction.media.minDimension}
          min={1}
          max={4096}
          onChange={(v) => updateConfig('compaction.media.minDimension', v)}
        />
        <NumberField
          label="Min quality (1–100, re-encode floor)"
          value={compaction.media.minQuality}
          min={1}
          max={100}
          onChange={(v) => updateConfig('compaction.media.minQuality', v)}
        />
        <NumberField
          label="Reserve tokens (context headroom)"
          value={compaction.media.reserveTokens}
          min={0}
          onChange={(v) => updateConfig('compaction.media.reserveTokens', v)}
        />
        <NumberField
          label="Max image size (MB per image/file)"
          value={Math.round(compaction.media.maxImageBytes / MIB)}
          min={1}
          max={64}
          onChange={(v) => {
            const bytes = Math.max(1, Math.round(v)) * MIB;
            // Keep the per-part cap ≤ the per-result total (schema rejects otherwise).
            const total = compaction.media.maxTotalBytes;
            updateConfig('compaction.media.maxImageBytes', Math.min(bytes, total));
          }}
        />
        <NumberField
          label="Max total media size (MB per tool result)"
          value={Math.round(compaction.media.maxTotalBytes / MIB)}
          min={1}
          max={128}
          onChange={(v) => {
            const bytes = Math.max(1, Math.round(v)) * MIB;
            void updateConfig('compaction.media.maxTotalBytes', bytes).then(() => {
              // A total below the per-image cap would fail schema validation; pull the
              // per-image cap down to match so both stay consistent.
              if (compaction.media.maxImageBytes > bytes) {
                updateConfig('compaction.media.maxImageBytes', bytes);
              }
            });
          }}
        />
      </fieldset>
    </div>
  );
};
