const { google } = require('googleapis');

const LIBRARY_FILENAME = 'readaloud_library.json';
let driveClient = null;
let libraryFileId = null;

// ── Auth — uses service account or OAuth token from env ──────────────────────
function getDriveClient() {
  if (driveClient) return driveClient;

  // Option 1: Service account JSON in env
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  }

  // Option 2: OAuth2 with refresh token
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    driveClient = google.drive({ version: 'v3', auth: oauth2 });
    return driveClient;
  }

  throw new Error('No Google credentials configured. Set GOOGLE_SERVICE_ACCOUNT or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN in environment variables.');
}

// ── Find or cache the library file ID ────────────────────────────────────────
async function getLibraryFileId() {
  if (libraryFileId) return libraryFileId;
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `name='${LIBRARY_FILENAME}' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  if (res.data.files && res.data.files.length > 0) {
    libraryFileId = res.data.files[0].id;
  }
  return libraryFileId;
}

// ── Load library from Drive ───────────────────────────────────────────────────
async function loadLibrary() {
  try {
    const drive = getDriveClient();
    const fileId = await getLibraryFileId();
    if (!fileId) return [];
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[drive load failed]', e.message);
    return [];
  }
}

// ── Save library to Drive ─────────────────────────────────────────────────────
async function saveLibrary(library) {
  try {
    const drive = getDriveClient();
    const content = JSON.stringify(library, null, 2);
    const media = { mimeType: 'application/json', body: content };
    let fileId = await getLibraryFileId();

    if (fileId) {
      // Update existing file
      await drive.files.update({ fileId, media });
    } else {
      // Create new file
      const res = await drive.files.create({
        requestBody: { name: LIBRARY_FILENAME, mimeType: 'application/json' },
        media,
        fields: 'id',
      });
      libraryFileId = res.data.id;
    }
    console.log('[drive] library saved');
  } catch (e) {
    console.error('[drive save failed]', e.message);
    throw e;
  }
}

module.exports = { loadLibrary, saveLibrary };
