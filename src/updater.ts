import { getCurrentWindow } from '@tauri-apps/api/window'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'

export async function offerUpdate(bar: HTMLElement, text: HTMLElement, install: HTMLButtonElement) {
  // Extra note windows would each ask again.
  if (getCurrentWindow().label !== 'main') return

  const update = await check().catch((error) => {
    console.error('offerUpdate.check', error)
    return null
  })
  if (!update) return

  text.textContent = `Version ${update.version} is ready.`
  bar.hidden = false

  install.addEventListener('click', async () => {
    install.disabled = true
    let total = 0
    let received = 0
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0
        if (event.event === 'Progress') {
          received += event.data.chunkLength
          text.textContent = total
            ? `Downloading… ${Math.round((received / total) * 100)}%`
            : 'Downloading…'
        }
        if (event.event === 'Finished') text.textContent = 'Installing…'
      })
      await relaunch()
    } catch (error) {
      console.error('offerUpdate.downloadAndInstall', error)
      text.textContent = 'Could not update. Try again later.'
      install.disabled = false
    }
  })
}
