# Medaily Note (desktop)

Always-on-top quick capture into medaily learning notes. Talks HTTP only — **Sign in** opens the browser; no `DATABASE_URL`, no pasted token.

## Download (for others)

Installers are on [Releases](https://github.com/nhankhtn/medaily-note/releases/latest):

- Windows → `.msi` / `.exe`
- macOS → `.dmg` (pick Apple Silicon or Intel)
- Linux → `.deb` / `.AppImage`

Install, open the app, **Sign in with browser** once. Later versions are offered inside the app.

Unsigned macOS builds may need: right-click → Open, or  
`xattr -cr "/Applications/Medaily Note.app"` if Gatekeeper blocks it.

## Dev setup

The API lives in the medaily web app; this repo only talks to `https://medaily.id.vn`.

1. Linux deps if needed: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
2. Run:

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
# Needs TAURI_SIGNING_PRIVATE_KEY in the env: updater artifacts are signed on every build.
```

**New** / `Ctrl+N` opens another window; session is shared via localStorage.

## Releasing

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. `git tag v<version> && git push origin v<version>` — CI builds every OS and publishes the release with `latest.json`.

The app only installs updates signed by the updater key: `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in repo secrets, public half in `tauri.conf.json`.
Losing the private key means every installed copy must be reinstalled by hand.
