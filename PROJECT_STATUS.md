# PROJECT_STATUS.md

Last updated: 2026-06-20. This document exists so a new conversation with no prior context can pick up exactly where we left off.

---

## What This App Is

**ReadAloud** — a personal audiobook/read-aloud player. One user, no accounts, no auth beyond Google Drive for sync.

- Search for any book → get the best available version automatically
- LibriVox books: streamed as real MP3 audio narrated by volunteers
- Everything else: read aloud via browser Web Speech API with word-by-word highlighting
- Library persists to Google Drive (`readaloud_library.json`) so it syncs across devices
- Deployed on Render (free tier, Node.js web service)
- GitHub: `https://github.com/razr37/readaloud`

---

## Architecture

### Files

```
src/server.js              — Express API + all business logic (one file)
src/driveSync.js           — Google Drive read/write for library persistence (do not modify)
src/__tests__/server.test.js — Jest + supertest, 22 tests, all passing
public/index.html          — Entire frontend: CSS + HTML + JS in one file, no build step
render.yaml                — Render.com deploy config
CLAUDE.md                  — Codebase guide for Claude Code
```

### Server endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=` | LibriVox dual search (title + author in parallel, deduplicated) |
| `GET /api/chapters/:id` | LibriVox chapter list via `?extended=1` (audiotracks endpoint is broken/404) |
| `GET /api/search-text?q=` | Stage 2: parallel Gutenberg + Standard Ebooks + Archive.org |
| `POST /api/fetch-text` | Fetch URL as arraybuffer, extract text (TXT/EPUB/PDF), strip Gutenberg markers |
| `POST /api/extract-upload` | multer file upload, same extraction pipeline, returns `suggestedTitle` |
| `GET /api/library` | Load library from Google Drive |
| `POST /api/library` | Save library to Google Drive |
| `GET /ping` | Health check + self-ping target (prevents Render free tier spin-down) |

### 3-stage cascade search (frontend, `doSearch()` in index.html)

1. **Stage 1 — LibriVox**: calls `/api/search`. If results → show tagged "🎧 Narrated". Done.
2. **Stage 2 — Text sources**: only runs if Stage 1 returns empty. Calls `/api/search-text` (parallel: Gutenberg via gutendex.com, Standard Ebooks via cheerio scrape, Archive.org via advancedsearch API). Shows tagged "📄 Text · read aloud". Adds attribution note.
3. **Stage 3 — Upload**: only shown if Stage 2 also empty. Drop zone appears inline in the modal. Calls `/api/extract-upload`. No Add button — upload auto-adds on file select.

### Dual player modes (frontend, toggled by `book.source`)

- `source === 'librivox'` (or missing): `#audioView` — chapter list + HTML5 `<audio>` element + seek bar
- `source === 'scraped'` or `'upload'`: `#ttsView` — word-highlighted text (`<span class="word">` per word) + Web Speech API (`SpeechSynthesisUtterance`)

### Book data model

```js
{
  id: string,                    // 'b' + Date.now()
  source: 'librivox' | 'scraped' | 'upload',
  title: string,
  author: string,
  // LibriVox only:
  chapters: [{ title, url, durationSecs }],
  totaltime: string,
  // Scraped/upload only:
  text: string,                  // full extracted text
  wordCount: number,
  origin: string,                // 'Project Gutenberg', etc.
  // Progress (both types):
  progress: {
    chapterIdx: number,          // librivox
    time: number,                // librivox (seconds)
    wordIdx: number,             // scraped/upload
  },
  coverEmoji: string,
  coverBg: string,
  addedAt: number,
}
```

Backward compat: old books without `source` field are treated as `'librivox'`.

### Google Drive sync (`driveSync.js`)

Stores the entire library as a single JSON file `readaloud_library.json` in the connected Drive account. **Do not modify this file.**

Auth priority:
1. `GOOGLE_SERVICE_ACCOUNT` env var — JSON string of service account credentials
2. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` — OAuth2

`render.yaml` lists all three OAuth vars with `sync: false` (must be set manually in Render dashboard). If none are configured the server still starts but `/api/library` errors.

One known subtlety: `libraryFileId` is cached in memory after first lookup. If the file is deleted from Drive while the server is running, the cached ID becomes stale and saves will 404 silently.

### Deployment

- Render free tier web service: `npm install` + `npm start`
- Self-ping every 14 minutes to prevent spin-down: `setInterval` hits `RENDER_EXTERNAL_URL/ping`
- `RENDER_EXTERNAL_URL` env var is set automatically by Render

---

## Bugs Fixed (in order)

### 1. LibriVox `title=` param requires exact match
`/api/search` now runs `title=q` AND `author=q` in parallel and deduplicates by `id`. Resilient: network errors return `[]` instead of 500.

### 2. LibriVox `audiotracks` endpoint broken (404)
`/api/chapters/:id` uses `audiobooks?id=X&format=json&extended=1` which returns `sections[]` inline. The dedicated audiotracks endpoint returns `{"error":"Audiotracks could not be found"}` for all books.

### 3. LibriVox `playtime` field is seconds-as-string
Field returns `"1297"` not `"0:21:37"`. Frontend `parseDuration()` handles `!isNaN(str)` branch.

### 4. PDF extraction garbage characters
`pdf-parse` was returning decoration lines (standalone `!` on each line), page number lines, and garbled lines from non-standard font encodings. Fix in `extractPdf()` (`server.js`): after raw extraction, split on newlines and discard any line containing no run of 3+ consecutive letters. Prose always has multi-letter words; artifacts don't. Verified against `TheLittlePrince.pdf` — 17,505 clean words.

### 5. TTS produces no audio (silent failure)
Two causes:
- Chrome leaves `speechSynthesis` in a paused state after `cancel()`. Fix: call `synth.resume()` immediately after `cancel()` when `synth.paused` is true (in `startTts()`).
- Voices not loaded before first play. Fix: `loadTtsVoices()` called eagerly on page boot; `onvoiceschanged` handler fires unconditionally (was previously gated on `curBook` being a text book).
- Silent errors: `utt.onerror` now logs `e.error` to console.

### 6. Playbar scrolls off-screen on long books
`#app` used `min-height: 100vh`, allowing the document to grow taller than the viewport. On long books, the page scrolled at document level, pushing `.playbar` off-screen. Fix: `#app` changed to `height: 100vh; height: 100dvh; overflow: hidden`. Inner `.chapters`, `.td`, `.grid` already have `flex:1; overflow-y:auto` — they scroll correctly once the parent has a fixed height. Applies to both audio and TTS player modes.

---

## Current Open Bug: Cross-Device Library Sync Not Working

**Symptom**: A book added on Device A doesn't appear when Device B opens the app (or vice versa). Both devices are hitting the same Render deployment.

**What should happen**:
1. On load, frontend calls `GET /api/library` → server calls `driveSync.loadLibrary()` → reads `readaloud_library.json` from Drive
2. When a book is added/removed/progress updated, frontend calls `POST /api/library` with the full library array → server calls `driveSync.saveLibrary(library)` → writes to Drive
3. Next load on any device should read the latest file from Drive

**Possible failure points** (not yet diagnosed):

1. **Drive credentials not configured on Render** — if `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` are not set in the Render dashboard env vars, `getDriveClient()` throws and `loadLibrary()` silently returns `[]`. The sync pill would show "⚠️ Offline" but the app still works locally (in-memory only).

2. **OAuth refresh token expired or revoked** — refresh tokens issued via the `urn:ietf:wg:oauth:2.0:oob` flow can expire if unused or if Google revokes them. Would manifest as 401 errors in server logs.

3. **`libraryFileId` cache stale** — if the Drive file was deleted and recreated, the cached `libraryFileId` in memory points to the deleted file. Saves would 404. Server restart clears the cache.

4. **Race condition on concurrent saves** — two devices saving at nearly the same time could overwrite each other. `driveSync.js` has no locking or conflict resolution; last write wins.

5. **Save actually failing silently** — `saveLibraryRemote()` in the frontend catches fetch errors and just updates the sync pill. If the save fails, the next device load will get stale data.

6. **Render free tier spin-down** — if the server was spun down between Device A's save and Device B's load, the server restarts fresh. The self-ping interval should prevent this but only while at least one device is active.

---

## What's Needed Next to Diagnose/Fix the Sync Bug

### Step 1 — Confirm Drive credentials are set on Render
In the Render dashboard → Environment → verify `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` all have values. If missing, that's the entire bug.

### Step 2 — Check server logs on Render
After adding a book on Device A:
- Look for `[drive] library saved` → confirms save reached Drive
- Look for `[drive save failed]` or `[drive load failed]` → confirms credentials/auth issue
- Look for any 401/403 errors in the googleapis calls

### Step 3 — Test sync directly via the API
```bash
# From terminal — check what's in Drive right now:
curl https://<render-url>/api/library

# Add a test entry:
curl -X POST https://<render-url>/api/library \
  -H "Content-Type: application/json" \
  -d '{"library":[{"id":"test1","title":"Test Book","source":"librivox","chapters":[]}]}'

# Load again from a different network/device:
curl https://<render-url>/api/library
```

If the second curl returns `test1`, Drive sync is working and the bug is in the frontend (not re-fetching on focus/visibility change). If it doesn't, it's a server/credentials issue.

### Step 4 — If credentials are the issue
Re-generate a fresh OAuth refresh token:
```bash
# Use the Google OAuth playground or run locally:
node -e "
const {google} = require('googleapis');
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');
console.log(oauth2.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive.file'] }));
"
# Visit the URL, authorize, get the code, then exchange:
node -e "
const {google} = require('googleapis');
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');
oauth2.getToken('AUTH_CODE_HERE').then(({tokens}) => console.log(tokens));
"
```

### Step 5 — If sync is working but devices diverge
Add a `visibilitychange` listener to re-fetch from Drive whenever the user tabs back to the app — this ensures Device B always gets fresh data when it comes to the foreground rather than only on initial page load.

```js
// Add to boot section in index.html:
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadLibrary();
});
```

---

## Running Locally

```bash
npm install
npm run dev      # nodemon, port 3000
npm test         # 22 Jest tests
```

No env vars needed to run locally — Drive sync will fail (returns `[]`) but everything else works. Upload test: `test-files/TheLittlePrince.pdf` is committed to the repo.
