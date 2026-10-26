# Medaily Note (desktop)

Always-on-top quick capture into medaily learning notes. Talks HTTP only — **Sign in** opens the browser; no `DATABASE_URL`, no pasted token.

## Download (for others)

CI builds Windows / macOS / Linux and attaches installers to a [GitHub Release](https://github.com/nhankhtn/medaily/releases):

1. Repo → **Actions** → **Desktop release** → **Run workflow**,  
   or tag: `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`
2. When the job finishes, open the release **Medaily Note v…** and download:
   - Windows → `.msi` / `.exe`
   - macOS → `.dmg` (pick Apple Silicon or Intel)
   - Linux → `.deb` / `.AppImage`
3. Install, open the app, **Sign in with browser** once.

Unsigned macOS builds may need: right-click → Open, or  
`xattr -cr "/Applications/Medaily Note.app"` if Gatekeeper blocks it.

## Dev setup

1. Migrate the API database (once): `cd .. && pnpm db:migrate`
2. Linux deps if needed: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
3. Run:

   ```bash
   pnpm install
   source "$HOME/.cargo/env"   # if cargo is missing
   pnpm tauri dev
   ```

API is fixed to `https://medaily.id.vn`. **Sign out** clears the local token only.

### Local release binary

```bash
pnpm tauri build
# → src-tauri/target/release/bundle/  (.deb / AppImage / …)
```

**New** / `Ctrl+N` opens another window; session is shared via localStorage.

The parent Next app does not build this package.
