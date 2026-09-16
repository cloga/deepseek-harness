/** External lazy-CJS fixture consumed by the shipped client module loader. */
window.__ModuleLoader__.load({
  id: 'desktop-runtime-smoke-plugin',
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots'],
      apply(ctx) {
        function NeutralAuthorization() {
          const [result, setResult] = React.useState(null)
          const [error, setError] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const call = async (action) => {
            setBusy(true)
            try {
              const transport = await fetch(`/api/desktop-neutral/${action}`, { method: 'POST' })
              if (!transport.ok) throw new Error(`Neutral authorization HTTP ${transport.status}`)
              const response = await transport.json()
              if (!response.ok) throw new Error(response.error.message)
              setResult(response.value)
            } catch (failure) {
              setError(String(failure))
            } finally {
              setBusy(false)
            }
          }
          React.useEffect(() => { void call('status') }, [])
          return React.createElement('section', { 'aria-label': 'Neutral fixture authorization' },
            React.createElement('p', null, 'Offline authorization fixture; no external account'),
            React.createElement('button', {
              type: 'button',
              disabled: busy || result === null || result.status === 'authorized',
              onClick: () => { void call('authorize') },
            }, 'Authorize neutral fixture'),
            React.createElement('output', {
              'data-neutral-auth-status': result?.status ?? 'loading',
              'data-neutral-auth-receipt': result?.receipt ?? '',
            }, result?.status === 'authorized' ? 'Neutral authorization succeeded' : 'Neutral authorization not granted'),
            error === null ? null : React.createElement('p', { role: 'alert' }, error),
          )
        }
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
          { name: 'settings.models.provider-card', key: 'desktop-neutral-provider' },
          NeutralAuthorization,
        ))
      },
    }
  },
})
