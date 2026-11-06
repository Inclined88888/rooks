'use client';

/**
 * The composer of the first-run conversation (`ChatComposerSlot variant="setup"`):
 * the field, the model, the voice, send — and nothing else. The person has just
 * installed Timon: no attachments, no slash menu, no terminal, no ceilings.
 */
import { ArrowUp, Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LlmMenu } from '@/components/chat/llm-menu';
import { BrandMark } from '@/components/brand-mark';
import { t } from '@/lib/i18n';
import type { ChatComposerValue } from './composer';

export function SetupComposer({ value }: { value: ChatComposerValue }) {
  const {
    agent, input, setInput, send, taRef, placeholder, thinking,
    recording, toggleDictation, dictationUnavailable,
    effBackend, effModel, applyLlm, currentMissionId, modelSwitching,
    pendingReasoningEffort, missionReasoningEffort, applyReasoningEffort,
  } = value;
  const effort = missionReasoningEffort ?? pendingReasoningEffort ?? null;
  const canSend = input.trim().length > 0 && !thinking;
  return (
    <div data-setup-composer className="mx-auto mb-4 flex w-full max-w-2xl flex-col gap-2 rounded-2xl bg-card p-3 shadow-elev-2">
      <textarea
        ref={taRef}
        value={input}
        rows={2}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) send();
          }
        }}
        className="max-h-40 min-h-[2.75rem] w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2">
        <LlmMenu
          backend={effBackend}
          model={effModel}
          reasoningEffort={effort}
          onReasoningEffort={applyReasoningEffort}
          onPick={applyLlm}
          target={{ project: agent.project, agent: agent.name }}
          missionId={currentMissionId}
          busy={modelSwitching}
          thinking={thinking}
        >
          <button
            type="button"
            disabled={modelSwitching}
            title={t('setupChat.model')}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            <BrandMark slug={effModel} className="size-3.5 shrink-0" />
            <span className="truncate">{effModel}</span>
          </button>
        </LlmMenu>
        <span className="flex-1" />
        {!dictationUnavailable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleDictation}
            aria-pressed={recording}
            aria-label={t(recording ? 'setupChat.voiceStop' : 'setupChat.voice')}
            title={t(recording ? 'setupChat.voiceStop' : 'setupChat.voice')}
            className={recording ? 'text-destructive' : 'text-muted-foreground'}
          >
            {recording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          disabled={!canSend}
          onClick={() => send()}
          aria-label={t('setupChat.send')}
          title={t('setupChat.send')}
          className="size-8 rounded-full"
        >
          <ArrowUp className="size-4" strokeWidth={2.5} />
        </Button>
      </div>
    </div>
  );
}
