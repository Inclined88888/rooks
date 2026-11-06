'use client';

import { UiDocumentCard } from '@/components/chat/ui-document-block';
import { CHAT_DOCUMENT_SLOT } from '@/lib/plugin-host/slots';
import { UI_DOCUMENTS_MODULE } from '@/lib/ui-documents';
import type { BundledClientPlugin } from './types';

/** Client half of `@timon/ui-documents`: the product's document card, as the
 *  default occupant of `chat.document`. Mounted with the modules, not with
 *  the cards, so a plugin's replacement keeps the slot however many
 *  conversations come and go; switching the module off takes the card away. */
export const uiDocumentsClient: BundledClientPlugin = {
  module: UI_DOCUMENTS_MODULE,
  apply(ctx) {
    ctx.register({ slot: CHAT_DOCUMENT_SLOT, fallback: true }, UiDocumentCard);
  },
};
