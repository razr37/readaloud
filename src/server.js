const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const multer = require('multer');
const cheerio = require('cheerio');
const { loadLibrary, saveLibrary } = require('./driveSync');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const LIBRIVOX = 'https://librivox.org/api/feed';

// ── Self-ping to prevent Render free tier spin-down ──────────────────────────
setInterval(() => {
  const client = require(SELF_URL.startsWith('https') ? 'https' : 'http');
  client.get(`${SELF_URL}/ping`, () => {}).on('error', () => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── LibriVox search (Stage 1) ─────────────────────────────────────────────────
async function librivoxSearch(param, value) {
  try {
    const r = await axios.get(`${LIBRIVOX}/audiobooks`, {
      params: { [param]: value, format: 'json', limit: 10 },
      timeout: 10000,
      validateStatus: s => s < 500,
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

// ── Text search (Stage 2) — Gutenberg + Standard Ebooks + Archive.org ─────────
app.get('/api/search-text', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const [gut, se, arc] = await Promise.allSettled([
      searchGutenberg(q),
      searchStandardEbooks(q),
      searchArchive(q),
    ]);
    const results = [
      ...(gut.status === 'fulfilled' ? gut.value : []),
      ...(se.status === 'fulfilled' ? se.value : []),
      ...(arc.status === 'fulfilled' ? arc.value : []),
    ];
    res.json({ results });
  } catch (e) {
    console.error('[search-text error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function searchGutenberg(q) {
  const r = await axios.get('https://gutendex.com/books/', {
    params: { search: q, languages: 'en' },
    timeout: 8000,
    validateStatus: s => s < 500,
  });
  return (r.data.results || []).slice(0, 4).map(book => {
    const fmt = book.formats || {};
    const url = fmt['text/plain; charset=utf-8'] || fmt['text/plain; charset=us-ascii'] || fmt['text/plain']
      || Object.entries(fmt).find(([k]) => k.startsWith('text/plain') && !k.includes('zip'))?.[1];
    if (!url) return null;
    return {
      title: book.title,
      author: (book.authors?.[0]?.name || '').split(',').reverse().join(' ').trim(),
      origin: 'Project Gutenberg',
      url,
      format: 'txt',
    };
  }).filter(Boolean);
}

async function searchStandardEbooks(q) {
  const r = await axios.get(`https://standardebooks.org/ebooks?query=${encodeURIComponent(q)}`, {
    headers: { 'User-Agent': 'ReadAloud/2.0 (personal-use audiobook player)' },
    timeout: 8000,
    validateStatus: s => s < 500,
  });
  const $ = cheerio.load(r.data);
  const results = [];
  $('li[itemtype="https://schema.org/Book"], article.ebook').slice(0, 2).each((_, el) => {
    const href = $(el).find('a[href^="/ebooks/"]').first().attr('href');
    const title = $(el).find('[itemprop="name"], h2').first().text().trim();
    const author = $(el).find('[itemprop="author"], p.author').first().text().trim();
    if (!href || !title) return;
    const slug = href.replace('/ebooks/', '');
    results.push({
      title,
      author,
      origin: 'Standard Ebooks',
      url: `https://standardebooks.org/ebooks/${slug}/downloads/${slug.replace(/\//g, '_')}.epub`,
      format: 'epub',
    });
  });
  return results;
}

async function searchArchive(q) {
  const r = await axios.get('https://archive.org/advancedsearch.php', {
    params: {
      q: `"${q}" mediatype:texts language:English -subject:"Lending Library" -subject:"In library"`,
      'fl[]': ['identifier', 'title', 'creator'],
      rows: 3,
      output: 'json',
    },
    timeout: 8000,
    validateStatus: s => s < 500,
  });
  return (r.data?.response?.docs || []).map(doc => ({
    title: doc.title,
    author: Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || ''),
    origin: 'Internet Archive',
    url: `https://archive.org/download/${doc.identifier}/${doc.identifier}.txt`,
    format: 'txt',
  }));
}

// ── Fetch text from URL (called at add-time for scraped books) ────────────────
app.post('/api/fetch-text', async (req, res) => {
  const { url, format } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'ReadAloud/2.0' },
      maxContentLength: 50 * 1024 * 1024,
    });
    const buf = Buffer.from(r.data);
    const ct = r.headers['content-type'] || '';
    let result;
    if (format === 'epub' || ct.includes('epub')) {
      result = await extractEpub(buf);
    } else if (format === 'pdf' || ct.includes('pdf')) {
      result = await extractPdf(buf);
    } else {
      const text = cleanGutenbergText(buf.toString('utf-8'));
      result = { text, wordCount: text.split(/\s+/).filter(w => w.length).length };
    }
    res.json(result);
  } catch (e) {
    console.error('[fetch-text error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Upload & extract (Stage 3) ────────────────────────────────────────────────
app.post('/api/extract-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const buf = req.file.buffer;
    let result;
    if (ext === '.epub') result = await extractEpub(buf);
    else if (ext === '.pdf') result = await extractPdf(buf);
    else {
      const text = buf.toString('utf-8');
      result = { text, wordCount: text.split(/\s+/).filter(w => w.length).length };
    }
    res.json({ ...result, suggestedTitle: path.basename(req.file.originalname, ext) });
  } catch (e) {
    console.error('[upload error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Text extraction helpers ───────────────────────────────────────────────────
async function extractEpub(buffer) {
  const EPub = require('epub2').EPub || require('epub2');
  const tmpFile = path.join(os.tmpdir(), `ra_${Date.now()}.epub`);
  fs.writeFileSync(tmpFile, buffer);
  return new Promise((resolve, reject) => {
    const epub = new EPub(tmpFile);
    epub.on('end', async () => {
      try {
        const chapters = [];
        for (const ch of epub.flow) {
          if (!ch.id) continue;
          const text = await new Promise(res => {
            epub.getChapter(ch.id, (err, data) => {
              if (err) return res('');
              const $ = cheerio.load(data || '');
              res($.text());
            });
          });
          if (text.trim().length > 100) chapters.push(text.trim());
        }
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        const fullText = chapters.join('\n\n');
        resolve({ text: fullText, wordCount: fullText.split(/\s+/).filter(w => w.length).length });
      } catch (e) { reject(e); }
    });
    epub.on('error', reject);
    epub.parse();
  });
}

async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  // Drop lines with no run of 3+ letters — removes page-number lines, decoration lines
  // (e.g. repeated "!" separators), and garbled lines from non-standard font encodings.
  const text = data.text
    .replace(/\f/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .split('\n')
    .filter(line => /[a-zA-ZÀ-ɏ]{3,}/.test(line))
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, wordCount: text.split(/\s+/).filter(w => w.length).length };
}

function cleanGutenbergText(text) {
  const startM = ['*** START OF', '***START OF', '** START OF'];
  const endM = ['*** END OF', '***END OF', 'End of Project Gutenberg', 'End of the Project Gutenberg'];
  let start = 0, end = text.length;
  for (const m of startM) {
    const i = text.indexOf(m);
    if (i !== -1) { const nl = text.indexOf('\n', i); start = nl !== -1 ? nl + 1 : i + m.length; break; }
  }
  for (const m of endM) {
    const i = text.lastIndexOf(m);
    if (i !== -1) { end = i; break; }
  }
  return text.slice(start, end).trim();
}

// ── Google Drive library sync ─────────────────────────────────────────────────
app.get('/api/library', async (req, res) => {
  try { res.json({ library: await loadLibrary() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/library', async (req, res) => {
  const { library } = req.body;
  if (!Array.isArray(library)) return res.status(400).json({ error: 'library array required' });
  try { await saveLibrary(library); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
