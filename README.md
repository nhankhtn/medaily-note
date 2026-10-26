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

4. In **Settings**, set the API base URL (e.g. `http://localhost:3000` or your deploy).
5. Click **Sign in** → finish in the browser (log in if needed → **Connect desktop app**) → the window picks up the session automatically.

**Sign out** clears the token on this device only.

Optional: **Paste token instead** still accepts a token from `pnpm exec tsx scripts/note-grant-token.ts`.

The parent Next app does not build this package.
