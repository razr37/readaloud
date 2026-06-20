# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start           # production server (node src/server.js)
npm run dev         # dev server with nodemon auto-restart
npm test            # Jest test suite (--forceExit)
npx jest -t "name"  # run a single test by name substring
```

## Architecture

Single-page app: one Express server, one HTML file, one sync module.

```
src/server.js           — Express API + all business logic
src/driveSync.js        — Google Drive persistence (do not modify)
src/__tests__/          — Jest + supertest (axios-mock-adapter for external calls)
public/index.html       — Entire frontend: CSS, HTML, and JS in one file, no build step
render.yaml             — Render.com deploy config
test-files/             — Local test files (gitignored — PDFs/EPUBs stay local only)
```

### Server (`src/server.js`)

All routes in one file. Pattern: `module.exports = app` + `if (require.main === module) app.listen(...)` so supertest can import without starting the server.

Key endpoints:
- `GET /api/search?q=` — LibriVox dual search (title + author in parallel, deduplicated). `title=` requires exact match; `author=` does partial — both run concurrently and results are merged.
- `GET /api/chapters/:id` — uses `?extended=1` on the audiobooks endpoint. The dedicated `/audiotracks` endpoint is broken (404) on LibriVox's API.
- `GET /api/search-text?q=` — Stage 2 cascade: parallel Gutenberg (gutendex.com) + Standard Ebooks (cheerio scrape) + Archive.org. Uses `Promise.allSettled` so one source failing doesn't abort the rest.
- `POST /api/fetch-text` — fetches a URL as arraybuffer, dispatches to epub/pdf/txt extractor, strips Gutenberg `*** START OF` / `*** END OF` markers.
- `POST /api/extract-upload` — multer `memoryStorage()`, same extraction pipeline, returns `suggestedTitle` from filename.
- `GET|POST /api/library` — thin wrapper around `driveSync.js`.

**LibriVox quirk**: `playtime` field returns seconds as a string (e.g. `"1297"`), not formatted time. `parseDuration()` in the frontend handles both forms.

**PDF extraction quirk**: `pdf-parse` produces lines of stray `!` characters (decoration artifacts) and garbled lines from non-standard font encodings. `extractPdf()` filters these by discarding any line that contains no run of 3+ consecutive letters — readable prose always has multi-letter words, artifacts don't.

### Frontend (`public/index.html`)

All CSS, HTML, and JS in a single file. No build step.

**Layout constraint**: `#app` uses `height:100vh; height:100dvh; overflow:hidden` (not `min-height`). This is what makes the inner flex layout work — `.chapters`, `.td`, and `.grid` all use `flex:1; overflow-y:auto` and only scroll correctly when the parent has a fixed height. Do not change `#app` back to `min-height` or both players will lose their sticky playbar.

**Player dual mode** — two `<div class="player-section">` inside `#vPlayer`, toggled with `.on`:
- `#audioView` — chapter list + HTML5 `<audio>` controls. Active for `book.source === 'librivox'` (or missing `source` — backward compat with old library entries).
- `#ttsView` — word-highlighted text reader + Web Speech API. Active for `source === 'scraped'` or `source === 'upload'`.

**TTS quirk**: Chrome leaves `speechSynthesis` in a paused state after `cancel()`. `startTts()` calls `synth.resume()` immediately after `cancel()` to unstick it. Voices are loaded eagerly on page boot (not just when a book opens) so they're ready before first play.

**Search cascade** in `doSearch()`: Stage 1 (LibriVox) → if empty → Stage 2 (text sources) → if empty → Stage 3 (upload zone mounts into DOM). The upload zone is hidden during stages 1–2.

**Book data model** — single object for all three sources:
- `source`: `'librivox' | 'scraped' | 'upload'`
- LibriVox only: `chapters[]`, `totaltime`
- Scraped/upload only: `text`, `wordCount`, `origin`
- Both: `progress: { chapterIdx, time, wordIdx }`, `coverEmoji`, `coverBg`, `addedAt`

### Google Drive sync (`src/driveSync.js`)

Stores the entire library as `readaloud_library.json`. Auth priority:
1. `GOOGLE_SERVICE_ACCOUNT` env var (JSON string of service account credentials)
2. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`

If neither is configured, the server starts but `/api/library` errors. `libraryFileId` is cached in memory after first lookup — if the Drive file is deleted while the server runs, saves will 404 silently until restart. **Do not modify this file.**

**`invalid_grant` / empty library symptom**: if `GET /api/library` returns `{"library":[]}` or `POST` returns `{"error":"invalid_grant"}`, the refresh token has expired or been revoked. Regenerate it via the OAuth playground flow (see PROJECT_STATUS.md) and update `GOOGLE_REFRESH_TOKEN` in the Render dashboard, then redeploy.

**Known gotcha — OAuth client must be in Production mode**: while in "Testing" mode, Google caps refresh tokens at 7 days regardless of usage. This has already caused one outage. The OAuth client has been published to Production (Google Cloud Console → APIs & Services → Google Auth Platform → Audience). Because the app only uses `drive.file` scope, publishing does not require Google's verification review. If `invalid_grant` recurs without an obvious revocation reason, check that the client hasn't been rolled back to Testing mode.

### Tests (`src/__tests__/server.test.js`)

`jest.mock('../driveSync', ...)` prevents real Drive calls. `axios-mock-adapter` intercepts all outbound HTTP. Each test calls `mock.reset()` in `afterEach`. File upload tests use supertest's `.attach()` with a `Buffer`.
