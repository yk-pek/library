const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { verifyMessage, getAddress, isAddress } = require('ethers');
const { pool, init } = require('./db');
const views = require('./views');
const { countWords } = require('./text');
const importer = require('./import');

const PORT = process.env.PORT || 3000;
const COOKIE = '__Host-library';
const SESSION_DAYS = 30;
const NONCE_MINUTES = 10;
const NETWORK_LABEL = process.env.NETWORK_LABEL || 'testnet';
const CHAIN_ID = /^[0-9]{1,12}$/.test(process.env.CHAIN_ID || '') ? process.env.CHAIN_ID : '1';
const MAX_BODY_CHARS = 400_000;
const PER_PAGE = 30;

const NOTICES = {
  added: 'Your reading is on the shelf. Thank you.',
  saved: 'Saved.',
  removed: 'Reading taken off the shelf.',
  restored: 'Reading put back on the shelf.',
  deleted: 'Reading deleted for good.',
  recommended: 'You recommend this reading.',
  unrecommended: 'Recommendation withdrawn.',
  commented: 'Comment added.',
  'comment-removed': 'Comment removed.',
  'shelf-added': 'Shelf added.',
  'shelf-saved': 'Shelf saved.',
  'shelf-removed': 'Shelf removed.',
  'shelf-not-empty': 'That shelf still has readings on it. Move them first.',
  'librarian-added': 'Librarian added.',
  'librarian-removed': 'Librarian removed.',
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- helpers ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function requestHost(req) {
  return (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
}

function readCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanText(value, field, max, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new HttpError(400, `${field} must be text`);
  }
  const text = value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (required && !text) throw new HttpError(400, `${field} can't be empty`);
  if (text.length > max) throw new HttpError(400, `${field} is too long (max ${max.toLocaleString('en')} characters)`);
  return text;
}

function intParam(value) {
  if (!/^[0-9]{1,9}$/.test(String(value))) throw new HttpError(404, 'Not found');
  return Number(value);
}

// Simple in-memory rate limiter: at most `max` hits per `windowMs` per key.
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw new HttpError(429, 'Slow down a little and try again shortly');
  hits.push(now);
  buckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) if (hits.every((t) => now - t > 3600_000)) buckets.delete(k);
}, 600_000).unref();

function slugify(text, fallback = 'reading') {
  const base = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return base || fallback;
}

function cleanTags(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw new HttpError(400, 'Tags must be text');
  const tags = [];
  for (const raw of value.split(',')) {
    const tag = slugify(raw, '').slice(0, 24).replace(/-+$/, '');
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 5) throw new HttpError(400, 'A reading can have up to 5 tags');
  return tags;
}

function cleanUrl(value) {
  const text = cleanText(value, 'The source link', 500, { required: false });
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'The source link must be a full web address starting with https://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'The source link must start with https://');
  return url.href;
}

// Everything a list of readings needs; never the full text.
const LIST_FIELDS = `r.id, r.slug, r.title, r.author, r.year, r.shelf_slug, s.name AS shelf_name, r.note, r.tags, r.words,
  r.contributor, r.removed, r.removed_by, r.removed_at, r.created_at,
  (SELECT COUNT(*)::int FROM recommendations x WHERE x.reading_id = r.id) AS recs,
  (SELECT COUNT(*)::int FROM comments c WHERE c.reading_id = r.id AND NOT c.removed) AS comment_count,
  (SELECT f.pages FROM files f WHERE f.reading_id = r.id) AS file_pages,
  (SELECT f.size FROM files f WHERE f.reading_id = r.id) AS file_size`;
const LIST_FROM = 'FROM readings r JOIN shelves s ON s.slug = r.shelf_slug';
const ORDERS = { new: 'r.id DESC', top: 'recs DESC, r.id DESC' };

function listing(req) {
  const sort = req.query.sort === 'top' ? 'top' : 'new';
  const pageNo = /^[1-9][0-9]{0,4}$/.test(String(req.query.p || '')) ? Number(req.query.p) : 1;
  return { sort, pageNo, order: ORDERS[sort], offset: (pageNo - 1) * PER_PAGE };
}

// Fetches one page plus one extra row, to know whether there is a next page.
async function listReadings(where, params, { order, offset }) {
  const { rows } = await pool.query(
    `SELECT ${LIST_FIELDS} ${LIST_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${PER_PAGE + 1} OFFSET ${offset}`,
    params
  );
  return { readings: rows.slice(0, PER_PAGE), more: rows.length > PER_PAGE };
}

// ---------- middleware ----------

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '32kb' }));
// Full texts arrive as ordinary form posts, so the limit is generous.
app.use(express.urlencoded({ extended: false, limit: '3mb', parameterLimit: 30 }));

// Block cross-site writes: a browser's Origin, when sent, must be this site.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== requestHost(req)) return next(new HttpError(403, 'Cross-site request refused'));
    }
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '5m' }));

// Load the signed-in wallet, if any, and whether it is a librarian.
app.use(wrap(async (req, res, next) => {
  req.user = null;
  req.isLibrarian = false;
  const token = readCookie(req, COOKIE);
  if (token) {
    const { rows } = await pool.query(
      `SELECT s.address, EXISTS (SELECT 1 FROM librarians l WHERE l.address = s.address) AS librarian
       FROM sessions s WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    if (rows[0]) {
      req.user = { address: rows[0].address };
      req.isLibrarian = rows[0].librarian;
    }
  }
  next();
}));

async function page(req, res, title, body, extra = {}) {
  const { rows: shelves } = await pool.query('SELECT slug, name FROM shelves ORDER BY position, name');
  // Pages that show a signed-in wallet must not be cached.
  if (req.user) res.setHeader('Cache-Control', 'no-store');
  res.status(extra.status || 200).type('html').send(
    views.layout({
      title: title ? `${title} | Alternet Library` : 'Alternet Library',
      shelves,
      user: req.user,
      isLibrarian: req.isLibrarian,
      visitors: extra.visitors,
      currentShelf: extra.shelf,
      networkLabel: NETWORK_LABEL,
      body,
    })
  );
}

const notice = (req) => NOTICES[req.query.n] || '';

function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'Sign in with your wallet first');
  return req.user;
}

// The librarians' desk does not exist for anyone who is not a librarian.
function requireLibrarian(req) {
  if (!req.user || !req.isLibrarian) throw new HttpError(404, 'Not found');
  return req.user;
}

// ---------- auth ----------

app.post('/api/auth/nonce', wrap(async (req, res) => {
  rateLimit(`nonce:${req.ip}`, 20, 600_000);
  const { address } = req.body || {};
  if (typeof address !== 'string' || !isAddress(address)) throw new HttpError(400, 'Invalid wallet address');
  const checksummed = getAddress(address);
  const nonce = crypto.randomBytes(16).toString('hex');
  const host = requestHost(req);
  const message =
    `${host} wants you to sign in with your Ethereum account:\n${checksummed}\n\n` +
    `Sign in to the Alternet Library. This only proves you own this address; it costs nothing and sends no transaction.\n\n` +
    `URI: https://${host}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  await pool.query('INSERT INTO nonces (nonce, address, message) VALUES ($1, $2, $3)', [nonce, checksummed.toLowerCase(), message]);
  res.json({ nonce, message });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  rateLimit(`verify:${req.ip}`, 20, 600_000);
  const { nonce, signature } = req.body || {};
  if (typeof nonce !== 'string' || typeof signature !== 'string') throw new HttpError(400, 'Missing nonce or signature');

  // Each nonce can be used once, and only for a few minutes.
  const { rows } = await pool.query(
    `UPDATE nonces SET used = true
     WHERE nonce = $1 AND used = false AND created_at > now() - make_interval(mins => $2)
     RETURNING address, message`,
    [nonce, NONCE_MINUTES]
  );
  if (!rows[0]) throw new HttpError(400, 'Sign-in request expired, please try again');

  let recovered;
  try {
    recovered = verifyMessage(rows[0].message, signature).toLowerCase();
  } catch {
    throw new HttpError(400, 'Invalid signature');
  }
  if (recovered !== rows[0].address) throw new HttpError(401, 'Signature does not match the wallet address');

  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, address, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), recovered, SESSION_DAYS]
  );
  setSessionCookie(res, token, SESSION_DAYS * 86400);
  res.json({ address: recovered });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

// ---------- importing a text ----------

// Both routes hand back fields for the contribute form; nothing is saved here, and the
// page or PDF itself is not kept. The contributor still checks the text and shelves it.
function imported(result) {
  let body = result.body;
  const notes = [];
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS).replace(/\s+\S*$/, '');
    notes.push(`The text was longer than the library allows, so it stops after ${MAX_BODY_CHARS.toLocaleString('en')} characters.`);
  }
  return { title: result.title || '', author: result.author || '', year: result.year || '', source_url: result.source_url || '', body, words: countWords(body), pages: result.pages || 0, notes };
}

async function importing(req, work) {
  const user = requireUser(req);
  rateLimit(`import:${user.address}`, 20, 3600_000);
  try {
    return imported(await work());
  } catch (err) {
    if (err instanceof importer.ImportError) throw new HttpError(422, err.message);
    console.error('import failed:', err && err.message);
    throw new HttpError(422, 'That could not be read. Paste the text instead.');
  }
}

app.post('/api/import/link', wrap(async (req, res) => {
  const url = req.body && req.body.url;
  if (typeof url !== 'string' || url.length > 2000) throw new HttpError(400, 'Give the address of a web page or PDF');
  res.json(await importing(req, () => importer.fromLink(url)));
}));

app.put('/api/import/pdf', express.raw({ type: () => true, limit: importer.MAX_PDF_BYTES }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Choose a PDF file');
  let scanned = null;
  const result = await importing(req, async () => {
    const found = await importer.fromPdf(req.body);
    if (found.scan) scanned = found;
    return found;
  });
  if (!scanned) return res.json(result);

  // A scan has no text to pull out, so the file itself is kept and attached to the reading
  // when it is shelved. One waiting upload per wallet; a new one replaces the last.
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query('DELETE FROM files WHERE contributor = $1 AND reading_id IS NULL', [req.user.address]);
  await pool.query('INSERT INTO files (token, contributor, data, size, pages) VALUES ($1, $2, $3, $4, $5)', [
    token, req.user.address, req.body, req.body.length, scanned.pages,
  ]);
  res.json({ ...result, scan: true, file: token, size: req.body.length });
}));

app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

// ---------- browsing ----------

app.get('/', wrap(async (req, res) => {
  const [{ rows: top }, { rows: fresh }, { rows: shelves }, { rows: count }] = await Promise.all([
    pool.query(`SELECT * FROM (SELECT ${LIST_FIELDS} ${LIST_FROM} WHERE NOT r.removed) t WHERE t.recs > 0 ORDER BY t.recs DESC, t.id DESC LIMIT 5`),
    pool.query(`SELECT ${LIST_FIELDS} ${LIST_FROM} WHERE NOT r.removed ORDER BY r.id DESC LIMIT 8`),
    pool.query(
      `SELECT s.slug, s.name, s.blurb, (SELECT COUNT(*)::int FROM readings r WHERE r.shelf_slug = s.slug AND NOT r.removed) AS count
       FROM shelves s ORDER BY s.position, s.name`
    ),
    pool.query(`UPDATE meta SET value = (value::bigint + 1)::text WHERE key = 'visitors' RETURNING value`),
  ]);
  await page(req, res, '', views.home({ top, fresh, shelves, user: req.user }), { visitors: count[0] ? count[0].value : 0 });
}));

app.get('/shelf/:slug', wrap(async (req, res) => {
  const { rows: shelves } = await pool.query('SELECT slug, name, blurb FROM shelves WHERE slug = $1', [req.params.slug]);
  if (!shelves[0]) throw new HttpError(404, 'There is no such shelf');
  const l = listing(req);
  const list = await listReadings('r.shelf_slug = $1 AND NOT r.removed', [shelves[0].slug], l);
  await page(req, res, shelves[0].name, views.shelf({ shelf: shelves[0], ...list, ...l }), { shelf: shelves[0].slug });
}));

app.get('/all', wrap(async (req, res) => {
  const l = listing(req);
  const list = await listReadings('NOT r.removed', [], l);
  await page(req, res, 'All readings', views.list({ heading: 'All readings', base: '/all', ...list, ...l }));
}));

app.get('/tag/:tag', wrap(async (req, res) => {
  const tag = slugify(req.params.tag, '');
  if (!tag) throw new HttpError(404, 'There is no such tag');
  const l = listing(req);
  const list = await listReadings('r.tags @> ARRAY[$1]::text[] AND NOT r.removed', [tag], l);
  await page(req, res, `Tagged ${tag}`, views.list({ heading: `Tagged #${tag}`, base: `/tag/${tag}`, empty: 'Nothing carries this tag yet.', ...list, ...l }));
}));

app.get('/by/:address', wrap(async (req, res) => {
  const address = String(req.params.address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new HttpError(404, 'Not found');
  const l = listing(req);
  const list = await listReadings('r.contributor = $1 AND NOT r.removed', [address], l);
  await page(req, res, 'Contributions', views.list({
    heading: 'Contributed by', intro: address, base: `/by/${address}`, notice: notice(req), empty: 'This wallet has not contributed a reading yet.', ...list, ...l,
  }));
}));

app.get('/search', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const l = listing(req);
  let list = { readings: [], more: false };
  if (q) {
    rateLimit(`search:${req.ip}`, 60, 60_000);
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    list = await listReadings(
      'NOT r.removed AND (r.title ILIKE $1 OR r.author ILIKE $1 OR r.note ILIKE $1 OR r.body ILIKE $1 OR $2 = ANY(r.tags))',
      [like, slugify(q, '')], l
    );
  }
  await page(req, res, 'Search', views.search({ q, ...list, ...l }));
}));

async function loadReading(slug) {
  const { rows } = await pool.query(`SELECT ${LIST_FIELDS}, r.source_url, r.body, r.updated_at ${LIST_FROM} WHERE r.slug = $1`, [slug]);
  return rows[0];
}

// The scanned PDF attached to a reading, as uploaded. It is someone else's file, so it is
// served as a PDF and nothing else, with its own locked-down policy.
app.get('/reading/:slug/scan.pdf', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT f.data, r.removed FROM files f JOIN readings r ON r.id = f.reading_id WHERE r.slug = $1', [req.params.slug]
  );
  if (!rows[0] || (rows[0].removed && !req.isLibrarian)) throw new HttpError(404, 'There is no such file');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.slug.replace(/[^a-z0-9-]/g, '')}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(rows[0].data);
}));

const canEdit = (req, reading) => Boolean(req.user && (req.isLibrarian || req.user.address === reading.contributor));

app.get('/reading/:slug', wrap(async (req, res) => {
  const reading = await loadReading(req.params.slug);
  // A removed reading is still there for librarians, so they can put it back.
  if (!reading || (reading.removed && !req.isLibrarian)) throw new HttpError(404, 'There is no such reading on the shelves');
  const [{ rows: comments }, { rows: mine }] = await Promise.all([
    pool.query('SELECT id, address, body, created_at FROM comments WHERE reading_id = $1 AND NOT removed ORDER BY id', [reading.id]),
    req.user
      ? pool.query('SELECT 1 FROM recommendations WHERE reading_id = $1 AND address = $2', [reading.id, req.user.address])
      : Promise.resolve({ rows: [] }),
  ]);
  await page(req, res, reading.title, views.reading({
    reading, comments, user: req.user, isLibrarian: req.isLibrarian,
    recommended: Boolean(mine[0]), canEdit: canEdit(req, reading), notice: notice(req),
  }), { shelf: reading.shelf_slug });
}));

// ---------- contributing ----------

async function shelfList() {
  const { rows } = await pool.query('SELECT slug, name FROM shelves ORDER BY position, name');
  return rows;
}

app.get('/contribute', wrap(async (req, res) => {
  await page(req, res, 'Contribute a reading', views.contribute({ user: req.user, shelves: await shelfList(), maxChars: MAX_BODY_CHARS }));
}));

async function readingForm(body, { hasFile = false } = {}) {
  const fields = {
    title: cleanText(body.title, 'The title', 200),
    author: cleanText(body.author, 'The author', 200),
    year: cleanText(body.year, 'The year', 20, { required: false }),
    source_url: cleanUrl(body.source_url),
    note: cleanText(body.note, 'Your note', 1500),
    // A reading with a scanned PDF attached can leave the text empty.
    body: cleanText(body.body, 'The text', MAX_BODY_CHARS, { required: !hasFile }),
    tags: cleanTags(body.tags),
    shelf_slug: typeof body.shelf === 'string' ? body.shelf : '',
  };
  const { rows } = await pool.query('SELECT 1 FROM shelves WHERE slug = $1', [fields.shelf_slug]);
  if (!rows[0]) throw new HttpError(400, 'Choose a shelf for the reading');
  fields.words = countWords(fields.body);
  return fields;
}

app.post('/contribute', wrap(async (req, res) => {
  const user = requireUser(req);
  rateLimit(`add:${user.address}`, 10, 3600_000);
  if (req.body.rights !== 'yes') throw new HttpError(400, 'Tick the box to confirm this text is free to share here');
  // A scanned PDF uploaded a moment ago, waiting to be attached to this reading.
  let fileId = null;
  if (typeof req.body.file === 'string' && req.body.file) {
    const { rows } = await pool.query('SELECT id FROM files WHERE token = $1 AND contributor = $2 AND reading_id IS NULL', [req.body.file, user.address]);
    if (!rows[0]) throw new HttpError(400, 'The uploaded PDF is no longer waiting. Upload it again.');
    fileId = rows[0].id;
  }
  const f = await readingForm(req.body, { hasFile: Boolean(fileId) });
  const base = slugify(f.title);
  for (let attempt = 0; ; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt < 4 ? attempt + 1 : crypto.randomBytes(3).toString('hex')}`;
    const { rows } = await pool.query(
      `INSERT INTO readings (slug, title, author, year, source_url, shelf_slug, note, body, tags, words, contributor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (slug) DO NOTHING RETURNING id, slug`,
      [slug, f.title, f.author, f.year, f.source_url, f.shelf_slug, f.note, f.body, f.tags, f.words, user.address]
    );
    if (rows[0]) {
      if (fileId) await pool.query('UPDATE files SET reading_id = $1 WHERE id = $2 AND reading_id IS NULL', [rows[0].id, fileId]);
      return res.redirect(303, `/reading/${rows[0].slug}?n=added`);
    }
    if (attempt > 8) throw new HttpError(500, 'Could not shelve that reading, please try again');
  }
}));

async function editable(req) {
  requireUser(req);
  const reading = await loadReading(req.params.slug);
  if (!reading || (reading.removed && !req.isLibrarian)) throw new HttpError(404, 'There is no such reading on the shelves');
  if (!canEdit(req, reading)) throw new HttpError(403, 'Only the contributor or a librarian can change this reading');
  return reading;
}

app.get('/reading/:slug/edit', wrap(async (req, res) => {
  const reading = await editable(req);
  await page(req, res, `Edit ${reading.title}`, views.edit({ reading, shelves: await shelfList(), maxChars: MAX_BODY_CHARS }));
}));

app.post('/reading/:slug/edit', wrap(async (req, res) => {
  const reading = await editable(req);
  rateLimit(`edit:${req.user.address}`, 30, 3600_000);
  const f = await readingForm(req.body, { hasFile: reading.file_pages !== null });
  await pool.query(
    `UPDATE readings SET title = $1, author = $2, year = $3, source_url = $4, shelf_slug = $5, note = $6, body = $7, tags = $8, words = $9, updated_at = now()
     WHERE id = $10`,
    [f.title, f.author, f.year, f.source_url, f.shelf_slug, f.note, f.body, f.tags, f.words, reading.id]
  );
  res.redirect(303, `/reading/${reading.slug}?n=saved`);
}));

// The contributor can take their own reading down; a librarian can take down any.
app.post('/reading/:slug/remove', wrap(async (req, res) => {
  const reading = await editable(req);
  await pool.query('UPDATE readings SET removed = true, removed_by = $1, removed_at = now() WHERE id = $2 AND NOT removed', [req.user.address, reading.id]);
  res.redirect(303, req.isLibrarian ? '/desk?n=removed' : `/by/${req.user.address}?n=removed`);
}));

app.post('/reading/:slug/recommend', wrap(async (req, res) => {
  const user = requireUser(req);
  rateLimit(`rec:${user.address}`, 120, 3600_000);
  const { rows } = await pool.query('SELECT id, slug FROM readings WHERE slug = $1 AND NOT removed', [req.params.slug]);
  if (!rows[0]) throw new HttpError(404, 'There is no such reading on the shelves');
  let n = 'recommended';
  if (req.body.undo === 'yes') {
    await pool.query('DELETE FROM recommendations WHERE reading_id = $1 AND address = $2', [rows[0].id, user.address]);
    n = 'unrecommended';
  } else {
    await pool.query('INSERT INTO recommendations (reading_id, address) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].id, user.address]);
  }
  res.redirect(303, `/reading/${rows[0].slug}?n=${n}#recommend`);
}));

app.post('/reading/:slug/comment', wrap(async (req, res) => {
  const user = requireUser(req);
  rateLimit(`comment:${user.address}`, 20, 600_000);
  const body = cleanText(req.body.body, 'Your comment', 3000);
  const { rows } = await pool.query('SELECT id, slug FROM readings WHERE slug = $1 AND NOT removed', [req.params.slug]);
  if (!rows[0]) throw new HttpError(404, 'There is no such reading on the shelves');
  await pool.query('INSERT INTO comments (reading_id, address, body) VALUES ($1, $2, $3)', [rows[0].id, user.address, body]);
  res.redirect(303, `/reading/${rows[0].slug}?n=commented#comments`);
}));

// A comment can be removed by whoever wrote it, or by a librarian.
app.post('/comment/:id/remove', wrap(async (req, res) => {
  const user = requireUser(req);
  const id = intParam(req.params.id);
  const { rows } = await pool.query(
    `UPDATE comments c SET removed = true, removed_by = $1 FROM readings r
     WHERE c.id = $2 AND r.id = c.reading_id AND NOT c.removed AND (c.address = $1 OR $3::boolean) RETURNING r.slug`,
    [user.address, id, req.isLibrarian]
  );
  if (!rows[0]) throw new HttpError(404, 'There is no such comment');
  res.redirect(303, `/reading/${rows[0].slug}?n=comment-removed#comments`);
}));

// ---------- librarians' desk ----------

app.get('/desk', wrap(async (req, res) => {
  requireLibrarian(req);
  const [{ rows: removed }, { rows: shelves }, { rows: librarians }, { rows: totals }] = await Promise.all([
    pool.query(`SELECT ${LIST_FIELDS} ${LIST_FROM} WHERE r.removed ORDER BY r.removed_at DESC NULLS LAST LIMIT 200`),
    pool.query(
      `SELECT s.slug, s.name, s.blurb, s.position, (SELECT COUNT(*)::int FROM readings r WHERE r.shelf_slug = s.slug) AS count
       FROM shelves s ORDER BY s.position, s.name`
    ),
    pool.query('SELECT address, added_by, created_at FROM librarians ORDER BY created_at'),
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM readings WHERE NOT removed) AS readings,
              (SELECT COUNT(DISTINCT contributor)::int FROM readings WHERE NOT removed) AS contributors,
              (SELECT COUNT(*)::int FROM recommendations) AS recs,
              (SELECT COUNT(*)::int FROM comments WHERE NOT removed) AS comments`
    ),
  ]);
  await page(req, res, "Librarians' desk", views.desk({ removed, shelves, librarians, totals: totals[0], me: req.user.address, notice: notice(req) }));
}));

app.post('/desk/reading/:id/restore', wrap(async (req, res) => {
  requireLibrarian(req);
  await pool.query('UPDATE readings SET removed = false, removed_by = NULL, removed_at = NULL WHERE id = $1', [intParam(req.params.id)]);
  res.redirect(303, '/desk?n=restored');
}));

// Only a reading that is already off the shelf can be deleted for good.
app.post('/desk/reading/:id/delete', wrap(async (req, res) => {
  requireLibrarian(req);
  await pool.query('DELETE FROM readings WHERE id = $1 AND removed', [intParam(req.params.id)]);
  res.redirect(303, '/desk?n=deleted');
}));

app.post('/desk/shelves', wrap(async (req, res) => {
  requireLibrarian(req);
  const name = cleanText(req.body.name, 'The shelf name', 40);
  const blurb = cleanText(req.body.blurb, 'The description', 200, { required: false });
  const slug = slugify(name, '');
  if (!slug) throw new HttpError(400, 'The shelf name needs some letters or numbers');
  const { rows } = await pool.query(
    `INSERT INTO shelves (slug, name, blurb, position) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), 0) + 1 FROM shelves))
     ON CONFLICT DO NOTHING RETURNING slug`,
    [slug, name, blurb]
  );
  if (!rows[0]) throw new HttpError(400, 'There is already a shelf with that name');
  res.redirect(303, '/desk?n=shelf-added');
}));

app.post('/desk/shelves/:slug', wrap(async (req, res) => {
  requireLibrarian(req);
  const name = cleanText(req.body.name, 'The shelf name', 40);
  const blurb = cleanText(req.body.blurb, 'The description', 200, { required: false });
  const position = /^[0-9]{1,4}$/.test(String(req.body.position)) ? Number(req.body.position) : 0;
  await pool.query('UPDATE shelves SET name = $1, blurb = $2, position = $3 WHERE slug = $4', [name, blurb, position, req.params.slug]);
  res.redirect(303, '/desk?n=shelf-saved');
}));

app.post('/desk/shelves/:slug/remove', wrap(async (req, res) => {
  requireLibrarian(req);
  const { rows } = await pool.query(
    'DELETE FROM shelves s WHERE s.slug = $1 AND NOT EXISTS (SELECT 1 FROM readings r WHERE r.shelf_slug = s.slug) RETURNING slug',
    [req.params.slug]
  );
  res.redirect(303, `/desk?n=${rows[0] ? 'shelf-removed' : 'shelf-not-empty'}`);
}));

app.post('/desk/librarians', wrap(async (req, res) => {
  requireLibrarian(req);
  const address = String(req.body.address || '').trim();
  if (!isAddress(address)) throw new HttpError(400, 'That is not a wallet address');
  await pool.query('INSERT INTO librarians (address, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [address.toLowerCase(), req.user.address]);
  res.redirect(303, '/desk?n=librarian-added');
}));

app.post('/desk/librarians/remove', wrap(async (req, res) => {
  requireLibrarian(req);
  const address = String(req.body.address || '').toLowerCase();
  if (address === req.user.address) throw new HttpError(400, 'You cannot remove yourself; ask another librarian');
  await pool.query('DELETE FROM librarians WHERE address = $1', [address]);
  res.redirect(303, '/desk?n=librarian-removed');
}));

// ---------- errors ----------

app.use((req, res, next) => next(new HttpError(404, 'There is nothing at this address')));

app.use((err, req, res, next) => {
  let status = err instanceof HttpError ? err.status : 500;
  let text = err instanceof HttpError ? err.message : 'Something went wrong';
  if (err.type === 'entity.parse.failed') { status = 400; text = 'That request could not be read'; }
  if (err.type === 'entity.too.large') { status = 413; text = req.path.startsWith('/api/import') ? 'That PDF is too large (up to 15 MB)' : `That is too large (a reading can be up to ${MAX_BODY_CHARS.toLocaleString('en')} characters)`; }
  if (err.type === 'parameters.too.many') { status = 400; text = 'That request could not be read'; }
  if (status === 500) console.error(err);
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: text });
  const heading = status === 404 ? 'Page not found' : status === 401 ? 'Sign in first' : 'Something went wrong';
  const signIn = status === 401;
  const posted = req.method === 'POST';
  // After signing in from a failed form post, go back to the page the form was on.
  let goto = '';
  if (signIn && posted) {
    goto = '/';
    try {
      const from = new URL(req.get('referer') || '');
      if (from.host === requestHost(req)) goto = from.pathname;
    } catch {}
  }
  page(req, res, heading, views.message({ heading, text, signIn, goto, back: posted && status !== 404 && !signIn }), { status }).catch(() => res.status(status).type('text').send(text));
});

// ---------- start ----------

init()
  .then(() => {
    // Tidy up old sign-in requests and sessions every hour.
    setInterval(() => {
      pool.query(`DELETE FROM nonces WHERE created_at < now() - interval '1 day'`).catch(() => {});
      pool.query(`DELETE FROM sessions WHERE expires_at < now()`).catch(() => {});
      pool.query(`DELETE FROM files WHERE reading_id IS NULL AND created_at < now() - interval '1 day'`).catch(() => {});
    }, 3600_000).unref();
    app.listen(PORT, () => console.log(`library listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
