const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { loadLibrary, saveLibrary } = require('./driveSync');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const LIBRIVOX = 'https://librivox.org/api/feed';

// ── Self-ping to prevent Render free tier spin-down ──────────────────────────
setInterval(() => {
  const client = require(SELF_URL.startsWith('https') ? 'https' : 'http');
  client.get(`${SELF_URL}/ping`, () => {}).on('error', () => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── LibriVox search ───────────────────────────────────────────────────────────
// LibriVox title param requires exact match; author param is partial.
// We run both in parallel and merge results.
async function librivoxSearch(param, value) {
  try {
    const r = await axios.get(`${LIBRIVOX}/audiobooks`, {
      params: { [param]: value, format: 'json', limit: 10 },
      timeout: 10000,
      validateStatus: s => s < 500, // treat 404 (no results) as non-error
    });
    return r.data.books || [];
  } catch (e) {
    return [];
  }
}

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const [byTitle, byAuthor] = await Promise.all([
      librivoxSearch('title', q),
      librivoxSearch('author', q),
    ]);
    const seen = new Set();
    const books = [...byTitle, ...byAuthor].filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id); return true;
    });
    res.json({ books });
  } catch (e) {
    console.error('[search error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── LibriVox chapter list ─────────────────────────────────────────────────────
// extended=1 includes sections inline in the book response
app.get('/api/chapters/:id', async (req, res) => {
  try {
    const r = await axios.get(`${LIBRIVOX}/audiobooks`, {
      params: { id: req.params.id, format: 'json', extended: 1 },
      timeout: 10000,
    });
    const book = (r.data.books || [])[0] || {};
    res.json({ sections: book.sections || [] });
  } catch (e) {
    console.error('[chapters error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Drive library sync ─────────────────────────────────────────────────
app.get('/api/library', async (req, res) => {
  try {
    res.json({ library: await loadLibrary() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/library', async (req, res) => {
  const { library } = req.body;
  if (!Array.isArray(library)) return res.status(400).json({ error: 'library array required' });
  try {
    await saveLibrary(library);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Serve app ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ReadAloud running on port ${PORT}`);
    console.log(`Self-ping URL: ${SELF_URL}/ping`);
  });
}
