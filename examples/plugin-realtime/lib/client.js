import React from 'react'

/** @param {import('@timon-ai/sdk').ClientContext} clientCtx */
export function apply(clientCtx) {
  function Counter() {
    const [count, setCount] = React.useState(null)
    const [error, setError] = React.useState('')
    React.useEffect(() => {
      let active = true
      let timer
      let sequence = 0
      const reload = async () => {
        const request = ++sequence
        try {
          const response = await clientCtx.api('count', { cache: 'no-store' })
          if (!response.ok) throw new Error('Counter unavailable')
          const body = await response.json()
          if (active && request === sequence) { setCount(body.count); setError('') }
        } catch {
          if (active && request === sequence) setError('Counter unavailable')
        }
      }
      const unsubscribe = clientCtx.realtime.subscribe('changed', () => {
        clearTimeout(timer)
        timer = setTimeout(() => { void reload() }, 100)
      })
      void reload()
      return () => { active = false; clearTimeout(timer); unsubscribe() }
    }, [])
    const increment = async () => {
      try {
        const response = await clientCtx.api('increment', { method: 'POST' })
        if (!response.ok) throw new Error('Update failed')
      } catch { setError('Update failed') }
    }
    return React.createElement('div', null,
      React.createElement('p', null, count === null ? 'Loading…' : `Count: ${count}`),
      error && React.createElement('p', { role: 'alert' }, error),
      React.createElement('button', { type: 'button', onClick: increment }, 'Increment'),
    )
  }
  return clientCtx.slots.register({ slot: 'cockpit.widget' }, Counter)
}
