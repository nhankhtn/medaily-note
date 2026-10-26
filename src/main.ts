import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import { marked } from 'marked'
import appIcon from './assets/app-icon.png'

marked.setOptions({ gfm: true, breaks: true })

const STORAGE_KEY = 'medaily.quicknote.session'
const API_BASE = 'https://medaily.id.vn'

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
  const openNotes = document.querySelector<HTMLButtonElement>('#open-notes')!
  const closeNotes = document.querySelector<HTMLButtonElement>('#close-notes')!
  const newNote = document.querySelector<HTMLButtonElement>('#new-note')!
  const notesPanel = document.querySelector<HTMLElement>('#notes-panel')!
  const notesList = document.querySelector<HTMLElement>('#notes-list')!
  const notesStatus = document.querySelector<HTMLElement>('#notes-status')!
  const editingLabel = document.querySelector<HTMLElement>('#editing-label')!
  const gateStatus = document.querySelector<HTMLElement>('#gate-status')!
  const form = document.querySelector<HTMLFormElement>('#note-form')!
  const title = document.querySelector<HTMLInputElement>('#title')!
  const body = document.querySelector<HTMLTextAreaElement>('#body')!
  const preview = document.querySelector<HTMLElement>('#preview')!
  const togglePreview = document.querySelector<HTMLButtonElement>('#toggle-preview')!
  const saveNote = document.querySelector<HTMLButtonElement>('#save-note')!
  const status = document.querySelector<HTMLElement>('#status')!

  let previewOn = false
  let editingId: string | null = null

  type ListedNote = {
    id: string
    title: string
    bodyMd: string
    updatedAt: string
  }

  function snippet(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  function refreshEditingLabel() {
    if (!editingId) {
      editingLabel.hidden = true
      editingLabel.textContent = 'New note'
      return
    }
    editingLabel.hidden = false
    editingLabel.textContent = 'Editing note'
  }

  function clearComposer() {
    editingId = null
    title.value = ''
    body.value = ''
    refreshEditingLabel()
    void setPreviewMode(false)
  }

  function loadNoteIntoComposer(entry: ListedNote) {
    editingId = entry.id
    title.value = entry.title ?? ''
    body.value = entry.bodyMd
    refreshEditingLabel()
    notesPanel.hidden = true
    void setPreviewMode(false)
    body.focus()
    setStatus(status, 'Editing existing note.', 'idle')
  }

  async function loadNotesList() {
    const bearer = loadSession().noteGrantToken.trim()
    if (!bearer) {
      showScreen(gate, app, false)
      return
    }

    notesStatus.textContent = 'Loading…'
    notesList.replaceChildren()

    try {
      const response = await fetch(`${API_BASE}/api/external/grant/journal?limit=40`, {
        headers: { Authorization: `Bearer ${bearer}` },
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        entries?: ListedNote[]
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

      if (payload.entries.length === 0) {
        notesStatus.textContent = 'No notes yet.'
        return
      }

      notesStatus.textContent = `${payload.entries.length} recent`
      for (const entry of payload.entries) {
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        if (entry.id === editingId) button.classList.add('is-active')
        const when = new Date(entry.updatedAt)
        const dateLabel = Number.isNaN(when.getTime())
          ? ''
          : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        button.innerHTML = `<span class="note-date"></span><span class="note-title"></span><span class="note-snip"></span>`
        button.querySelector('.note-date')!.textContent = dateLabel
        button.querySelector('.note-title')!.textContent =
          entry.title?.trim() || snippet(entry.bodyMd) || 'Untitled'
        button.querySelector('.note-snip')!.textContent = snippet(entry.bodyMd)
        button.addEventListener('click', () => loadNoteIntoComposer(entry))
        item.append(button)
        notesList.append(item)
      }
    } catch (error) {
      notesStatus.textContent = networkErrorMessage(error)
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
    clearComposer()
    notesPanel.hidden = true
    showScreen(gate, app, false)
    setStatus(gateStatus, '', 'idle')
    setStatus(status, '', 'idle')
  })

  openNotes.addEventListener('click', () => {
    const open = notesPanel.hidden
    notesPanel.hidden = !open
    if (open) void loadNotesList()
  })

  closeNotes.addEventListener('click', () => {
    notesPanel.hidden = true
  })

  newNote.addEventListener('click', () => {
    clearComposer()
    notesPanel.hidden = true
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
      setStatus(status, editingId ? 'Saved.' : 'Saved to journal.', 'ok')
      if (!notesPanel.hidden) void loadNotesList()
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
