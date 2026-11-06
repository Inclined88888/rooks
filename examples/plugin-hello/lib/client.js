import React from 'react'

function HelloNav() {
  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: () => window.location.assign('/'),
      style: { display: 'block', width: '100%', padding: '8px 12px', textAlign: 'left' },
    },
    'Hello plugin',
  )
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  function HelloWidget() {
    const [message, setMessage] = React.useState('Chargement…')
    React.useEffect(() => {
      let active = true
      ctx.api('hello')
        .then((response) => response.json())
        .then((body) => { if (active) setMessage(String(body.greeting)) })
        .catch(() => { if (active) setMessage('Plugin indisponible') })
      return () => { active = false }
    }, [])
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
      React.createElement('strong', null, 'Plugin Hello'),
      React.createElement('p', null, message),
    )
  }

  const disposeNav = ctx.slots.register({ slot: 'nav.item' }, HelloNav)
  const disposeWidget = ctx.slots.register({ slot: 'cockpit.widget' }, HelloWidget)
  return () => {
    disposeWidget()
    disposeNav()
  }
}
