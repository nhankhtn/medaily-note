import { openUrl } from '@tauri-apps/plugin-opener'

const STORAGE_KEY = 'medaily.quicknote.config'

type Config = {
  apiBaseUrl: string
  noteGrantToken: string
}

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { apiBaseUrl: '', noteGrantToken: '' }
    const parsed = JSON.parse(raw) as Partial<Config>
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '',
      noteGrantToken: typeof parsed.noteGrantToken === 'string' ? parsed.noteGrantToken : '',
    }
  } catch {
    return { apiBaseUrl: '', noteGrantToken: '' }
  }
}

function saveConfig(config: Config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function setStatus(el: HTMLElement, message: string, kind: 'idle' | 'ok' | 'error') {
  el.textContent = message
  el.classList.toggle('is-ok', kind === 'ok')
  el.classList.toggle('is-error', kind === 'error')
}

function refreshAuthUi(
  authState: HTMLElement,
  signIn: HTMLButtonElement,
  signOut: HTMLButtonElement,
  tokenField: HTMLTextAreaElement,
) {
  const config = loadConfig()
  const signedIn = Boolean(config.noteGrantToken)
  authState.textContent = signedIn ? 'Signed in on this device' : 'Not signed in'
  signIn.hidden = signedIn
  signOut.hidden = !signedIn
  tokenField.value = config.noteGrantToken
}

async function pollForToken(
  base: string,
  deviceCode: string,
  intervalSec: number,
  expiresIn: number,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const response = await fetch(`${base}/api/external/device/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
      signal,
    })
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean
      status?: string
      noteGrantToken?: string
      error?: string
    } | null

    if (response.ok && payload?.status === 'ready' && payload.noteGrantToken) {
      return payload.noteGrantToken
    }
    if (response.ok && payload?.status === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalSec) * 1000))
      continue
    }

    const reason =
      payload?.error === 'expired'
        ? 'Sign-in link expired. Try again.'
        : payload?.error === 'consumed'
          ? 'That sign-in was already used. Try again.'
          : `Sign-in failed (${response.status}).`
    throw new Error(reason)
  }
  throw new Error('Timed out waiting for browser sign-in.')
}

window.addEventListener('DOMContentLoaded', () => {
  const settings = document.querySelector<HTMLElement>('#settings')!
  const toggle = document.querySelector<HTMLButtonElement>('#toggle-settings')!
  const apiBase = document.querySelector<HTMLInputElement>('#api-base')!
  const token = document.querySelector<HTMLTextAreaElement>('#token')!
  const saveSettings = document.querySelector<HTMLButtonElement>('#save-settings')!
  const saveToken = document.querySelector<HTMLButtonElement>('#save-token')!
  const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!
  const signOut = document.querySelector<HTMLButtonElement>('#sign-out')!
  const authState = document.querySelector<HTMLElement>('#auth-state')!
  const form = document.querySelector<HTMLFormElement>('#note-form')!
  const title = document.querySelector<HTMLInputElement>('#title')!
  const body = document.querySelector<HTMLTextAreaElement>('#body')!
  const saveNote = document.querySelector<HTMLButtonElement>('#save-note')!
  const status = document.querySelector<HTMLElement>('#status')!

  const config = loadConfig()
  apiBase.value = config.apiBaseUrl
  refreshAuthUi(authState, signIn, signOut, token)
  if (!config.apiBaseUrl || !config.noteGrantToken) {
    settings.hidden = false
    toggle.setAttribute('aria-expanded', 'true')
  }

  toggle.addEventListener('click', () => {
    const open = settings.hidden
    settings.hidden = !open
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  })

  saveSettings.addEventListener('click', () => {
    const current = loadConfig()
    saveConfig({
      apiBaseUrl: normalizeBase(apiBase.value),
      noteGrantToken: current.noteGrantToken,
    })
    apiBase.value = normalizeBase(apiBase.value)
    setStatus(status, 'API URL saved on this device.', 'ok')
  })

  saveToken.addEventListener('click', () => {
    const current = loadConfig()
    saveConfig({
      apiBaseUrl: normalizeBase(apiBase.value || current.apiBaseUrl),
      noteGrantToken: token.value.trim(),
    })
    apiBase.value = normalizeBase(apiBase.value || current.apiBaseUrl)
    refreshAuthUi(authState, signIn, signOut, token)
    setStatus(status, 'Token saved on this device.', 'ok')
  })

  signOut.addEventListener('click', () => {
    const current = loadConfig()
    saveConfig({ apiBaseUrl: current.apiBaseUrl, noteGrantToken: '' })
    refreshAuthUi(authState, signIn, signOut, token)
    setStatus(status, 'Signed out on this device.', 'ok')
  })

  let signInAbort: AbortController | null = null

  signIn.addEventListener('click', async () => {
    const base = normalizeBase(apiBase.value || loadConfig().apiBaseUrl)
    if (!base) {
      settings.hidden = false
      toggle.setAttribute('aria-expanded', 'true')
      setStatus(status, 'Set the API base URL first.', 'error')
      return
    }

    saveConfig({ apiBaseUrl: base, noteGrantToken: loadConfig().noteGrantToken })
    apiBase.value = base

    signInAbort?.abort()
    signInAbort = new AbortController()
    signIn.disabled = true
    setStatus(status, 'Opening browser to sign in…', 'idle')

    try {
      const start = await fetch(`${base}/api/external/device/auth/start`, {
        method: 'POST',
        signal: signInAbort.signal,
      })
      const started = (await start.json().catch(() => null)) as {
        ok?: boolean
        deviceCode?: string
        expiresIn?: number
        interval?: number
        verificationPath?: string
        error?: string
      } | null

      if (!start.ok || !started?.ok || !started.deviceCode || !started.verificationPath) {
        throw new Error(
          started?.error === 'rate_limited'
            ? 'Too many sign-in attempts. Wait and try again.'
            : 'Could not start sign-in.',
        )
      }

      const verifyUrl = `${base}${started.verificationPath}`
      await openUrl(verifyUrl)
      setStatus(status, 'Finish signing in in the browser…', 'idle')

      const noteGrantToken = await pollForToken(
        base,
        started.deviceCode,
        started.interval ?? 2,
        started.expiresIn ?? 600,
        signInAbort.signal,
      )

      saveConfig({ apiBaseUrl: base, noteGrantToken })
      refreshAuthUi(authState, signIn, signOut, token)
      setStatus(status, 'Signed in. You can save notes now.', 'ok')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus(
        status,
        error instanceof Error ? error.message : 'Sign-in failed.',
        'error',
      )
    } finally {
      signIn.disabled = false
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const current = loadConfig()
    const base = normalizeBase(current.apiBaseUrl || apiBase.value)
    const bearer = current.noteGrantToken.trim()
    const text = body.value.trim()

    if (!base || !bearer) {
      settings.hidden = false
      toggle.setAttribute('aria-expanded', 'true')
      setStatus(status, 'Sign in (or paste a token) before saving.', 'error')
      return
    }
    if (!text) {
      setStatus(status, 'Write something before saving.', 'error')
      return
    }

    saveNote.disabled = true
    setStatus(status, 'Saving…', 'idle')

    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(`${base}/api/external/grant/journal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bodyMd: text,
          title: title.value.trim() || undefined,
        }),
        signal: controller.signal,
      })

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; id?: string }
        | null

      if (!response.ok || !payload?.ok) {
        const reason =
          payload?.error === 'unauthorized'
            ? 'Session rejected — sign in again.'
            : payload?.error === 'rate_limited'
              ? 'Too many saves — try again later.'
              : payload?.error === 'invalid_input'
                ? 'Note rejected by the server (check length).'
                : `Save failed (${response.status}).`
        setStatus(status, reason, 'error')
        return
      }

      body.value = ''
      title.value = ''
      setStatus(status, 'Saved to journal.', 'ok')
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      setStatus(
        status,
        aborted ? 'Timed out reaching the API.' : 'Could not reach the API. Check the base URL.',
        'error',
      )
    } finally {
      window.clearTimeout(timer)
      saveNote.disabled = false
    }
  })
})
