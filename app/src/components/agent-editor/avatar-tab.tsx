'use client';

/**
 * The Avatar tab of the agent editor (docs/AGENT-AVATAR.md): which head the
 * agent shows — an emoji, an uploaded picture framed by `LogoCropDialog`, or
 * its mascot — then the setting of that mode.
 *
 * Picking a mode never clears the other two settings: the emoji, the picture
 * and the look all stay in the draft and are all saved, so the person can come
 * back to one. The mascot is the shared configurator (`LookStylerHost`, slot
 * `agent.lookstyler`), the same one the onboarding opens.
 *
 * Laid out on two columns when the tab is wide: the head on the left, the
 * mode switch and the setting of the mode on the right, so that nothing has
 * to scroll. A narrow tab stacks them.
 */
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Crop, ImagePlus, Smile, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmojiPicker } from '@/components/emoji-picker';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import { AGENT_AVATAR_MODES, type AgentAvatarMode } from '@/components/agent-avatar';
import { defaultLookFor, type AgentLook } from '@/components/mascot/agent-look';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { LookStylerHost, useContainerLayout } from '@/components/mascot/look-styler/look-styler';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** One click for the faces people reach for; the full picker holds the rest. */
const QUICK_EMOJI = [
  '🤖', '🦊', '🐱', '🐶', '🦉', '🐙', '🦄', '🐝', '🐢', '🦁', '🐼', '🐸',
  '🧠', '⚡', '🚀', '🔧', '🛡️', '📚', '✍️', '🔍', '📈', '🎨', '🧪', '☕',
] as const;

/**
 * The mode the tab opens on: the one the agent picked, else the head the
 * historical order shows (picture, mascot, emoji), else the mascot. Read only,
 * never written: opening the tab must not change a face.
 */
export function shownAvatarMode(draft: { avatar: AgentAvatarMode | null; iconUrl: string; look: AgentLook | null; emoji: string }): AgentAvatarMode {
  if (draft.avatar) return draft.avatar;
  if (draft.iconUrl.trim()) return 'image';
  if (draft.look) return 'mascot';
  if (draft.emoji.trim()) return 'emoji';
  return 'mascot';
}

/** Whether the mode has the setting it shows; without it the agent keeps the historical order. */
export function avatarModeReady(mode: AgentAvatarMode, draft: { iconUrl: string; look: AgentLook | null; emoji: string }): boolean {
  if (mode === 'image') return draft.iconUrl.trim() !== '';
  if (mode === 'emoji') return draft.emoji.trim() !== '';
  // The configurator starts from the role's default: a mascot is always there to show.
  return true;
}

export type AvatarTabProps = {
  name: string;
  role: string;
  /** The tile's background behind an emoji or a picture. */
  background: string;
  mode: AgentAvatarMode;
  emoji: string;
  iconUrl: string;
  look: AgentLook | null;
  onMode: (mode: AgentAvatarMode) => void;
  onEmoji: (emoji: string) => void;
  onIconUrl: (url: string) => void;
  onLook: (look: AgentLook) => void;
};

export function AvatarTab(props: AvatarTabProps): ReactElement {
  const { mode, name, role } = props;
  const root = useRef<HTMLDivElement>(null);
  const layout = useContainerLayout(root);
  const columns = layout === 'columns';
  const switcher = <ModeSwitch {...props} />;
  return (
    <div ref={root} className="rounded-[18px] bg-muted/40 p-3" data-avatar-tab={mode} data-avatar-layout={layout}>
      {mode === 'mascot' ? (
        <div className="flex flex-col" data-avatar-setting="mascot">
          <LookStylerHost look={props.look ?? defaultLookFor(role)} onChange={props.onLook} name={name || '?'} role={role || null} header={switcher} />
        </div>
      ) : (
        <div className={cn('flex', columns ? 'flex-row gap-4' : 'flex-col gap-3')}>
          <div
            data-avatar-preview
            className={cn(
              'grid shrink-0 place-items-center rounded-[18px] bg-background px-2.5',
              columns ? 'w-[248px] self-start py-10' : 'py-6',
            )}
          >
            <div className="flex flex-col items-center gap-3">
              <ModePreview {...props} mode={mode} size={136} />
              <span className="max-w-[220px] truncate text-[13px] font-semibold">{name || '?'}</span>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {switcher}
            {mode === 'emoji' && <EmojiSetting emoji={props.emoji} onEmoji={props.onEmoji} />}
            {mode === 'image' && <ImageSetting iconUrl={props.iconUrl} background={props.background} onIconUrl={props.onIconUrl} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** The three heads as a compact switch, each with a small preview of what it would show. */
function ModeSwitch(props: AvatarTabProps): ReactElement {
  const { mode } = props;
  const ready = avatarModeReady(mode, props);
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label={t('editPage.avatarTab.title')} className="grid grid-cols-3 gap-1 rounded-xl bg-background/70 p-1">
        {AGENT_AVATAR_MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            data-avatar-mode={m}
            onClick={() => props.onMode(m)}
            className={cn(
              'flex h-10 items-center justify-center gap-2 rounded-lg px-2 text-[12.5px] font-semibold transition-colors',
              mode === m ? 'bg-muted ring-[1.5px] ring-inset ring-foreground/55' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <ModePreview {...props} mode={m} size={26} />
            {t(`editPage.avatarTab.mode.${m}`)}
          </button>
        ))}
      </div>
      <p className="px-0.5 text-[11.5px] text-muted-foreground">{t('editPage.avatarTab.intro')}</p>
      {!ready && (
        <p className="px-0.5 text-[11.5px] text-muted-foreground" data-avatar-missing>{t('editPage.avatarTab.missing')}</p>
      )}
    </div>
  );
}

function ModePreview({ mode, emoji, iconUrl, look, role, background, size }: AvatarTabProps & { mode: AgentAvatarMode; size: number }): ReactNode {
  if (mode === 'mascot') return <AgentMascotHost look={look ?? defaultLookFor(role)} size={size} fit shadow={false} />;
  const glyph = Math.round(size * 0.42);
  const icon = { width: Math.round(size * 0.4), height: Math.round(size * 0.4) };
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden"
      style={{ background, width: size, height: size, borderRadius: Math.round(size * 0.26), fontSize: glyph }}
    >
      {mode === 'image' && iconUrl.trim()
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={iconUrl} alt="" className="size-full object-cover" />
        : mode === 'image'
          ? <ImagePlus style={icon} className="text-[#0c0c0c]/60" aria-hidden />
          : (emoji.trim() || <Smile style={icon} className="text-[#0c0c0c]/60" aria-hidden />)}
    </span>
  );
}

function EmojiSetting({ emoji, onEmoji }: { emoji: string; onEmoji: (emoji: string) => void }): ReactElement {
  return (
    <section className="flex flex-col gap-3" data-avatar-setting="emoji">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t('editPage.avatarTab.emoji.label')}
          data-avatar-emoji-input
          value={emoji}
          onChange={(e) => onEmoji(e.target.value)}
          placeholder="🙂"
          className="w-24 text-center text-[20px]"
        />
        <EmojiPicker onPick={onEmoji} />
        {emoji.trim() && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onEmoji('')}>
            <X className="mr-1 size-3.5" aria-hidden />{t('editPage.avatarTab.emoji.clear')}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1.5" role="group" aria-label={t('editPage.avatarTab.emoji.quick')}>
        {QUICK_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            data-avatar-emoji={e}
            aria-pressed={emoji === e}
            onClick={() => onEmoji(e)}
            className={cn('grid h-10 place-items-center rounded-lg text-[20px] transition-colors hover:bg-muted', emoji === e && 'bg-muted ring-[1.5px] ring-inset ring-foreground/55')}
          >
            {e}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The upload that lived in the editor's header: picking a file opens the
 * framing dialog, the upload happens there with the same zoom, pan and
 * background a project logo gets (`/api/uploads/projects`, generic image
 * storage), and the returned URL becomes the agent's `icon_url`.
 */
function ImageSetting({ iconUrl, background, onIconUrl }: { iconUrl: string; background: string; onIconUrl: (url: string) => void }): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<LogoCropSource | null>(null);
  const pick = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('editPage.imageInvalid'));
      return;
    }
    setSource(file);
  }, []);
  const current = iconUrl.trim();
  return (
    <section className="flex flex-col items-start gap-2" data-avatar-setting="image">
      <div className="flex flex-col items-start gap-2">
        {!current && <p className="text-[11.5px] text-muted-foreground">{t('editPage.avatarTab.image.empty')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" data-avatar-upload disabled={source !== null} onClick={() => input.current?.click()}>
            <ImagePlus className="mr-1.5 size-3.5" aria-hidden />{current ? t('editPage.changeAvatar') : t('editPage.avatarTab.image.upload')}
          </Button>
          {current && (
            <Button type="button" variant="ghost" size="sm" disabled={source !== null} onClick={() => setSource(current)}>
              <Crop className="mr-1.5 size-3.5" aria-hidden />{t('logoCrop.adjust')}
            </Button>
          )}
          {current && (
            <Button type="button" variant="ghost" size="sm" data-avatar-remove onClick={() => onIconUrl('')}>
              <Trash2 className="mr-1.5 size-3.5" aria-hidden />{t('editPage.avatarTab.image.remove')}
            </Button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        data-avatar-file
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <LogoCropDialog
        source={source}
        endpoint="/api/uploads/projects"
        suggestedBackground={background}
        onCancel={() => setSource(null)}
        onUploaded={(url) => {
          setSource(null);
          onIconUrl(url);
          toast.success(t('editPage.avatarUploaded'));
        }}
      />
    </section>
  );
}
