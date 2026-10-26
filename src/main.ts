import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import { marked } from 'marked'
import appIcon from './assets/app-icon.png'

marked.setOptions({ gfm: true, breaks: true })

const STORAGE_KEY = 'medaily.quicknote.session'
const FONT_KEY = 'medaily.quicknote.fontSize'
const API_BASE = 'https://medaily.id.vn'
const FONT_MIN = 0.8
const FONT_MAX = 1.45
const FONT_STEP = 0.05
const FONT_DEFAULT = 0.95

type Session = {
  noteGrantToken: string
}

function loadSession(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { noteGrantToken: '' }
    const parsed = JSON.parse(raw) as Partial<Session>
    return {
      noteGrantToken: typeof parsed.noteGrantToken === 'string' ? parsed.noteGrantToken : '',
    }
  } catch {
    return { noteGrantToken: '' }
  }
}

function saveSession(session: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

function loadFontSize(): number {
  const raw = Number(localStorage.getItem(FONT_KEY))
  if (!Number.isFinite(raw)) return FONT_DEFAULT
  return Math.min(FONT_MAX, Math.max(FONT_MIN, raw))
}

function applyFontSize(rem: number) {
  const next = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, rem)) * 100) / 100
  document.documentElement.style.setProperty('--editor-size', `${next}rem`)
  localStorage.setItem(FONT_KEY, String(next))
  return next
}

function setStatus(el: HTMLElement, message: string, kind: 'idle' | 'ok' | 'error') {
  el.textContent = message
  el.classList.toggle('is-ok', kind === 'ok')
  el.classList.toggle('is-error', kind === 'error')
}

function showScreen(gate: HTMLElement, app: HTMLElement, signedIn: boolean) {
  gate.hidden = signedIn
  app.hidden = !signedIn
}

async function applyWindowIcon() {
  try {
    const response = await globalThis.fetch(appIcon)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await getCurrentWindow().setIcon(bytes)
  } catch (error) {
    console.error('window icon', error)
  }
}

function openNoteWindow() {
  const label = `note-${Date.now()}`
  const win = new WebviewWindow(label, {
    url: 'index.html',
    title: 'Quick note',
    width: 360,
    height: 420,
    minWidth: 280,
    minHeight: 320,
    resizable: true,
    alwaysOnTop: true,
    focus: true,
  })
  win.once('tauri://error', (event) => {
    console.error('new window failed', event)
  })
}

function networkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/load failed|failed to fetch|networkerror|error sending request/i.test(message)) {
    return 'Cannot reach medaily.id.vn — check the network.'
  }
  return message || 'Sign-in failed.'
}

function wrapSelection(
  area: HTMLTextAreaElement,
  before: string,
  after = before,
  placeholder = 'text',
) {
  const start = area.selectionStart
  const end = area.selectionEnd
  const selected = area.value.slice(start, end) || placeholder
  const next = area.value.slice(0, start) + before + selected + after + area.value.slice(end)
  area.value = next
  const selectFrom = start + before.length
  area.focus()
  area.setSelectionRange(selectFrom, selectFrom + selected.length)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}

function applyMarkdownAction(area: HTMLTextAreaElement, action: string) {
  switch (action) {
    case 'bold':
      wrapSelection(area, '**', '**', 'bold')
      break
    case 'italic':
      wrapSelection(area, '_', '_', 'italic')
      break
    case 'heading':
      wrapSelection(area, '## ', '', 'Heading')
      break
    case 'list': {
      const start = area.selectionStart
      const end = area.selectionEnd
      const block = area.value.slice(start, end) || 'item'
      const listed = block
        .split('\n')
        .map((line) => (line.startsWith('- ') ? line : `- ${line}`))
        .join('\n')
      area.value = area.value.slice(0, start) + listed + area.value.slice(end)
      area.focus()
      area.setSelectionRange(start, start + listed.length)
      area.dispatchEvent(new Event('input', { bubbles: true }))
      break
    }
    case 'code':
      wrapSelection(area, '`', '`', 'code')
      break
    case 'link':
      wrapSelection(area, '[', '](https://)', 'label')
      break
  }
}

async function renderPreview(source: string, target: HTMLElement) {
  target.innerHTML = await marked.parse(source || '_Nothing to preview yet._')
}

async function pollForToken(
  deviceCode: string,
  intervalSec: number,
  expiresIn: number,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const response = await fetch(`${API_BASE}/api/external/device/auth/token`, {
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
  void applyWindowIcon()

  const gate = document.querySelector<HTMLElement>('#gate')!
  const app = document.querySelector<HTMLElement>('#app')!
  const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!
  const signOut = document.querySelector<HTMLButtonElement>('#sign-out')!
  const newWindow = document.querySelector<HTMLButtonElement>('#new-window')!
  const newNote = document.querySelector<HTMLButtonElement>('#new-note')!
  const notesCombo = document.querySelector<HTMLElement>('#notes-combo')!
  const notesSearch = document.querySelector<HTMLInputElement>('#notes-search')!
  const notesMenu = document.querySelector<HTMLElement>('#notes-menu')!
  const notesResults = document.querySelector<HTMLElement>('#notes-results')!
  const notesNew = document.querySelector<HTMLButtonElement>('#notes-new')!
  const notesStatus = document.querySelector<HTMLElement>('#notes-status')!
  const editingLabel = document.querySelector<HTMLElement>('#editing-label')!
  const gateStatus = document.querySelector<HTMLElement>('#gate-status')!
  const form = document.querySelector<HTMLFormElement>('#note-form')!
  const title = document.querySelector<HTMLInputElement>('#title')!
  const body = document.querySelector<HTMLTextAreaElement>('#body')!
  const preview = document.querySelector<HTMLElement>('#preview')!
  const togglePreview = document.querySelector<HTMLButtonElement>('#toggle-preview')!
  const fontSmaller = document.querySelector<HTMLButtonElement>('#font-smaller')!
  const fontLarger = document.querySelector<HTMLButtonElement>('#font-larger')!
  const saveNote = document.querySelector<HTMLButtonElement>('#save-note')!
  const status = document.querySelector<HTMLElement>('#status')!

  type ListedNote = {
    id: string
    title: string
    bodyMd: string
    updatedAt: string
  }

  type NotesCursor = { updatedAt: string; id: string }

  let previewOn = false
  let editingId: string | null = null
  let listedNotes: ListedNote[] = []
  let nextCursor: NotesCursor | null = null
  let activeQuery = ''
  let loadingNotes = false
  let searchTimer: number | null = null
  let fontSize = applyFontSize(loadFontSize())

  function snippet(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  function noteLabel(entry: ListedNote): string {
    return entry.title?.trim() || snippet(entry.bodyMd) || 'Untitled'
  }

  function noteMeta(entry: ListedNote): string {
    const when = new Date(entry.updatedAt)
    const date = Number.isNaN(when.getTime())
      ? ''
      : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    const snip = snippet(entry.bodyMd)
    return [date, snip].filter(Boolean).join(' · ')
  }

  function setMenuOpen(open: boolean) {
    notesMenu.hidden = !open
    notesSearch.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  function renderNotesResults(reset: boolean) {
    if (reset) notesResults.replaceChildren()
    const start = reset ? 0 : notesResults.childElementCount
    for (const entry of listedNotes.slice(start)) {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.role = 'option'
      button.dataset.id = entry.id
      if (entry.id === editingId) button.classList.add('is-active')
      button.innerHTML = `<span class="note-title"></span><span class="note-meta"></span>`
      button.querySelector('.note-title')!.textContent = noteLabel(entry)
      button.querySelector('.note-meta')!.textContent = noteMeta(entry)
      button.addEventListener('click', () => {
        loadNoteIntoComposer(entry)
        setMenuOpen(false)
      })
      item.append(button)
      notesResults.append(item)
    }
  }

  function refreshEditingLabel() {
    if (!editingId) {
      editingLabel.hidden = true
      editingLabel.textContent = 'New note'
      notesSearch.placeholder = 'Search notes…'
      return
    }
    editingLabel.hidden = false
    editingLabel.textContent = 'Editing note'
    const current = listedNotes.find((note) => note.id === editingId)
    notesSearch.placeholder = current ? noteLabel(current) : 'Editing note…'
  }

  function clearComposer() {
    editingId = null
    title.value = ''
    body.value = ''
    notesSearch.value = ''
    refreshEditingLabel()
    void setPreviewMode(false)
  }

  function loadNoteIntoComposer(entry: ListedNote) {
    editingId = entry.id
    title.value = entry.title ?? ''
    body.value = entry.bodyMd
    notesSearch.value = ''
    refreshEditingLabel()
    void setPreviewMode(false)
    body.focus()
    setStatus(status, 'Editing existing note.', 'idle')
  }

  async function fetchNotesPage(opts: { reset: boolean; q: string }) {
    const bearer = loadSession().noteGrantToken.trim()
    if (!bearer) {
      showScreen(gate, app, false)
      return
    }
    if (loadingNotes) return
    if (!opts.reset && !nextCursor) return

    loadingNotes = true
    notesStatus.textContent = opts.reset ? 'Searching…' : 'Loading more…'

    try {
      const params = new URLSearchParams({ limit: '20' })
      if (opts.q) params.set('q', opts.q)
      if (!opts.reset && nextCursor) params.set('cursor', JSON.stringify(nextCursor))

      const response = await fetch(`${API_BASE}/api/external/grant/journal?${params}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        entries?: ListedNote[]
        nextCursor?: NotesCursor | null
        error?: string
      } | null

      if (!response.ok || !payload?.ok || !payload.entries) {
        if (payload?.error === 'unauthorized') {
          saveSession({ noteGrantToken: '' })
          showScreen(gate, app, false)
          setStatus(gateStatus, 'Session expired — sign in again.', 'error')
          return
        }
        notesStatus.textContent = 'Could not load notes.'
        return
      }

      if (opts.reset) listedNotes = payload.entries
      else {
        const seen = new Set(listedNotes.map((note) => note.id))
        for (const entry of payload.entries) {
          if (!seen.has(entry.id)) listedNotes.push(entry)
        }
      }
      nextCursor = payload.nextCursor ?? null
      activeQuery = opts.q
      renderNotesResults(opts.reset)
      refreshEditingLabel()

      if (listedNotes.length === 0) {
        notesStatus.textContent = opts.q ? 'No matches.' : 'No notes yet.'
      } else if (nextCursor) {
        notesStatus.textContent = 'Scroll for more…'
      } else {
        notesStatus.textContent = ''
      }
    } catch (error) {
      notesStatus.textContent = networkErrorMessage(error)
    } finally {
      loadingNotes = false
    }
  }

  function openNotesMenu(resetQuery = false) {
    setMenuOpen(true)
    if (resetQuery) {
      nextCursor = null
      void fetchNotesPage({ reset: true, q: notesSearch.value.trim() })
      return
    }
    if (listedNotes.length === 0 || notesSearch.value.trim() !== activeQuery) {
      nextCursor = null
      void fetchNotesPage({ reset: true, q: notesSearch.value.trim() })
    }
  }

  showScreen(gate, app, Boolean(loadSession().noteGrantToken))
  refreshEditingLabel()

  form.querySelectorAll<HTMLButtonElement>('[data-md]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.md
      if (!action || previewOn) return
      applyMarkdownAction(body, action)
    })
  })

  async function setPreviewMode(on: boolean) {
    previewOn = on
    body.hidden = on
    preview.hidden = !on
    body.required = !on
    togglePreview.classList.toggle('is-on', on)
    togglePreview.textContent = on ? 'Edit' : 'Preview'
    if (on) await renderPreview(body.value, preview)
  }

  togglePreview.addEventListener('click', () => {
    void setPreviewMode(!previewOn)
  })

  body.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || previewOn) return
    if (event.key.toLowerCase() === 'b') {
      event.preventDefault()
      applyMarkdownAction(body, 'bold')
    } else if (event.key.toLowerCase() === 'i') {
      event.preventDefault()
      applyMarkdownAction(body, 'italic')
    } else if (event.key.toLowerCase() === 'e') {
      event.preventDefault()
      void setPreviewMode(true)
    }
  })

  signOut.addEventListener('click', () => {
    saveSession({ noteGrantToken: '' })
    listedNotes = []
    nextCursor = null
    notesResults.replaceChildren()
    setMenuOpen(false)
    clearComposer()
    notesStatus.textContent = ''
    showScreen(gate, app, false)
    setStatus(gateStatus, '', 'idle')
    setStatus(status, '', 'idle')
  })

  notesSearch.addEventListener('focus', () => openNotesMenu())

  notesSearch.addEventListener('input', () => {
    setMenuOpen(true)
    if (searchTimer !== null) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      nextCursor = null
      void fetchNotesPage({ reset: true, q: notesSearch.value.trim() })
    }, 220)
  })

  notesMenu.addEventListener('scroll', () => {
    if (!nextCursor || loadingNotes) return
    const nearBottom =
      notesMenu.scrollTop + notesMenu.clientHeight >= notesMenu.scrollHeight - 48
    if (nearBottom) void fetchNotesPage({ reset: false, q: activeQuery })
  })

  notesNew.addEventListener('click', () => {
    clearComposer()
    setMenuOpen(false)
    setStatus(status, 'New note.', 'idle')
    body.focus()
  })

  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node)) return
    if (!notesCombo.contains(event.target)) setMenuOpen(false)
  })

  fontSmaller.addEventListener('click', () => {
    fontSize = applyFontSize(fontSize - FONT_STEP)
  })

  fontLarger.addEventListener('click', () => {
    fontSize = applyFontSize(fontSize + FONT_STEP)
  })

  newNote.addEventListener('click', () => {
    clearComposer()
    setMenuOpen(false)
    setStatus(status, 'New note.', 'idle')
    body.focus()
  })

  newWindow.addEventListener('click', () => openNoteWindow())

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      if (!app.hidden) openNoteWindow()
    }
  })

  let signInAbort: AbortController | null = null

  signIn.addEventListener('click', async () => {
    signInAbort?.abort()
    signInAbort = new AbortController()
    signIn.disabled = true
    setStatus(gateStatus, 'Opening browser…', 'idle')

    try {
      const start = await fetch(`${API_BASE}/api/external/device/auth/start`, {
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

      await openUrl(`${API_BASE}${started.verificationPath}`)
      setStatus(gateStatus, 'Finish in the browser…', 'idle')

      const noteGrantToken = await pollForToken(
        started.deviceCode,
        started.interval ?? 2,
        started.expiresIn ?? 600,
        signInAbort.signal,
      )

      saveSession({ noteGrantToken })
      showScreen(gate, app, true)
      setStatus(status, 'Signed in.', 'ok')
      body.focus()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus(gateStatus, networkErrorMessage(error), 'error')
    } finally {
      signIn.disabled = false
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const bearer = loadSession().noteGrantToken.trim()
    const text = body.value.trim()

    if (!bearer) {
      showScreen(gate, app, false)
      setStatus(gateStatus, 'Sign in before saving.', 'error')
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
      const response = await fetch(`${API_BASE}/api/external/grant/journal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: editingId ?? undefined,
          bodyMd: text,
          title: title.value.trim() || undefined,
        }),
        signal: controller.signal,
      })

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; id?: string }
        | null

      if (!response.ok || !payload?.ok) {
        if (payload?.error === 'unauthorized') {
          saveSession({ noteGrantToken: '' })
          showScreen(gate, app, false)
          setStatus(gateStatus, 'Session expired — sign in again.', 'error')
          return
        }
        const reason =
          payload?.error === 'rate_limited'
            ? 'Too many saves — try again later.'
            : payload?.error === 'invalid_input'
              ? 'Note rejected by the server (check length).'
              : payload?.error === 'not_found'
                ? 'That note is gone — start a new one.'
                : `Save failed (${response.status}).`
        setStatus(status, reason, 'error')
        return
      }

      editingId = payload.id ?? editingId
      refreshEditingLabel()
      if (previewOn) await renderPreview(body.value, preview)
      setStatus(status, 'Saved.', 'ok')
      nextCursor = null
      listedNotes = []
      refreshEditingLabel()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus(status, 'Timed out reaching the API.', 'error')
      } else {
        setStatus(status, networkErrorMessage(error), 'error')
      }
    } finally {
      window.clearTimeout(timer)
      saveNote.disabled = false
    }
  })
})
