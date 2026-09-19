const api = window.dshDesktop

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.pluginSource
  document.querySelector('#package-spec').placeholder = messages.pluginSourcePlaceholder
  document.querySelector('#source-help').textContent = messages.pluginSourceHelp
  document.querySelector('#source-build-notice').textContent = messages.pluginSourceBuildNotice
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins
  document.querySelector('#verified-heading').textContent = messages.verifiedReleaseHeading
  document.querySelector('#verified-label').textContent = messages.verifiedReleaseLabel
  document.querySelector('#verified-source').placeholder = messages.verifiedReleasePlaceholder
  document.querySelector('#verified-help').textContent = messages.verifiedReleaseHelp
  document.querySelector('#verified-ownership').textContent = messages.verifiedReleaseOwnership
  document.querySelector('#verified-interrupt').textContent = messages.verifiedReleaseInterrupt
  document.querySelector('#verified-submit').textContent = messages.verifiedReleaseInstall

  document.querySelector('#recovery-description').textContent = messages.recoveryDescription
  document.querySelector('#retry').textContent = messages.retry
  document.querySelector('#disable-all').textContent = messages.disableAll

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')
  const verifiedForm = document.querySelector('#verified-install-form')
  const verifiedInput = document.querySelector('#verified-source')
  const verifiedError = document.querySelector('#verified-error')
  let busy = false
  const dialog = document.querySelector('#package-dialog')
  const dialogInput = document.querySelector('#package-dialog-input')
  const dialogLabel = document.querySelector('#package-dialog-label')
  const dialogConfirm = document.querySelector('#package-dialog-confirm')
  document.querySelector('#package-dialog-cancel').textContent = messages.cancel
  let pendingPrompt
  let promptOpener

  function finishPrompt(value) {
    if (!pendingPrompt) return
    const settle = pendingPrompt
    pendingPrompt = undefined
    if (dialog.open) dialog.close()
    promptOpener?.focus()
    promptOpener = undefined
    settle(value)
  }

  function requestInput(label, initial, confirm, opener) {
    if (pendingPrompt) return Promise.resolve(null)
    return new Promise(resolve => {
      pendingPrompt = resolve
      promptOpener = opener
      dialogLabel.textContent = label
      dialogInput.value = initial
      dialogConfirm.textContent = confirm
      dialog.showModal()
      dialogInput.focus()
      dialogInput.select()
    })
  }

  document.querySelector('#package-dialog-form').addEventListener('submit', event => {
    event.preventDefault()
    finishPrompt(dialogInput.value.trim())
  })
  document.querySelector('#package-dialog-cancel').addEventListener('click', () => finishPrompt(null))
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    finishPrompt(null)
  })

  function setBusy(nextBusy, statusMessage = '') {
    busy = nextBusy
    for (const control of document.querySelectorAll('button, input, textarea')) control.disabled = nextBusy
    form.setAttribute('aria-busy', String(nextBusy))
    verifiedForm.setAttribute('aria-busy', String(nextBusy))
    status.textContent = statusMessage
  }

  function reinstallSpec(plugin) {
    const resolved = plugin.resolution?.resolved
    if (resolved?.startsWith('file:')) {
      try {
        const url = new URL(resolved)
        if (url.search !== '' || url.hash !== '' || /[\\\u0000-\u001f]/u.test(resolved) || /%2f|%5c/iu.test(url.pathname)) return ''
        const path = decodeURIComponent(url.pathname)
        if (/[\\\u0000-\u001f]/u.test(path)) return ''
        if (url.hostname !== '' && url.hostname !== 'localhost') {
          return `file:\\\\${url.hostname}${path.replaceAll('/', '\\')}`
        }
        return `file:${/^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path}`
      } catch {
        // A malformed stored file URL requires explicit re-entry, never a relative fallback.
        return ''
      }
    }
    const spec = plugin.source.spec
    return /^(?:file:|link:|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/iu.test(spec) ? '' : spec
  }

  function sourceDisclosure(plugin) {
    const source = plugin.source
    if (source?.type !== 'packageSpec' && source?.type !== 'githubRelease') return undefined
    const disclosure = document.createElement('span')
    disclosure.className = 'package-source'
    if (source.type === 'githubRelease') {
      disclosure.textContent = message('sourceSummary', { type: messages.sourceRelease, spec: `${source.owner}/${source.repo}@${source.tag}` })
      const guidance = document.createElement('span')
      guidance.className = 'package-source'
      guidance.textContent = messages.sourceReleaseUpdate
      disclosure.append(guidance)
      return disclosure
    }
    const resolution = plugin.resolution
    const type = resolution?.commit ? messages.sourceGithub
      : resolution?.resolved.startsWith('file:') ? messages.sourceLocal
        : resolution?.resolved.startsWith('https:') ? messages.sourceArchive : messages.sourcePackage
    disclosure.textContent = message('sourceSummary', { type, spec: source.spec })
    if (resolution) {
      const details = document.createElement('span')
      details.className = 'package-source'
      details.textContent = [
        ...(resolution.commit ? [message('sourceCommit', { commit: resolution.commit.slice(0, 12) })] : []),
        message('sourceDigest', { sha256: resolution.sha256.slice(0, 12) }),
      ].join(' · ')
      details.title = [message('sourceResolved', { resolved: resolution.resolved }),
        ...(resolution.commit ? [message('sourceCommit', { commit: resolution.commit })] : []),
        message('sourceDigest', { sha256: resolution.sha256 }),
      ].join('\n')
      disclosure.append(details)
    }
    return disclosure
  }

  async function render() {
    const backend = await api.backend.status()
    document.querySelector('#recovery').hidden = backend.phase !== 'error'
    document.querySelector('#startup-error').textContent = backend.phase === 'error' ? backend.message : ''
    const plugins = await api.plugins.list()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      identity.className = 'package-identity'
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.enabled ? plugin.version : `${plugin.version} · ${messages.disabled}`
      identity.append(document.createTextNode(plugin.name), version)
      const disclosure = sourceDisclosure(plugin)
      if (disclosure) identity.append(disclosure)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.plugins.remove(plugin.name),
        message('removing', { name: plugin.name }),
      ))
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = plugin.source?.type === 'packageSpec' ? messages.reinstallFromSource : messages.update
      update.addEventListener('click', async () => {
        if (plugin.source?.type === 'packageSpec') {
          const next = await requestInput(message('reinstallSourcePrompt', { name: plugin.name, spec: plugin.source.spec }), reinstallSpec(plugin), messages.reinstallFromSource, update)
          if (next === null || next === '') return
          void run(() => api.plugins.add(next), message('installing', { spec: next }))
          return
        }
        const next = await requestInput(message('targetVersion', { name: plugin.name }), plugin.version, messages.update, update)
        if (next === null || next === '' || next === plugin.version) return
        void run(() => api.plugins.update(plugin.name, next), message('updating', { name: plugin.name }))
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.textContent = plugin.enabled ? messages.disable : messages.enable
      toggle.addEventListener('click', () => void run(
        () => api.plugins.toggle(plugin.name, !plugin.enabled), messages.changingActivation,
      ))
      actions.append(toggle)
      if (plugin.source?.type !== 'githubRelease') actions.append(update)
      else {
        const verified = document.createElement('button')
        verified.type = 'button'
        verified.textContent = messages.verifiedReleaseInstall
        verified.addEventListener('click', () => {
          document.querySelector('#verified-install').open = true
          verifiedInput.focus()
        })
        actions.append(verified)
      }
      actions.append(remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function run(operation, statusMessage, success = messages.operationComplete) {
    if (busy) return
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    if (busy) return
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  verifiedInput.addEventListener('input', () => {
    verifiedError.hidden = true
    verifiedError.textContent = ''
    verifiedInput.removeAttribute('aria-invalid')
  })
  verifiedForm.addEventListener('submit', (event) => {
    event.preventDefault()
    if (busy) return
    status.textContent = ''
    let source
    try { source = JSON.parse(verifiedInput.value) }
    catch {
      verifiedError.textContent = messages.verifiedReleaseInvalidJson
      verifiedError.hidden = false
      verifiedInput.setAttribute('aria-invalid', 'true')
      verifiedInput.focus()
      return
    }
    if (source === null || typeof source !== 'object' || Array.isArray(source) || source.type !== 'githubRelease') {
      verifiedError.textContent = messages.verifiedReleaseWrongType
      verifiedError.hidden = false
      verifiedInput.setAttribute('aria-invalid', 'true')
      verifiedInput.focus()
      return
    }
    verifiedError.hidden = true
    verifiedError.textContent = ''
    verifiedInput.removeAttribute('aria-invalid')
    void run(async () => {
      const receipt = await api.plugins.install(source)
      if (receipt?.states?.verified !== true || receipt.states.activated !== true || receipt.states.rolledBack !== false) {
        throw new Error(messages.verifiedReleaseMissingReceipt)
      }
      verifiedInput.value = ''
    }, messages.verifiedReleasePreparing, messages.verifiedReleaseComplete)
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  document.querySelector('#retry').addEventListener('click', () => void run(() => api.backend.retry(), messages.retry))
  document.querySelector('#disable-all').addEventListener('click', () => void run(() => api.plugins.disableAll(), messages.changingActivation))
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))

  await load(messages.loadingPlugins, '')
}

void main()
