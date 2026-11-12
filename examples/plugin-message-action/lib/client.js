import React from 'react'
import { createTranslator, MessageActionButton, useChatMessage } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { copy: 'Copy the message reference', copied: 'Reference copied' },
  fr: { copy: 'Copier la référence du message', copied: 'Référence copiée' },
})

/**
 * A button under a chat bubble, beside Copy, Copy as Markdown, Reply and Read
 * aloud.
 *
 * `chat.message.action` is a LIST slot the chat declares while it is on
 * screen: registering adds a button, it replaces nothing. The component
 * receives no props: `useChatMessage()` gives the bubble it is painted under
 * (`role`, `eventId`, `missionId`, `markdown`, `html`), and returning `null`
 * keeps the button off the bubbles it has nothing to do with.
 * `MessageActionButton` draws the product's icon button with its tooltip.
 *
 * To arm a reply instead, call `useComposerReply().setReply({ eventId, role,
 * excerpt })`: the composer shows it and the next send carries it.
 */
function CopyReference() {
  const message = useChatMessage()
  const [copied, setCopied] = React.useState(false)
  if (!message || message.eventId === null || !message.missionId) return null
  const reference = `${message.missionId}#${message.eventId}`
  const onClick = () => {
    void navigator.clipboard?.writeText(reference).then(() => setCopied(true), () => {})
  }
  return React.createElement(MessageActionButton, { label: copied ? t('copied') : t('copy'), onClick },
    React.createElement('span', { 'aria-hidden': true, className: 'text-[11px] font-semibold', 'data-message-reference': reference }, '#'))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'chat.message.action' }, CopyReference)
}
