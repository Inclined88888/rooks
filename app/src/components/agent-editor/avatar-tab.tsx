'use client';

/**
 * The Avatar tab of the agent editor: a picture, or the agent's initial.
 * A mascot or an emoji stored on the agent is left in the draft and is not
 * drawn. Uploading a picture is what changes the face.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { Crop, ImagePlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import type { AgentAvatarMode } from '@/components/agent-avatar';
import type { AgentLook } from '@/components/mascot/agent-look';
import { t } from '@/lib/i18n';

/**
 * The mode the tab would have opened on. The desk always shows the picture
 * controls; this stays so a saved mode is not rewritten just by opening the tab.
 */
export function shownAvatarMode(draft: { avatar: AgentAvatarMode | null; iconUrl: string; look: AgentLook | null; emoji: string }): AgentAvatarMode {
  if (draft.avatar) return draft.avatar;
  if (draft.iconUrl.trim()) return 'image';
  return 'image';
}

export type AvatarTabProps = {
  name: string;
  role: string;
  /** The tile's background behind a picture. */
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
  const letter = (props.name.trim().charAt(0) || '?').toUpperCase();
  const current = props.iconUrl.trim();
  return (
    <div className="rounded-[18px] bg-muted/40 p-3" data-avatar-tab="image">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div
          data-avatar-preview
          className="grid w-full shrink-0 place-items-center rounded-[18px] bg-background px-2.5 py-6 sm:w-[248px]"
        >
          <div className="flex flex-col items-center gap-3">
            <span
              className="grid size-[136px] place-items-center overflow-hidden rounded-[18px] text-[40px] font-semibold"
              style={{ background: props.background }}
            >
              {current
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={current} alt="" className="size-full object-cover" />
                : letter}
            </span>
            <span className="max-w-[220px] truncate text-[13px] font-semibold">{props.name || '?'}</span>
          </div>
        </div>
        <ImageSetting
          iconUrl={props.iconUrl}
          background={props.background}
          onIconUrl={(url) => {
            props.onIconUrl(url);
            if (url) props.onMode('image');
          }}
        />
      </div>
    </div>
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
      <p className="text-[12.5px] text-muted-foreground">{t('editPage.avatarTab.image.empty')}</p>
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
