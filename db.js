const { Pool } = require('pg');
const { isAddress } = require('ethers');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelves (
  slug     TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  blurb    TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS readings (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  year        TEXT NOT NULL DEFAULT '',
  source_url  TEXT NOT NULL DEFAULT '',
  shelf_slug  TEXT NOT NULL REFERENCES shelves(slug),
  -- The contributor's note: why this is worth the community's time.
  note        TEXT NOT NULL,
  -- The full text, in the light markup described on the contribute page.
  body        TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  words       INTEGER NOT NULL DEFAULT 0,
  contributor TEXT NOT NULL,
  -- Open shelf: a reading is public the moment it is added. Removed readings are
  -- hidden from everyone but librarians, who can put them back or delete them.
  removed     BOOLEAN NOT NULL DEFAULT false,
  removed_by  TEXT,
  removed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS readings_shelf_idx ON readings(shelf_slug, id);
CREATE INDEX IF NOT EXISTS readings_contributor_idx ON readings(contributor, id);
CREATE INDEX IF NOT EXISTS readings_tags_idx ON readings USING GIN (tags);

-- One wallet, one recommendation per reading.
CREATE TABLE IF NOT EXISTS recommendations (
  reading_id INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reading_id, address)
);

CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  reading_id INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  body       TEXT NOT NULL,
  removed    BOOLEAN NOT NULL DEFAULT false,
  removed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_reading_idx ON comments(reading_id, id);

CREATE TABLE IF NOT EXISTS librarians (
  address    TEXT PRIMARY KEY,
  added_by   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

INSERT INTO meta (key, value) VALUES ('visitors', '0') ON CONFLICT DO NOTHING;
`;

const FIRST_SHELVES = [
  ['cypherpunk', 'Cypherpunk', 'Privacy, cryptography and the writing that started all this.'],
  ['money', 'Money', 'What money is, where it came from and how it could work.'],
  ['governance', 'Governance', 'Constitutions, voting, law and how people decide things together.'],
  ['network-states', 'Network States', 'Voluntary jurisdictions, exit, and communities that became places.'],
  ['protocols', 'Protocols', 'How the machinery works: chains, consensus, proofs and the old internet.'],
  ['culture', 'Culture', 'Essays, stories and other things worth reading for their own sake.'],
  ['alternet', 'The Alternet', "The network's own documents and writing about it."],
];

async function seed() {
  // The first librarian comes from INITIAL_LIBRARIAN, and only while the list is empty.
  const first = (process.env.INITIAL_LIBRARIAN || '').trim();
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM librarians');
  if (rows[0].n === 0) {
    if (isAddress(first)) {
      await pool.query('INSERT INTO librarians (address, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        first.toLowerCase(), 'INITIAL_LIBRARIAN',
      ]);
      console.log(`First librarian set to ${first}`);
    } else {
      console.warn('No librarians yet: set INITIAL_LIBRARIAN to a wallet address and restart.');
    }
  }

  // The starting shelves, once. Librarians can add, rename and remove shelves afterwards.
  const seeded = await pool.query(`INSERT INTO meta (key, value) VALUES ('seeded', '1') ON CONFLICT DO NOTHING RETURNING key`);
  if (seeded.rows[0]) {
    for (let i = 0; i < FIRST_SHELVES.length; i++) {
      const [slug, name, blurb] = FIRST_SHELVES[i];
      await pool.query('INSERT INTO shelves (slug, name, blurb, position) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [slug, name, blurb, i + 1]);
    }
  }
}

async function init() {
  // The database silo may still be starting when the app boots, so retry for a while.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`Database not ready (${err.code || err.message}), retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await seed();
}

module.exports = { pool, init };
