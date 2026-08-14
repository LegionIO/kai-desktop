import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FC } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { RichChatInput } from './RichChatInput';
import { useAttachments } from '@/providers/AttachmentContext';
import { useAppShotPasteHandler } from '@/hooks/useAppShots';
import { usePromptHistory, useMidTurnComposer } from '@/providers/RuntimeProvider';
import { isCompactCommand } from '@/lib/slash-commands';
import { useCompactingIds, markConversationCompacting, clearConversationCompacting } from '@/lib/compaction-ui-store';
import { cn } from '@/lib/utils';

export const ComposerInput: FC<{ placeholder?: string; className?: string; autoFocus?: boolean }> = ({
  placeholder = 'Discuss your thoughts and ideas...',
  className = '',
  autoFocus,
}) => {
  const composerRuntime = useComposerRuntime();
  const { attachments, addAttachments } = useAttachments();
  const handleAppShotPaste = useAppShotPasteHandler();
  const { conversationId, prompts: promptHistory } = usePromptHistory();
  const { isRunning, sendMidTurn } = useMidTurnComposer();
  const [text, setText] = useState(() => composerRuntime.getState().text ?? '');
  // /compact status is SCOPED to the conversation it belongs to. In-flight compactions
  // live in a MODULE-LEVEL store (compaction-ui-store) keyed by conversation id — NOT
  // component state — so they survive this composer's unmount/remount when the user
  // switches chats (the chat subtree is keyed by activeConversationId). A component-local
  // set would be lost on remount, letting the remounted composer accept a send the
  // backend rejects mid-compaction (spurious failed turn).
  const [compactStatusFor, setCompactStatusFor] = useState<{ id: string | null; msg: string } | null>(null);
  const compactingIds = useCompactingIds();
  const compactStatus = compactStatusFor && compactStatusFor.id === conversationId ? compactStatusFor.msg : null;
  const compactInFlight = conversationId ? compactingIds.has(conversationId) : false;
  const historyIndexRef = useRef(-1);
  const draftBeforeHistoryRef = useRef('');
  const historyConversationRef = useRef<string | null>(conversationId);

  const resetHistoryNavigation = useCallback((draft: string) => {
    historyIndexRef.current = -1;
    draftBeforeHistoryRef.current = draft;
  }, []);

  const setComposerText = useCallback(
    (nextText: string) => {
      setText(nextText);
      composerRuntime.setText(nextText);
    },
    [composerRuntime],
  );

  const navigatePromptHistory = useCallback(
    (direction: 'older' | 'newer'): boolean => {
      if (direction === 'older') {
        if (promptHistory.length === 0) return false;

        if (historyIndexRef.current === -1) {
          draftBeforeHistoryRef.current = text;
        }

        const nextIndex = Math.min(historyIndexRef.current + 1, promptHistory.length - 1);
        historyIndexRef.current = nextIndex;
        setComposerText(promptHistory[nextIndex] ?? '');
        return true;
      }

      if (historyIndexRef.current === -1) return false;

      const nextIndex = historyIndexRef.current - 1;
      if (nextIndex < 0) {
        historyIndexRef.current = -1;
        setComposerText(draftBeforeHistoryRef.current);
        return true;
      }

      historyIndexRef.current = nextIndex;
      setComposerText(promptHistory[nextIndex] ?? '');
      return true;
    },
    [promptHistory, setComposerText, text],
  );

  useEffect(() => {
    if (historyConversationRef.current === conversationId) return;
    historyConversationRef.current = conversationId;
    resetHistoryNavigation(text);
  }, [conversationId, resetHistoryNavigation, text]);

  useEffect(() => {
    const unsubscribe = composerRuntime.subscribe(() => {
      const runtimeText = composerRuntime.getState().text ?? '';
      setText((currentText) => {
        if (currentText === runtimeText) return currentText;
        if (runtimeText === '') resetHistoryNavigation('');
        return runtimeText;
      });
    });
    return unsubscribe;
  }, [composerRuntime, resetHistoryNavigation]);

  const handleChange = useCallback(
    (nextText: string) => {
      if (historyIndexRef.current !== -1) {
        resetHistoryNavigation(nextText);
      }
      setText(nextText);
      composerRuntime.setText(nextText);
    },
    [composerRuntime, resetHistoryNavigation],
  );

  const runCompact = useCallback(async () => {
    const cid = conversationId;
    if (!cid) {
      // Key to the current (null) conversationId so the render compare
      // (compactStatusFor.id === conversationId) matches and the message shows.
      setCompactStatusFor({ id: conversationId, msg: 'Open a chat first.' });
      return;
    }
    if (compactingIds.has(cid)) return; // already summarizing THIS chat
    markConversationCompacting(cid);
    setCompactStatusFor({ id: cid, msg: 'Compacting conversation…' });
    const setStatus = (msg: string) => setCompactStatusFor({ id: cid, msg });
    try {
      const res = await window.app?.conversations.compact(cid);
      if (res?.ok) {
        setStatus(`Compacted ${res.summarizedCount ?? 0} message(s) into a summary.`);
      } else {
        const msg =
          res?.error === 'nothing-to-compact'
            ? 'Nothing to compact yet.'
            : res?.error === 'compaction-disabled'
              ? 'Compaction is disabled in settings.'
              : res?.error === 'runtime-unsupported'
                ? 'This model/runtime manages its own context — /compact does not apply. Start a new chat if the context is full.'
                : res?.error === 'conversation-busy'
                  ? 'A turn is in progress — wait for it to finish.'
                  : `Compact failed: ${res?.error ?? 'unknown'}`;
        setStatus(msg);
      }
    } catch (err) {
      setStatus(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearConversationCompacting(cid);
    }
  }, [conversationId, compactingIds]);

  // Auto-clear the transient /compact status after a few seconds — but ONLY a TERMINAL
  // status (completed / error / "open a chat"). While a compaction is still in flight
  // for this conversation (compactingIds has it), keep the "Compacting…" status visible
  // so the composer doesn't look idle during a long (up to 285s) compaction that is
  // still blocking sends.
  useEffect(() => {
    if (!compactStatusFor) return;
    const stillCompactingThis = compactStatusFor.id !== null && compactingIds.has(compactStatusFor.id);
    if (stillCompactingThis) return;
    const t = setTimeout(() => setCompactStatusFor(null), 5000);
    return () => clearTimeout(t);
  }, [compactStatusFor, compactingIds]);

  const handleSubmit = useCallback(() => {
    if (!text.trim() && attachments.length === 0) return;
    // Don't start a normal turn while an on-demand /compact summary is in flight —
    // it would race the paid summarizer (which the backend then discards). A repeat
    // /compact is harmless (runCompact self-guards), so only block non-compact sends.
    if (compactInFlight && !(attachments.length === 0 && isCompactCommand(text))) {
      if (conversationId)
        setCompactStatusFor({ id: conversationId, msg: 'Compacting… wait for it to finish before sending.' });
      return;
    }
    // Slash command: `/compact` summarizes older messages instead of sending a
    // chat message. Matches the CLI's /compact. Only when it's the whole input
    // (optionally with trailing args, which are ignored) and there are no
    // attachments.
    if (attachments.length === 0 && isCompactCommand(text)) {
      setText('');
      composerRuntime.setText('');
      resetHistoryNavigation('');
      void runCompact();
      return;
    }
    // Compose-while-running: if a turn is live and this is a plain-text send (no
    // attachments), try to splice it into the running turn instead of blocking.
    // sendMidTurn resolves true when it was cooperatively injected (Mastra); on
    // false (CLI runtime / not running) we fall back to the normal send.
    if (isRunning && attachments.length === 0 && text.trim()) {
      const toSend = text;
      setText('');
      composerRuntime.setText('');
      resetHistoryNavigation('');
      void sendMidTurn(toSend).then(({ status, reason, originConversationId }) => {
        // The async policy/enforcement check may have let the user SWITCH chats.
        // This composer belongs to `conversationId`; if the send was routed to a
        // DIFFERENT conversation (or this composer is no longer that chat's), do
        // NOT resubmit/restore here — that would send into / clobber the wrong
        // chat. Drop the old text (it wasn't sent; the switched-away chat keeps
        // its own draft handling via the rejected-draft queue on the main side).
        if (originConversationId !== conversationId) return;
        // Only fall back / restore when the composer is still EMPTY — the user may
        // have typed a NEW draft during the async check; clobbering it is worse
        // than the (logged) loss of the old text.
        const current = composerRuntime.getState().text ?? '';
        if (status === 'fallback') {
          if (current.trim().length === 0) {
            composerRuntime.setText(toSend);
            composerRuntime.send();
            composerRuntime.setText('');
          }
        } else if (status === 'blocked') {
          if (current.trim().length === 0) {
            composerRuntime.setText(toSend);
            setText(toSend);
          }
          if (reason) console.warn(`[mid-turn-inject] blocked: ${reason}`);
        }
      });
      return;
    }
    composerRuntime.send();
    setText('');
    composerRuntime.setText('');
    resetHistoryNavigation('');
  }, [
    attachments.length,
    composerRuntime,
    compactInFlight,
    conversationId,
    isRunning,
    resetHistoryNavigation,
    runCompact,
    sendMidTurn,
    text,
  ]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (handleAppShotPaste(event)) return true;

      const items = Array.from(event.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith('image/'));

      if (imageItems.length === 0) return false;

      event.preventDefault();
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          addAttachments([
            {
              name: file.name || `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
              mime: file.type,
              isImage: true,
              size: file.size,
              dataUrl: reader.result as string,
            },
          ]);
        };
        reader.readAsDataURL(file);
      }

      const pastedText = event.clipboardData.getData('text/plain');
      if (pastedText) {
        document.execCommand('insertText', false, pastedText);
      }

      return true;
    },
    [addAttachments, handleAppShotPaste],
  );

  const isMultiline = text.includes('\n');

  return (
    <>
      {compactStatus && (
        <div className="px-3 pb-1 text-xs text-muted-foreground" role="status" aria-live="polite">
          {compactStatus}
        </div>
      )}
      <RichChatInput
        value={text}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onCancel={() => composerRuntime.cancel()}
        onArrowNavigate={(direction, rawOffset) => {
          if (direction === 'older') {
            const shouldNavigate = historyIndexRef.current !== -1 || !text.includes('\n') || rawOffset === 0;
            return shouldNavigate ? navigatePromptHistory('older') : false;
          }
          return navigatePromptHistory('newer');
        }}
        onPaste={handlePaste}
        placeholder={placeholder}
        className={cn(className, isMultiline && 'pb-3')}
        autoFocus={autoFocus}
        focusKey={conversationId}
      />
    </>
  );
};
