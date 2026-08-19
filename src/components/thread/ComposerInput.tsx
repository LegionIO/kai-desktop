import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FC } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { RichChatInput } from './RichChatInput';
import { useAttachments } from '@/providers/AttachmentContext';
import { useAppShotPasteHandler } from '@/hooks/useAppShots';
import { usePromptHistory, useMidTurnComposer } from '@/providers/RuntimeProvider';
import { isCompactCommand } from '@/lib/slash-commands';
import { useCompactingIds, markConversationCompacting, clearConversationCompacting } from '@/lib/compaction-ui-store';
import { cn } from '@/lib/utils';
import {
  filterAttachmentsBySize,
  skippedAttachmentsNotice,
  releaseAttachmentReservation,
} from '@/lib/attachment-limits';

export const ComposerInput: FC<{ placeholder?: string; className?: string; autoFocus?: boolean }> = ({
  placeholder = 'Discuss your thoughts and ideas...',
  className = '',
  autoFocus,
}) => {
  const composerRuntime = useComposerRuntime();
  const { attachments, addAttachments, getAttachmentCount, getResidentBytes } = useAttachments();
  const handleAppShotPaste = useAppShotPasteHandler();
  const { conversationId, prompts: promptHistory } = usePromptHistory();
  const { isRunning, sendMidTurn, getActiveConversationId, stashRejectedDraft, markForceNormalSend } =
    useMidTurnComposer();
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
  // Transient, conversation-scoped status for a mid-turn send that was BLOCKED by a
  // pre-send / UserPromptSubmit policy hook. Packaged users have no DevTools, so a
  // console.warn is invisible and Send appears to do nothing — surface the reason
  // inline (mirrors the compactStatus affordance). Auto-clears after a few seconds.
  const [sendBlockFor, setSendBlockFor] = useState<{ id: string | null; msg: string } | null>(null);
  const sendBlockStatus = sendBlockFor && sendBlockFor.id === conversationId ? sendBlockFor.msg : null;
  const sendBlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSendBlock = useCallback((id: string | null, reason?: string) => {
    if (sendBlockTimerRef.current) clearTimeout(sendBlockTimerRef.current);
    setSendBlockFor({
      id,
      msg: reason?.trim() ? `Message blocked: ${reason.trim()}` : 'Message blocked by a policy hook.',
    });
    sendBlockTimerRef.current = setTimeout(() => setSendBlockFor(null), 6000);
  }, []);
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

  // Clear the send-block timer on unmount so it can't fire into a gone component.
  useEffect(() => {
    return () => {
      if (sendBlockTimerRef.current) clearTimeout(sendBlockTimerRef.current);
    };
  }, []);

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
        if (status === 'injected') return; // spliced — nothing to restore
        // Compare against the LIVE active conversation at resolution time (not a
        // value captured at render). If the user switched chats during the async
        // gate, don't resubmit/restore into the wrong chat — STASH the text for the
        // ORIGINATING conversation so it resurfaces when the user returns there.
        const stillHere = originConversationId != null && originConversationId === getActiveConversationId();
        const current = composerRuntime.getState().text ?? '';
        // A LIVE attachment added during the async gate must also block the
        // resubmit: composerRuntime.send() → RuntimeProvider.onNew consumes ALL
        // current attachments, so a fallback resend of the OLD text would ship a
        // file the user added for a DIFFERENT (not-yet-sent) message. Read the
        // ref-backed live count, not the stale render-time `attachments`.
        const hasLiveAttachment = getAttachmentCount() > 0;
        if (!stillHere || current.trim().length > 0 || hasLiveAttachment) {
          // Switched away, a new draft is present, OR a new attachment was added —
          // don't clobber/mis-send; stash the text for the origin chat (dropped only
          // if there's no origin id, which can't happen for a real send).
          if (originConversationId) stashRejectedDraft(originConversationId, toSend);
          if (status === 'blocked') showSendBlock(originConversationId ?? null, reason);
          return;
        }
        if (status === 'fallback') {
          // Force a NORMAL superseding send — the run wasn't cooperatively
          // injectable (branch changed / not Mastra). Mark the origin conv so onNew
          // does NOT re-enter cooperative injection (re-running hooks / splicing onto
          // the stale transcript); then send.
          const target = originConversationId ?? getActiveConversationId();
          if (target) markForceNormalSend(target);
          composerRuntime.setText(toSend);
          composerRuntime.send();
          composerRuntime.setText('');
        } else if (status === 'blocked') {
          composerRuntime.setText(toSend);
          setText(toSend);
          showSendBlock(originConversationId ?? conversationId ?? null, reason);
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
    getActiveConversationId,
    stashRejectedDraft,
    showSendBlock,
    getAttachmentCount,
    markForceNormalSend,
    text,
  ]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (handleAppShotPaste(event)) return true;

      const items = Array.from(event.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith('image/'));

      if (imageItems.length === 0) return false;

      event.preventDefault();
      // Capture the conversation the paste targeted (R186): the attachment store is app-global, so a
      // chat switch before a reader resolves would otherwise attach the image to the wrong chat.
      const originConversationId = getActiveConversationId();
      // Gate the WHOLE pasted batch before reading (R186): a per-file-only check lets several images
      // materialize concurrently past the aggregate cap. filterAttachmentsBySize applies the per-file
      // AND running aggregate limits up front; addAttachments' return then backstops the shared store.
      const pastedFiles = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      const { accepted, skipped, reservedBytes } = filterAttachmentsBySize(pastedFiles, getResidentBytes());
      const skippedPastes = skipped.slice();
      // Release the in-flight reservation once every reader settles (R187), whether it committed or was
      // discarded on a chat switch — so the reserved bytes don't permanently shrink the global ceiling.
      let outstanding = accepted.length;
      const settleOne = () => {
        outstanding -= 1;
        if (outstanding <= 0) releaseAttachmentReservation(reservedBytes);
      };
      if (accepted.length === 0) releaseAttachmentReservation(reservedBytes);
      for (const file of accepted) {
        const reader = new FileReader();
        reader.onerror = () => settleOne();
        reader.onabort = () => settleOne();
        reader.onload = () => {
          settleOne();
          // Discard if the user switched conversations while this read was in flight (R186).
          if (getActiveConversationId() !== originConversationId) return;
          const { skipped: overCap } = addAttachments([
            {
              name: file.name || `pasted-image-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
              mime: file.type,
              isImage: true,
              size: file.size,
              dataUrl: reader.result as string,
            },
          ]);
          if (overCap.length > 0) {
            const notice = skippedAttachmentsNotice(overCap);
            if (notice) {
              if (sendBlockTimerRef.current) clearTimeout(sendBlockTimerRef.current);
              setSendBlockFor({ id: conversationId, msg: notice });
              sendBlockTimerRef.current = setTimeout(() => setSendBlockFor(null), 6000);
            }
          }
        };
        reader.readAsDataURL(file);
      }
      if (skippedPastes.length > 0) {
        const notice = skippedAttachmentsNotice(skippedPastes);
        if (notice) {
          if (sendBlockTimerRef.current) clearTimeout(sendBlockTimerRef.current);
          setSendBlockFor({ id: conversationId, msg: notice });
          sendBlockTimerRef.current = setTimeout(() => setSendBlockFor(null), 6000);
        }
      }

      const pastedText = event.clipboardData.getData('text/plain');
      if (pastedText) {
        document.execCommand('insertText', false, pastedText);
      }

      return true;
    },
    [addAttachments, handleAppShotPaste, conversationId, getActiveConversationId, getResidentBytes],
  );

  const isMultiline = text.includes('\n');

  return (
    <>
      {compactStatus && (
        <div className="px-3 pb-1 text-xs text-muted-foreground" role="status" aria-live="polite">
          {compactStatus}
        </div>
      )}
      {sendBlockStatus && (
        <div className="px-3 pb-1 text-xs text-amber-600 dark:text-amber-400" role="status" aria-live="polite">
          {sendBlockStatus}
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
