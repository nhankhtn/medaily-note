import { getCurrentWindow } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import appIcon from './assets/app-icon.png'
import {
  ensureLocalNotesDb,
  isLocalNoteId,
  LOCAL_PAGE,
  localNotesPage,
  upsertLocalNote,
  type NotesCursor as LocalNotesCursor,
} from './local-notes'
import { applyMarkdownAction, createNoteEditor, isActionOn, markdownOf, setMarkdown } from './editor'
import { offerUpdate } from './updater'

const STORAGE_KEY = 'medaily.quicknote.session'
const SAVE_TO_KEY = 'medaily.quicknote.saveTo'
const FONT_KEY = 'medaily.quicknote.fontSize'
const API_BASE = 'https://medaily.id.vn'
const FONT_MIN = 0.8
const FONT_MAX = 1.45
const FONT_STEP = 0.05
const FONT_DEFAULT = 0.95
/** Idle time after the last keystroke before the note saves itself. */
const AUTOSAVE_DELAY_MS = 3_000

type Session = {
  noteGrantToken: string
  localMode: boolean
}

function loadSession(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { noteGrantToken: '', localMode: false }
    const parsed = JSON.parse(raw) as Partial<Session>
    return {
      noteGrantToken: typeof parsed.noteGrantToken === 'string' ? parsed.noteGrantToken : '',
      localMode: parsed.localMode === true,
    }
  } catch {
    return { noteGrantToken: '', localMode: false }
  }
}

function saveSession(session: Session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

function isCloudSession(session = loadSession()): boolean {
  return Boolean(session.noteGrantToken.trim())
}

function isUnlocked(session = loadSession()): boolean {
  return isCloudSession(session) || session.localMode
}

type SaveTo = 'cloud' | 'local'

function loadSaveTo(): SaveTo {
  return localStorage.getItem(SAVE_TO_KEY) === 'local' ? 'local' : 'cloud'
}

function persistSaveTo(value: SaveTo) {
  localStorage.setItem(SAVE_TO_KEY, value)
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

function showScreen(gate: HTMLElement, app: HTMLElement, unlocked: boolean) {
  gate.hidden = unlocked
  app.hidden = !unlocked
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
  void offerUpdate(
    document.querySelector<HTMLElement>('#update-bar')!,
    document.querySelector<HTMLElement>('#update-text')!,
    document.querySelector<HTMLButtonElement>('#update-install')!,
  )

  const gate = document.querySelector<HTMLElement>('#gate')!
  const app = document.querySelector<HTMLElement>('#app')!
  const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!
  const useLocal = document.querySelector<HTMLButtonElement>('#use-local')!
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
  const mdButtons = Array.from(form.querySelectorAll<HTMLButtonElement>('[data-md]'))
  const body = createNoteEditor(
    document.querySelector<HTMLElement>('#body')!,
    (editor) => {
      for (const button of mdButtons) {
        button.classList.toggle('is-on', isActionOn(editor, button.dataset.md ?? ''))
      }
    },
    () => scheduleAutosave(),
  )
  const fontSmaller = document.querySelector<HTMLButtonElement>('#font-smaller')!
  const fontLarger = document.querySelector<HTMLButtonElement>('#font-larger')!
  const saveTarget = document.querySelector<HTMLElement>('#save-target')!
  const saveNote = document.querySelector<HTMLButtonElement>('#save-note')!
  const status = document.querySelector<HTMLElement>('#status')!

  type ListedNote = {
    id: string
    title: string
    bodyMd: string
    updatedAt: string
    local?: boolean
  }

  let editingId: string | null = null
  let editingLocal = false
  let saveTo: SaveTo = loadSaveTo()
  let listedNotes: ListedNote[] = []
  let nextCursor: LocalNotesCursor | null = null
  // Which source nextCursor belongs to; cloud listing falls back to local when offline.
  let listingSource: 'cloud' | 'local' = 'local'
  let activeQuery = ''
  let loadingNotes = false
  let searchTimer: number | null = null
  let fontSize = applyFontSize(loadFontSize())

  // The note a save writes to. A new object per composer, so a save still in
  // flight after the user switched notes updates its own note, not the new one.
  type SaveTarget = { id: string | null; local: boolean }
  type SaveJob = {
    target: SaveTarget
    snapshot: string
    title: string
    text: string
    toLocal: boolean
    bearer: string
    auto: boolean
  }
  let target: SaveTarget = { id: null, local: false }
  let savedSnapshot = composerSnapshot()
  let autosaveTimer: number | null = null
  // Saves run one at a time, so a new note's first save hands its id to the next.
  let saveChain: Promise<void> = Promise.resolve()

  function composerSnapshot(): string {
    return `${title.value.trim()}\u0000${markdownOf(body).trim()}`
  }

  function cancelAutosave() {
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer)
    autosaveTimer = null
  }

  function scheduleAutosave() {
    cancelAutosave()
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null
      void queueSave(true)
    }, AUTOSAVE_DELAY_MS)
  }

  /** Composer now shows `editingId` as stored: nothing to autosave yet. */
  function resetSaveTarget() {
    cancelAutosave()
    target = { id: editingId, local: editingLocal }
    savedSnapshot = composerSnapshot()
  }

  function syncSaveTargetUi() {
    const cloud = isCloudSession()
    saveTarget.hidden = !cloud
    if (!cloud) {
      saveTo = 'local'
    } else if (editingLocal) {
      saveTo = 'local'
    }
    Array.from(saveTarget.querySelectorAll<HTMLButtonElement>('[data-save-to]')).forEach(
      (button) => {
        const value = button.dataset.saveTo as SaveTo
        button.classList.toggle('is-active', value === saveTo)
        button.disabled = editingLocal && value === 'cloud'
      },
    )
  }

  function setSaveTo(value: SaveTo) {
    if (editingLocal && value === 'cloud') return
    saveTo = value
    if (isCloudSession() && !editingLocal) persistSaveTo(value)
    syncSaveTargetUi()
  }

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
      const titleEl = button.querySelector('.note-title')!
      titleEl.textContent = noteLabel(entry)
      if (entry.local) {
        const badge = document.createElement('span')
        badge.className = 'note-local'
        badge.textContent = 'Local'
        titleEl.append(badge)
      }
      button.querySelector('.note-meta')!.textContent = noteMeta(entry)
      button.addEventListener('click', () => {
        void loadNoteIntoComposer(entry).then(() => setMenuOpen(false))
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
    void queueSave(true)
    editingId = null
    editingLocal = false
    title.value = ''
    setMarkdown(body, '')
    resetSaveTarget()
    notesSearch.value = ''
    if (isCloudSession()) saveTo = loadSaveTo()
    else saveTo = 'local'
    syncSaveTargetUi()
    refreshEditingLabel()
  }

  async function loadNoteIntoComposer(entry: ListedNote) {
    void queueSave(true)
    const local = Boolean(entry.local) || (await isLocalNoteId(entry.id))
    editingId = entry.id
    editingLocal = local
    title.value = entry.title ?? ''
    setMarkdown(body, entry.bodyMd)
    resetSaveTarget()
    notesSearch.value = ''
    setSaveTo(editingLocal ? 'local' : 'cloud')
    refreshEditingLabel()
    body.commands.focus()
    setStatus(
      status,
      editingLocal ? 'Editing local note.' : 'Editing existing note.',
      'idle',
    )
  }

  async function fetchNotesPage(opts: { reset: boolean; q: string }) {
    if (!isUnlocked()) {
      showScreen(gate, app, false)
      return
    }
    if (loadingNotes) return
    if (!opts.reset && !nextCursor) return

    loadingNotes = true
    notesStatus.textContent = opts.reset ? 'Searching…' : 'Loading more…'

    async function showLocalPage(offlineReason?: string) {
      const page = await localNotesPage({
        q: opts.q,
        cursor: opts.reset ? null : nextCursor,
        limit: LOCAL_PAGE,
      })
      const localEntries = page.entries.map((entry) => ({ ...entry, local: true }))
      if (opts.reset) listedNotes = localEntries
      else {
        const seen = new Set(listedNotes.map((note) => note.id))
        for (const entry of localEntries) {
          if (!seen.has(entry.id)) listedNotes.push(entry)
        }
      }
      nextCursor = page.nextCursor
      listingSource = 'local'
      activeQuery = opts.q
      renderNotesResults(opts.reset)
      refreshEditingLabel()
      if (listedNotes.length === 0) {
        notesStatus.textContent = offlineReason
          ? `${offlineReason} No local notes.`
          : opts.q
            ? 'No matches.'
            : 'No local notes yet.'
      } else if (nextCursor) {
        notesStatus.textContent = 'Scroll for more…'
      } else {
        notesStatus.textContent = offlineReason
          ? `${offlineReason} Showing notes on this device.`
          : 'Saved on this device'
      }
    }

    try {
      if (!isCloudSession() || (!opts.reset && listingSource === 'local')) {
        await showLocalPage()
        return
      }

      const bearer = loadSession().noteGrantToken.trim()
      const params = new URLSearchParams({ limit: '20' })
      if (opts.q) params.set('q', opts.q)
      if (!opts.reset && nextCursor) params.set('cursor', JSON.stringify(nextCursor))

      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), 8_000)
      let response: Response
      try {
        response = await fetch(`${API_BASE}/api/external/grant/journal?${params}`, {
          headers: { Authorization: `Bearer ${bearer}` },
          signal: controller.signal,
        })
      } catch (error) {
        const reason =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'Timed out reaching medaily.id.vn.'
            : networkErrorMessage(error)
        await showLocalPage(reason)
        return
      } finally {
        window.clearTimeout(timer)
      }
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        entries?: ListedNote[]
        nextCursor?: LocalNotesCursor | null
        error?: string
      } | null

      if (!response.ok || !payload?.ok || !payload.entries) {
        if (payload?.error === 'unauthorized') {
          saveSession({ noteGrantToken: '', localMode: false })
          syncSaveTargetUi()
          showScreen(gate, app, false)
          setStatus(gateStatus, 'Session expired — sign in again.', 'error')
          return
        }
        await showLocalPage('Could not load cloud notes.')
        return
      }

      const localHits = (
        await localNotesPage({ q: opts.q, limit: LOCAL_PAGE })
      ).entries.map((entry) => ({ ...entry, local: true as const }))

      if (opts.reset) {
        const cloudIds = new Set(payload.entries.map((entry) => entry.id))
        listedNotes = [
          ...localHits.filter((entry) => !cloudIds.has(entry.id)),
          ...payload.entries.map((entry) => ({ ...entry, local: false })),
        ]
      } else {
        const seen = new Set(listedNotes.map((note) => note.id))
        for (const entry of payload.entries) {
          if (!seen.has(entry.id)) listedNotes.push({ ...entry, local: false })
        }
      }
      nextCursor = payload.nextCursor ?? null
      listingSource = 'cloud'
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

  showScreen(gate, app, isUnlocked())
  if (!isCloudSession()) saveTo = 'local'
  syncSaveTargetUi()
  refreshEditingLabel()
  if (loadSession().localMode && !isCloudSession()) {
    signOut.title = 'Back to start'
    signOut.setAttribute('aria-label', 'Back to start')
  }
  void ensureLocalNotesDb().catch((error) => {
    console.error('local notes db', error)
  })

  saveTarget.querySelectorAll<HTMLButtonElement>('[data-save-to]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.saveTo
      if (value === 'local' || value === 'cloud') setSaveTo(value)
    })
  })

  for (const button of mdButtons) {
    // Keep the caret in the editor; a click would otherwise blur it first.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      const action = button.dataset.md
      if (action) applyMarkdownAction(body, action)
    })
  }

  signOut.addEventListener('click', () => {
    // Queue the pending edit while the session token is still there.
    void queueSave(true)
    saveSession({ noteGrantToken: '', localMode: false })
    listedNotes = []
    nextCursor = null
    notesResults.replaceChildren()
    setMenuOpen(false)
    clearComposer()
    syncSaveTargetUi()
    notesStatus.textContent = ''
    showScreen(gate, app, false)
    setStatus(gateStatus, '', 'idle')
    setStatus(status, '', 'idle')
  })

  useLocal.addEventListener('click', () => {
    saveSession({ noteGrantToken: '', localMode: true })
    signOut.title = 'Back to start'
    signOut.setAttribute('aria-label', 'Back to start')
    saveTo = 'local'
    editingLocal = false
    syncSaveTargetUi()
    showScreen(gate, app, true)
    setStatus(status, 'Saving on this device.', 'idle')
    body.commands.focus()
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
    body.commands.focus()
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
    body.commands.focus()
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

      saveSession({ noteGrantToken, localMode: false })
      signOut.title = 'Sign out'
      signOut.setAttribute('aria-label', 'Sign out')
      saveTo = loadSaveTo()
      editingLocal = false
      syncSaveTargetUi()
      showScreen(gate, app, true)
      setStatus(status, 'Signed in.', 'ok')
      body.commands.focus()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus(gateStatus, networkErrorMessage(error), 'error')
    } finally {
      signIn.disabled = false
    }
  })

  function fallbackTitle(titleText: string, text: string): string {
    return (
      titleText ||
      text
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find((line) => line.length > 0) ||
      'Untitled'
    ).slice(0, 300)
  }

  /** Records where the job landed; touches the composer only if it still shows that note. */
  function applySaved(job: SaveJob, id: string, local: boolean) {
    job.target.id = id
    job.target.local = local
    nextCursor = null
    listedNotes = []
    if (job.target !== target) return
    editingId = id
    editingLocal = local
    syncSaveTargetUi()
    refreshEditingLabel()
  }

  async function saveLocal(job: SaveJob) {
    const saved = await upsertLocalNote({
      id: job.target.local ? job.target.id : null,
      title: fallbackTitle(job.title, job.text),
      bodyMd: job.text,
    })
    applySaved(job, saved.id, true)
    setStatus(status, job.auto ? 'Auto-saved on this device.' : 'Saved on this device.', 'ok')
  }

  /** Returns false when the save did not land. */
  async function saveCloud(job: SaveJob): Promise<boolean> {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(`${API_BASE}/api/external/grant/journal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${job.bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: job.target.id && !job.target.local ? job.target.id : undefined,
          bodyMd: job.text,
          title: job.title || undefined,
        }),
        signal: controller.signal,
      })

      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; id?: string }
        | null

      if (!response.ok || !payload?.ok) {
        if (payload?.error === 'unauthorized') {
          saveSession({ noteGrantToken: '', localMode: false })
          syncSaveTargetUi()
          showScreen(gate, app, false)
          setStatus(gateStatus, 'Session expired — sign in again.', 'error')
          return false
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
        return false
      }

      applySaved(job, payload.id ?? job.target.id ?? '', false)
      setStatus(status, job.auto ? 'Auto-saved to medaily.' : 'Saved to medaily.', 'ok')
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus(status, 'Timed out reaching the API.', 'error')
      } else {
        setStatus(status, networkErrorMessage(error), 'error')
      }
      return false
    } finally {
      window.clearTimeout(timer)
    }
  }

  async function runSave(job: SaveJob) {
    saveNote.disabled = true
    if (!job.auto) setStatus(status, 'Saving…', 'idle')
    let ok = false
    try {
      if (job.toLocal) {
        await saveLocal(job)
        ok = true
      } else {
        ok = await saveCloud(job)
      }
    } catch (error) {
      console.error('runSave.saveLocal', error)
      setStatus(status, `Save failed: ${String(error)}`, 'error')
    } finally {
      saveNote.disabled = false
    }
    // Mark it dirty again so the next keystroke (or Save) retries.
    if (!ok && job.target === target && savedSnapshot === job.snapshot) savedSnapshot = ''
  }

  /**
   * Captures the composer now and queues it behind any save in flight.
   * Auto saves skip silently when nothing changed, the note is empty, or the app is locked.
   */
  function queueSave(auto: boolean): Promise<void> {
    cancelAutosave()
    const session = loadSession()
    const text = markdownOf(body).trim()
    const snapshot = composerSnapshot()

    if (!isUnlocked(session)) {
      if (!auto) {
        showScreen(gate, app, false)
        setStatus(gateStatus, 'Choose sign-in or continue on this device.', 'error')
      }
      return saveChain
    }
    if (!text) {
      if (!auto) setStatus(status, 'Write something before saving.', 'error')
      return saveChain
    }
    if (auto && snapshot === savedSnapshot) return saveChain

    const job: SaveJob = {
      target,
      snapshot,
      title: title.value.trim(),
      text,
      toLocal: !isCloudSession(session) || saveTo === 'local' || target.local,
      bearer: session.noteGrantToken.trim(),
      auto,
    }
    savedSnapshot = snapshot
    saveChain = saveChain.then(() => runSave(job))
    return saveChain
  }

  title.addEventListener('input', () => scheduleAutosave())

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void queueSave(false)
  })

  // Hidden or closing: save what is pending instead of waiting out the timer.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void queueSave(true)
  })

  void getCurrentWindow().onCloseRequested(async () => {
    await queueSave(true)
  })
})
