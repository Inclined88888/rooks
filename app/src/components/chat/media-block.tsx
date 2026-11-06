'use client';

/**
 * A media block in the chat thread (SUG-0008): an image or a video the agent
 * showed through `chat_show_media`, or an image codex generated.
 *
 * The thread paints the SLOT `chat.media`, not this card: the product occupies
 * it by default (`fallback`, client half of `@timon/missions`), and a plugin
 * that declares the slot takes its place. The slot is declared at boot
 * (`slots.ts`), not by the cards: a replacement registers when the plugins
 * load, before any card is on screen, and must outlive every card
 * (docs/PLUGINS.md). The occupant
 * reads the block from context, never from props, because slot entries are
 * registered once and rendered by every chat.
 *
 * Everything shown is typed data: the file is a name the daemon minted, served
 * from the Timon origin; the caption and the host are text nodes. No HTML.
 */

import React, { createContext, useContext, useState } from 'react';
import { Download, Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SlotSingle } from '@/lib/plugin-host/render';
import { CHAT_MEDIA_SLOT } from '@/lib/plugin-host/slots';
import { chatMediaDownloadUrl, chatMediaUrl, type ChatMediaBlock } from '@/lib/chat-media';
import { t } from '@/lib/i18n';

export { CHAT_MEDIA_SLOT };

type ChatMediaValue = { block: ChatMediaBlock; missionId: string };

const ChatMediaContext = createContext<ChatMediaValue | null>(null);

/** Readable by a plugin that takes the slot: the block and its mission. */
export function useChatMedia(): ChatMediaValue | null {
  return useContext(ChatMediaContext);
}

export function ChatMediaSlot({ block, missionId }: ChatMediaValue) {
  return (
    <ChatMediaContext.Provider value={{ block, missionId }}>
      <SlotSingle name={CHAT_MEDIA_SLOT} />
    </ChatMediaContext.Provider>
  );
}

function provenance(block: ChatMediaBlock): string {
  if (block.source === 'generated') return t('chatMedia.generated');
  if (block.source === 'url' && block.host) return t('chatMedia.fromHost', { host: block.host });
  return t(block.kind === 'video' ? 'chatMedia.video' : 'chatMedia.image');
}

/** The product's card: preview, enlarge, download. */
export function ChatMediaCard() {
  const value = useChatMedia();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!value) return null;
  const { block, missionId } = value;
  const src = chatMediaUrl(missionId, block.file);
  const label = block.caption || provenance(block);

  if (failed) {
    return (
      <div className="chat-media chat-media-failed" role="note">
        <span className="chat-media-caption">{label}</span>
        <span className="chat-media-note">{t('chatMedia.loadFailed')}</span>
      </div>
    );
  }

  return (
    <figure className="chat-media" data-media-kind={block.kind}>
      {block.kind === 'video' ? (
        <video
          className="chat-media-el"
          src={src}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
        />
      ) : (
        <button
          type="button"
          className="chat-media-frame"
          onClick={() => setOpen(true)}
          aria-label={t('chatMedia.enlarge')}
          title={t('chatMedia.enlarge')}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="chat-media-el"
            src={src}
            alt={label}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        </button>
      )}
      <figcaption className="chat-media-bar">
        <span className="chat-media-caption">{label}</span>
        {block.caption && <span className="chat-media-note">{provenance(block)}</span>}
        <span className="chat-media-actions">
          {block.kind === 'image' && (
            <button type="button" className="chat-media-action" onClick={() => setOpen(true)}>
              <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
              {t('chatMedia.enlarge')}
            </button>
          )}
          <a
            className="chat-media-action"
            href={chatMediaDownloadUrl(missionId, block.file)}
            download
            referrerPolicy="no-referrer"
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            {t('chatMedia.download')}
          </a>
        </span>
      </figcaption>
      {block.kind === 'image' && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="chat-media-lightbox max-w-[min(96vw,1400px)] p-3">
            <DialogTitle className="sr-only">{label}</DialogTitle>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="chat-media-full" src={src} alt={label} referrerPolicy="no-referrer" />
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}
