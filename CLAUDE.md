# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # production server (node src/server.js)
npm run dev        # dev server with nodemon auto-restart
npm test           # Jest test suite (--forceExit)
npx jest -t "name" # run a single test by name substring
```

## Architecture

This is a single-page app: one Express server, one HTML file, one sync module.

```
src/server.js       — Express API + all business logic
src/driveSync.js    — Google Drive persistence (do not modify)
src/__tests__/      — Jest + supertest tests (axios-mock-adapter for external calls)
public/index.html   — Entire frontend: CSS, HTML, and JS in one file
render.yaml         — Render.com deploy config
```

### Server (`src/server.js`)

All routes in one file. Pattern: `module.exports = app` + `if (require.main === module) app.listen(...)` so supertest can import the app without starting the server.

Key endpoints:
- `GET /api/search?q=` — LibriVox dual search (title + author in parallel, deduplicated). LibriVox `title=` requires exact match; `author=` does partial. Both run concurrently, results merged.
- `GET /api/chapters/:id` — uses `?extended=1` on the audiobooks endpoint (the `/audiotracks` endpoint is broken/404 on LibriVox's API).
- `GET /api/search-text?q=` — Stage 2 cascade: parallel Gutenberg (gutendex.com) + Standard Ebooks (cheerio scrape) + Archive.org. Uses `Promise.allSettled` so one failure doesn't kill the rest.
- `POST /api/fetch-text` — fetches a URL as arraybuffer, dispatches to epub/pdf/txt extractor, strips Gutenberg `*** START OF` / `*** END OF` markers.
- `POST /api/extract-upload` — multer `memoryStorage()`, same extraction pipeline, returns `suggestedTitle` from filename.
- `GET|POST /api/library` — thin wrapper around `driveSync.js`.

LibriVox quirk: `playtime` field returns seconds as a string (e.g. `"1297"`), not formatted time. `parseDuration()` in the frontend handles both forms.

### Frontend (`public/index.html`)

All CSS, HTML, and JS in a single file. No build step, no bundler.

**Player dual mode** — two `<div class="player-section">` inside `#vPlayer`, toggled with `.on`:
- `#audioView` — chapter list + HTML5 `<audio>` controls. Active for `book.source === 'librivox'` (or missing `source` field — backward compat).
- `#ttsView` — word-highlighted text reader + Web Speech API. Active for `source === 'scraped'` or `source === 'upload'`.

**Search cascade** in `doSearch()`: Stage 1 (LibriVox) → if empty → Stage 2 (text sources) → if empty → Stage 3 (upload zone mounts into DOM). The upload zone is hidden during stages 1–2.

**Book data model** — single object shape for all three sources. Key fields: `source`, `chapters[]` (librivox only), `text` + `wordCount` (scraped/upload only), `progress: { chapterIdx, time, wordIdx }`. Old books without `source` are treated as `'librivox'`.

### Google Drive sync (`src/driveSync.js`)

Stores the entire library as `readaloud_library.json` in the connected Drive account. Auth supports two modes (checked in order):
1. `GOOGLE_SERVICE_ACCOUNT` env var (JSON string of service account credentials)
2. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`

If neither is configured, Drive operations throw — the server still starts but `/api/library` will error. **Do not modify this file.**

### Tests (`src/__tests__/server.test.js`)

`jest.mock('../driveSync', ...)` prevents real Drive calls. `axios-mock-adapter` intercepts all outbound HTTP. Each test calls `mock.reset()` in `afterEach`. File upload tests use supertest's `.attach()` with a `Buffer`.
