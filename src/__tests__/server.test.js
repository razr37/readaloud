const request = require('supertest');
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

// Mock driveSync before requiring server
jest.mock('../driveSync', () => ({
  loadLibrary: jest.fn().mockResolvedValue([{ id: 'b1', title: 'Test Book', chapters: [] }]),
  saveLibrary: jest.fn().mockResolvedValue(undefined),
}));

const app = require('../server');
const mock = new MockAdapter(axios);

afterEach(() => mock.reset());

// ── /ping ─────────────────────────────────────────────────────────────────────
test('GET /ping returns ok', async () => {
  const res = await request(app).get('/ping');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.time).toBeDefined();
});

// ── /api/search ───────────────────────────────────────────────────────────────
test('GET /api/search requires q param', async () => {
  const res = await request(app).get('/api/search');
  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});

test('GET /api/search returns LibriVox books (title match)', async () => {
  mock.onGet('https://librivox.org/api/feed/audiobooks').reply(200, {
    books: [
      { id: '753', title: 'Moby Dick, or the Whale', authors: [{ first_name: 'Herman', last_name: 'Melville' }], num_sections: '135', totaltime: '23:45:00' },
    ],
  });
  const res = await request(app).get('/api/search?q=moby+dick');
  expect(res.status).toBe(200);
  expect(res.body.books.length).toBeGreaterThan(0);
  expect(res.body.books[0].id).toBe('753');
});

test('GET /api/search deduplicates books from title + author searches', async () => {
  const book = { id: '253', title: 'Pride and Prejudice', authors: [{ first_name: 'Jane', last_name: 'Austen' }], num_sections: '61', totaltime: '11:35:00' };
  mock.onGet('https://librivox.org/api/feed/audiobooks').reply(200, { books: [book] });
  const res = await request(app).get('/api/search?q=Pride+and+Prejudice');
  expect(res.status).toBe(200);
  // Both title and author searches return same book — should be deduplicated to 1
  expect(res.body.books).toHaveLength(1);
});

test('GET /api/search returns empty array when LibriVox finds nothing', async () => {
  mock.onGet('https://librivox.org/api/feed/audiobooks').reply(404, { error: 'Audiobooks could not be found' });
  const res = await request(app).get('/api/search?q=zzz_no_match');
  expect(res.status).toBe(200);
  expect(res.body.books).toHaveLength(0);
});

test('GET /api/search returns empty books on network error (resilient)', async () => {
  mock.onGet('https://librivox.org/api/feed/audiobooks').networkError();
  const res = await request(app).get('/api/search?q=moby');
  expect(res.status).toBe(200);
  expect(res.body.books).toHaveLength(0);
});

// ── /api/chapters/:id ─────────────────────────────────────────────────────────
test('GET /api/chapters/:id returns sections from extended book response', async () => {
  mock.onGet('https://librivox.org/api/feed/audiobooks').reply(200, {
    books: [{
      id: '123',
      title: 'Emma',
      sections: [
        { section_number: '1', title: 'Chapter 1', listen_url: 'https://archive.org/download/emma/ch1.mp3', playtime: '0:34:12' },
        { section_number: '2', title: 'Chapter 2', listen_url: 'https://archive.org/download/emma/ch2.mp3', playtime: '0:27:05' },
      ],
    }],
  });
  const res = await request(app).get('/api/chapters/123');
  expect(res.status).toBe(200);
  expect(res.body.sections).toHaveLength(2);
  expect(res.body.sections[0].listen_url).toContain('ch1.mp3');
  expect(res.body.sections[0].playtime).toBe('0:34:12');
});

test('GET /api/chapters/:id handles error gracefully', async () => {
  mock.onGet('https://librivox.org/api/feed/audiobooks').networkError();
  const res = await request(app).get('/api/chapters/999');
  expect(res.status).toBe(500);
  expect(res.body.error).toBeDefined();
});

// ── /api/library ──────────────────────────────────────────────────────────────
test('GET /api/library returns library from Drive', async () => {
  const res = await request(app).get('/api/library');
  expect(res.status).toBe(200);
  expect(res.body.library).toHaveLength(1);
  expect(res.body.library[0].id).toBe('b1');
});

test('POST /api/library saves library', async () => {
  const res = await request(app)
    .post('/api/library')
    .send({ library: [{ id: 'b2', title: 'New Book', chapters: [] }] });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
});

test('POST /api/library rejects non-array', async () => {
  const res = await request(app)
    .post('/api/library')
    .send({ library: 'not an array' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});

// ── /api/search-text ──────────────────────────────────────────────────────────
test('GET /api/search-text requires q param', async () => {
  const res = await request(app).get('/api/search-text');
  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});

test('GET /api/search-text returns Gutenberg results', async () => {
  mock.onGet('https://gutendex.com/books/').reply(200, {
    results: [
      {
        title: 'Frankenstein',
        authors: [{ name: 'Shelley, Mary' }],
        formats: { 'text/plain; charset=utf-8': 'https://www.gutenberg.org/files/84/84-0.txt' },
      },
    ],
  });
  mock.onGet('https://standardebooks.org/ebooks').reply(200, '<html><body></body></html>');
  mock.onGet('https://archive.org/advancedsearch.php').reply(200, { response: { docs: [] } });

  const res = await request(app).get('/api/search-text?q=frankenstein');
  expect(res.status).toBe(200);
  expect(res.body.results.length).toBeGreaterThan(0);
  expect(res.body.results[0].title).toBe('Frankenstein');
  expect(res.body.results[0].origin).toBe('Project Gutenberg');
  expect(res.body.results[0].url).toContain('gutenberg.org');
  expect(res.body.results[0].format).toBe('txt');
});

test('GET /api/search-text returns Archive.org results', async () => {
  mock.onGet('https://gutendex.com/books/').reply(200, { results: [] });
  mock.onGet('https://standardebooks.org/ebooks').reply(200, '<html><body></body></html>');
  mock.onGet('https://archive.org/advancedsearch.php').reply(200, {
    response: {
      docs: [
        { identifier: 'warandpeace', title: 'War and Peace', creator: 'Tolstoy, Leo' },
      ],
    },
  });

  const res = await request(app).get('/api/search-text?q=war+and+peace');
  expect(res.status).toBe(200);
  expect(res.body.results.length).toBeGreaterThan(0);
  const arc = res.body.results.find(r => r.origin === 'Internet Archive');
  expect(arc).toBeDefined();
  expect(arc.url).toContain('warandpeace');
});

test('GET /api/search-text returns empty results when all sources fail', async () => {
  mock.onGet('https://gutendex.com/books/').networkError();
  mock.onGet('https://standardebooks.org/ebooks').networkError();
  mock.onGet('https://archive.org/advancedsearch.php').networkError();

  const res = await request(app).get('/api/search-text?q=zzz_test');
  expect(res.status).toBe(200);
  expect(res.body.results).toHaveLength(0);
});

test('GET /api/search-text strips Gutenberg books without plain text URL', async () => {
  mock.onGet('https://gutendex.com/books/').reply(200, {
    results: [
      {
        title: 'No Text Book',
        authors: [{ name: 'Author, Unknown' }],
        formats: { 'application/epub+zip': 'https://gutenberg.org/epub/123/book.epub' },
      },
    ],
  });
  mock.onGet('https://standardebooks.org/ebooks').reply(200, '<html><body></body></html>');
  mock.onGet('https://archive.org/advancedsearch.php').reply(200, { response: { docs: [] } });

  const res = await request(app).get('/api/search-text?q=no+text');
  expect(res.status).toBe(200);
  expect(res.body.results.filter(r => r.origin === 'Project Gutenberg')).toHaveLength(0);
});

// ── /api/fetch-text ───────────────────────────────────────────────────────────
test('POST /api/fetch-text requires url', async () => {
  const res = await request(app).post('/api/fetch-text').send({});
  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});

test('POST /api/fetch-text fetches and returns plain text', async () => {
  const sampleText = 'Call me Ishmael. Some years ago never mind how long precisely.';
  mock.onGet('https://www.gutenberg.org/files/2701/2701-0.txt').reply(200, sampleText, { 'content-type': 'text/plain' });

  const res = await request(app)
    .post('/api/fetch-text')
    .send({ url: 'https://www.gutenberg.org/files/2701/2701-0.txt', format: 'txt' });
  expect(res.status).toBe(200);
  expect(res.body.text).toBeDefined();
  expect(res.body.wordCount).toBeGreaterThan(0);
});

test('POST /api/fetch-text strips Gutenberg header/footer markers', async () => {
  const raw = 'Some preamble\n*** START OF THE PROJECT GUTENBERG EBOOK\nActual book text here.\n*** END OF THE PROJECT GUTENBERG EBOOK\nSome footer';
  mock.onGet('https://www.gutenberg.org/test.txt').reply(200, raw, { 'content-type': 'text/plain' });

  const res = await request(app)
    .post('/api/fetch-text')
    .send({ url: 'https://www.gutenberg.org/test.txt', format: 'txt' });
  expect(res.status).toBe(200);
  expect(res.body.text).toContain('Actual book text here.');
  expect(res.body.text).not.toContain('Some preamble');
  expect(res.body.text).not.toContain('Some footer');
});

// ── /api/extract-upload ───────────────────────────────────────────────────────
test('POST /api/extract-upload requires a file', async () => {
  const res = await request(app).post('/api/extract-upload');
  expect(res.status).toBe(400);
  expect(res.body.error).toBeDefined();
});

test('POST /api/extract-upload handles a plain txt file', async () => {
  const text = 'To be or not to be that is the question whether tis nobler in the mind to suffer.';
  const res = await request(app)
    .post('/api/extract-upload')
    .attach('file', Buffer.from(text), { filename: 'hamlet.txt', contentType: 'text/plain' });
  expect(res.status).toBe(200);
  expect(res.body.text).toBe(text);
  expect(res.body.wordCount).toBeGreaterThan(0);
  expect(res.body.suggestedTitle).toBe('hamlet');
});

// ── fallback ──────────────────────────────────────────────────────────────────
test('unknown route serves index.html', async () => {
  const res = await request(app).get('/some/random/path');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/html/);
});
