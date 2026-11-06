import React from 'react'
import { useConnectionForm } from '@timon/ui'

/**
 * Own form for the `service@1` type, to add a connection and to edit one.
 * Without it, Settings › Secrets › Connections shows the generic form built
 * from `fields` and `secrets`.
 */
function ServiceForm() {
  const form = useConnectionForm()
  // A host that predates editing has no `mode`: that is a create form.
  const initial = form && form.mode === 'edit' ? form.initial : null
  const [url, setUrl] = React.useState(initial ? initial.url : '')
  const [apiKey, setApiKey] = React.useState('')
  const [error, setError] = React.useState('')
  if (!form) return null
  // The key never comes back from the daemon: on an edit, empty keeps it.
  const keyStored = !!initial && initial.secrets.includes('apiKey')
  const field = { display: 'block', width: '100%', marginTop: 4, padding: '4px 8px', borderRadius: 6 }
  const submit = async (event) => {
    event.preventDefault()
    // On an edit, `submit` sends only what differs from `initial`.
    const result = await form.submit({ label: initial ? initial.label : 'Example service', url, secrets: apiKey ? { apiKey } : {} })
    if (!result.ok) setError(result.error)
  }
  return React.createElement('form', { onSubmit: submit, style: { display: 'grid', gap: 8, padding: 12, borderRadius: 8 } },
    React.createElement('label', null, 'Service URL',
      React.createElement('input', { type: 'url', required: true, value: url, style: field, onChange: (e) => setUrl(e.target.value) })),
    React.createElement('label', null, 'API key',
      React.createElement('input', {
        type: 'password', required: !keyStored, value: apiKey, style: field,
        placeholder: keyStored ? 'Leave empty to keep the current key' : undefined,
        onChange: (e) => setApiKey(e.target.value),
      })),
    initial && form.approvalRequired
      ? React.createElement('p', null, 'A new address asks an administrator to approve it again.')
      : null,
    error ? React.createElement('p', { role: 'alert' }, error) : null,
    React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      React.createElement('button', { type: 'button', onClick: form.cancel }, 'Cancel'),
      React.createElement('button', { type: 'submit' }, 'Save')))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  // Keyed by the qualified type id: one form per connection type.
  return ctx.slots.register({ slot: 'settings.connection.form', key: `${ctx.id}:service@1` }, ServiceForm)
}
