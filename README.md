# Medaily Note (desktop)

Always-on-top quick capture into medaily’s journal. Talks HTTP only — **Sign in** in the app opens your browser; no `DATABASE_URL`, no pasted token required.

## Setup

1. Migrate the API database (once):

   ```bash
   cd ..
   pnpm db:migrate
   ```

2. Install Linux **dev** packages if needed: [Tauri prerequisites](https://tauri.app/start/prerequisites/) (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, …).

3. Run the desktop app:

   ```bash
   pnpm install
   source "$HOME/.cargo/env"   # if `cargo` is missing
   pnpm tauri dev
   ```

4. Click **Sign in with browser** → finish in the browser (log in if needed → **Connect**) → the note screen opens.

API is fixed to `https://medaily.id.vn`. **Sign out** clears the session on this device only.

### Fast open + many windows

`tauri dev` is slow (Vite + debug Rust). For daily use, build once:

```bash
pnpm tauri build
# binary e.g. src-tauri/target/release/desktop  (or the .deb in bundle/)
```

Then launch that binary (or pin it). After sign-in, **New** / `Ctrl+N` opens another note window; session is shared via localStorage.

The parent Next app does not build this package.
