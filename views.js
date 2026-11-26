// Server-rendered pages. Every value that comes from the database goes through esc(),
// except a reading's text, which goes through render() in text.js (it escapes first).
// The site's Content-Security-Policy forbids inline styles, so all styling is by class.

const { render, esc } = require('./text');

const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (date) => {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

const paragraphs = (text) =>
  String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

function teaser(text, max = 220) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function readingTime(words) {
  if (!words) return '';
  const minutes = Math.max(1, Math.round(words / 230));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function recommendCount(n) {
  if (n === 0) return 'No recommendations yet';
  return n === 1 ? '1 reader recommends this' : `${n} readers recommend this`;
}

const who = (address) => `<a href="/by/${esc(address)}"><code>${esc(short(address))}</code></a>`;
const tagLinks = (tags) => (tags || []).map((t) => `<a class="tag" href="/tag/${esc(t)}">#${esc(t)}</a>`).join('');
const byline = (r) => `${esc(r.author)}${r.year ? `, ${esc(r.year)}` : ''}`;
const joined = (parts) => parts.filter(Boolean).map((p, i) => `<span${i ? ' class="sep"' : ''}>${p}</span>`).join('');

// ---------- spine labels ----------

// Each shelf wears a spine label: a three-letter code on a coloured band. The starting
// shelves have fixed colours; shelves added later get one from their name.
const BANDS = 8;
const FIRST_BANDS = { cypherpunk: 0, money: 1, governance: 2, 'network-states': 3, protocols: 4, culture: 5, alternet: 6 };

function band(slug) {
  if (Object.hasOwn(FIRST_BANDS, slug)) return FIRST_BANDS[slug];
  let h = 0;
  for (const ch of String(slug)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % BANDS;
}

function shelfCode(name) {
  const letters = String(name).replace(/^the\s+/i, '').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 3) || 'LIB').toUpperCase();
}

function label(s, current) {
  return `<a class="label" href="/shelf/${esc(s.slug)}"${current ? ' aria-current="page"' : ''}><span class="label-code band-${band(s.slug)}">${esc(shelfCode(s.name))}</span><span class="label-name">${esc(s.name)}</span></a>`;
}

// ---------- page furniture ----------

function box(heading, inner, attrs = '') {
  return `<section class="box"${attrs}>${heading ? `<h1 class="bar">${esc(heading)}</h1>` : ''}${inner}</section>`;
}

const note = (text) => (text ? `<section class="box note" role="status">${esc(text)}</section>` : '');

function signInBox(text, goto) {
  return `<p>${esc(text)}</p>
    <button type="button" class="btn primary" data-action="signin"${goto ? ` data-goto="${esc(goto)}"` : ''}>Sign in with your wallet</button>
    <div class="msg" data-msg aria-live="polite"></div>`;
}

function layout({ title, shelves, user, isLibrarian, visitors, networkLabel, currentShelf, body }) {
  const whoami = user
    ? `<div class="who"><div class="wrap">Signed in as <a href="/by/${esc(user.address)}"><code>${esc(short(user.address))}</code></a>${isLibrarian ? `<span class="sep"><a href="/desk">Librarians' desk</a></span>` : ''}<span class="sep"><button type="button" class="linkish" data-action="signout">Sign out</button></span></div></div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="masthead">
  <div class="wrap">
    <div>
      <a href="/" class="brand-name">Alternet Library</a>
      <div class="brand-sub">Readings from the community. Now on ${esc(networkLabel)}.</div>
    </div>
    <nav class="site-nav" aria-label="Library">
      <a href="/all">All readings</a>
      <a href="/search">Search</a>
      <a class="cta" href="/contribute">Contribute a reading</a>
    </nav>
  </div>
</header>
<nav class="shelfbar" aria-label="Shelves">
  <div class="wrap">
    ${shelves.map((s) => label(s, s.slug === currentShelf)).join('\n    ')}
  </div>
</nav>
${whoami}
<main class="wrap main">
  ${body}
</main>
<footer class="footer">
  <div class="wrap">
    <span>Open shelves: anyone with a wallet can add a reading. Share only what is free to share.${visitors === undefined ? '' : ` Reader no. ${esc(visitors)}.`}</span>
    <span><a href="https://wyd.silos.alternet.sh">wyd</a><span class="sep"><a href="https://museum.silos.alternet.sh">Museum</a></span><span class="sep"><a href="https://silos.alternet.sh">SILOS</a></span></span>
  </div>
</footer>
<script src="/wallet.js" defer></script>
<script src="/import.js" defer></script>
</body>
</html>`;
}

// ---------- lists ----------

function entry(r, { shelf = true } = {}) {
  const meta = [
    r.recs ? plural(r.recs, 'recommendation') : '',
    r.comment_count ? plural(r.comment_count, 'comment') : '',
    readingTime(r.words) ? `${readingTime(r.words)} read` : '',
    shelf ? `<a href="/shelf/${esc(r.shelf_slug)}">${esc(r.shelf_name)}</a>` : '',
    `Shelved ${day(r.created_at)} by ${who(r.contributor)}`,
  ];
  return `<li>
    <div><a class="entry-title" href="/reading/${esc(r.slug)}">${esc(r.title)}</a></div>
    <div class="entry-by">${byline(r)}</div>
    <p>${esc(teaser(r.note))}</p>
    <div class="meta">${joined(meta)}</div>
    ${r.tags && r.tags.length ? `<div class="meta">${tagLinks(r.tags)}</div>` : ''}
  </li>`;
}

const entries = (readings, opts) => `<ul class="entries">${readings.map((r) => entry(r, opts)).join('\n')}</ul>`;

function sorter(base, sort, query = '') {
  const link = (key, text) => (sort === key ? `<b>${text}</b>` : `<a href="${esc(base)}?${query}sort=${key}">${text}</a>`);
  return `<div class="sorter">Sort by ${link('new', 'newest')} or ${link('top', 'most recommended')}</div>`;
}

function pager(base, { sort, pageNo, more }, query = '') {
  if (pageNo === 1 && !more) return '';
  const href = (p) => `${esc(base)}?${query}sort=${sort}&amp;p=${p}`;
  return `<div class="pager">
    <span>${pageNo > 1 ? `<a href="${href(pageNo - 1)}">Previous page</a>` : ''}</span>
    <span>${more ? `<a href="${href(pageNo + 1)}">Next page</a>` : ''}</span>
  </div>`;
}

function home({ top, fresh, shelves, user }) {
  const welcome = `<section class="box welcome">Texts that people here found worth their time and want you to read too. Every reading is kept in full, with a note from whoever shelved it. Read, recommend, argue in the comments, and <a href="/contribute">add your own</a>.</section>`;
  const best = top.length ? box('Most recommended', entries(top)) : '';
  const latest = box(
    'New on the shelves',
    fresh.length
      ? `${entries(fresh)}<div class="pager"><span></span><span><a href="/all">All readings</a></span></div>`
      : `<p class="lede">The shelves are empty. <a href="/contribute">Contribute the first reading</a>${user ? '' : ' (you will need a wallet)'}.</p>`
  );
  const list = box(
    'The shelves',
    `<ul class="shelves">${shelves
      .map((s) => `<li>${label(s)}<p>${esc(s.blurb)}<br><span class="meta">${plural(s.count, 'reading')}</span></p></li>`)
      .join('')}</ul>`
  );
  return [welcome, best, latest, list].filter(Boolean).join('\n  ');
}

function shelf({ shelf: s, readings, more, sort, pageNo }) {
  const base = `/shelf/${s.slug}`;
  return box(
    s.name,
    `<p class="lede">${esc(s.blurb)}</p>
    ${readings.length
      ? `${sorter(base, sort)}${entries(readings, { shelf: false })}${pager(base, { sort, pageNo, more })}`
      : `<p>Nothing on this shelf yet. <a href="/contribute">Contribute a reading</a>.</p>`}`
  );
}

function list({ heading, intro, base, empty, readings, more, sort, pageNo, notice: n }) {
  return `${note(n)}${box(
    heading,
    `${intro ? `<p class="meta"><code>${esc(intro)}</code></p>` : ''}
    ${readings.length
      ? `${sorter(base, sort)}${entries(readings)}${pager(base, { sort, pageNo, more })}`
      : `<p>${esc(empty || 'Nothing here yet.')} <a href="/contribute">Contribute a reading</a>.</p>`}`
  )}`;
}

function search({ q, readings, more, sort, pageNo }) {
  const query = `q=${encodeURIComponent(q)}&amp;`;
  const form = `<form class="search" method="get" action="/search" role="search">
      <input type="search" name="q" value="${esc(q)}" maxlength="100" aria-label="Search the library" placeholder="Title, author, tag or words from the text">
      <button class="btn primary" type="submit">Search</button>
    </form>`;
  let results = '';
  if (q) {
    results = readings.length
      ? `<p class="meta">&nbsp;</p>${sorter('/search', sort, query)}${entries(readings)}${pager('/search', { sort, pageNo, more }, query)}`
      : `<p class="lede"><br>Nothing found for "${esc(q)}".</p>`;
  }
  return box('Search the library', `${form}${results}`);
}

// ---------- a reading ----------

function reading({ reading: r, comments, user, isLibrarian, recommended, canEdit, notice: n }) {
  const removed = r.removed
    ? `<section class="box note" role="status"><b>Off the shelf.</b> Removed ${r.removed_at ? day(r.removed_at) : ''} by <code>${esc(short(r.removed_by))}</code>. Only librarians can see this page. Restore or delete it from the <a href="/desk">desk</a>.</section>`
    : '';

  const facts = [
    ['Author', esc(r.author)],
    r.year ? ['Year', esc(r.year)] : null,
    ['Shelf', `<a href="/shelf/${esc(r.shelf_slug)}">${esc(r.shelf_name)}</a>`],
    ['Length', `${r.words.toLocaleString('en')} words${readingTime(r.words) ? `, ${readingTime(r.words)}` : ''}`],
    r.source_url ? ['Source', `<a href="${esc(r.source_url)}" rel="noopener nofollow ugc">${esc(teaser(r.source_url.replace(/^https?:\/\//, ''), 48))}</a>`] : null,
    r.tags.length ? ['Tags', tagLinks(r.tags)] : null,
    ['Shelved', `${day(r.created_at)} by ${who(r.contributor)}`],
    day(r.updated_at) !== day(r.created_at) ? ['Edited', day(r.updated_at)] : null,
  ].filter(Boolean);

  let control = '';
  if (r.removed) control = '';
  else if (!user) control = `<button type="button" class="btn primary" data-action="signin">Sign in to recommend</button>`;
  else if (recommended) control = `<div>You recommend this.</div><form method="post" action="/reading/${esc(r.slug)}/recommend"><input type="hidden" name="undo" value="yes"><button class="btn" type="submit">Withdraw</button></form>`;
  else control = `<form method="post" action="/reading/${esc(r.slug)}/recommend"><button class="btn primary" type="submit">Recommend this reading</button></form>`;

  const record = `<aside class="record" aria-label="About this reading">
    <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="slip" id="recommend">
      <div class="count">${recommendCount(r.recs)}</div>
      ${control}
      <div class="hint">One wallet, one recommendation.</div>
      <div class="msg" data-msg aria-live="polite"></div>
    </div>
    ${canEdit && !r.removed
      ? `<div class="actions">
          <a class="btn" href="/reading/${esc(r.slug)}/edit">Edit</a>
          <form method="post" action="/reading/${esc(r.slug)}/remove"><button class="btn" type="submit">Take off the shelf</button></form>
        </div>`
      : ''}
  </aside>`;

  const thread = comments.length
    ? `<ul class="comments">${comments
        .map((c) => `<li id="c${c.id}">
          ${paragraphs(c.body)}
          <div class="meta">${joined([
            `${who(c.address)}${c.address === r.contributor ? ' (contributor)' : ''}`,
            day(c.created_at),
            user && (isLibrarian || user.address === c.address)
              ? `<form method="post" action="/comment/${c.id}/remove"><button class="linkish" type="submit">Remove</button></form>`
              : '',
          ])}</div>
        </li>`)
        .join('\n')}</ul>`
    : '<p>No comments yet.</p>';
  let commentForm = '';
  if (!r.removed) {
    commentForm = user
      ? `<form class="form wide" method="post" action="/reading/${esc(r.slug)}/comment">
          <label for="comment">Add a comment</label>
          <textarea id="comment" name="body" maxlength="3000" required></textarea>
          <button class="btn" type="submit">Post comment</button>
        </form>`
      : `<button type="button" class="btn" data-action="signin">Sign in to comment</button><div class="msg" data-msg aria-live="polite"></div>`;
  }

  const main = `<div class="reading-main">
    <h1>${esc(r.title)}</h1>
    <div class="why">
      <h2>Why read this</h2>
      ${paragraphs(r.note)}
    </div>
    <article class="text">${render(r.body)}</article>
    <section class="discussion" id="comments">
      <h2>Comments (${comments.length})</h2>
      ${thread}${commentForm}
    </section>
  </div>`;

  return [note(n), removed, `<div class="reading">${record}${main}</div>`].filter(Boolean).join('\n  ');
}

// ---------- contributing ----------

const MARKUP_HELP = `<details>
    <summary>How to format the text</summary>
    <p class="hint">Plain text works as it is: leave a blank line between paragraphs. If you want more:</p>
    <table class="help">
      <tr><th scope="row"># Heading</th><td>a heading (## and ### for smaller ones)</td></tr>
      <tr><th scope="row">&gt; quoted</th><td>a quotation</td></tr>
      <tr><th scope="row">- item</th><td>a list (1. for a numbered one)</td></tr>
      <tr><th scope="row">---</th><td>a dividing rule</td></tr>
      <tr><th scope="row">*word* **word**</th><td><i>italic</i> and <b>bold</b></td></tr>
      <tr><th scope="row">\`\`\`</th><td>on a line of its own, before and after verse or code, to keep line breaks</td></tr>
    </table>
    <p class="hint">Web addresses starting with https:// become links. Pictures and other HTML are not supported.</p>
  </details>`;

function readingFields({ r = {}, shelves, maxChars }) {
  const value = (v) => esc(v || '');
  return `
    <label for="title">Title</label>
    <input id="title" name="title" maxlength="200" required value="${value(r.title)}">
    <label for="author">Author</label>
    <input id="author" name="author" maxlength="200" required value="${value(r.author)}">
    <label for="year">Year <span class="hint">(optional)</span></label>
    <input id="year" name="year" maxlength="20" value="${value(r.year)}">
    <label for="shelf">Shelf</label>
    <select id="shelf" name="shelf" required>
      ${r.shelf_slug ? '' : '<option value="">Choose a shelf…</option>'}
      ${shelves.map((s) => `<option value="${esc(s.slug)}"${s.slug === r.shelf_slug ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>
    <label for="tags">Tags <span class="hint">(optional, up to 5, separated by commas)</span></label>
    <input id="tags" name="tags" maxlength="150" value="${value((r.tags || []).join(', '))}">
    <label for="source_url">Where it comes from <span class="hint">(optional link to the original)</span></label>
    <input id="source_url" name="source_url" type="url" maxlength="500" placeholder="https://" value="${value(r.source_url)}">
    <label for="note">Why read this? <span class="hint">Your note to the community. It is shown above the text and in every list.</span></label>
    <textarea id="note" name="note" maxlength="1500" required>${value(r.note)}</textarea>
    <label for="body">The full text <span class="hint">(up to ${maxChars.toLocaleString('en')} characters)</span></label>
    <textarea id="body" class="long" name="body" maxlength="${maxChars}" required>${value(r.body)}</textarea>
    ${MARKUP_HELP}`;
}

function contribute({ user, shelves, maxChars }) {
  if (!user) {
    return box('Contribute a reading', signInBox('Anyone with a wallet can add a reading to the library. Signing in only proves you own the address; it costs nothing and sends no transaction.'));
  }
  return box(
    'Contribute a reading',
    `<p class="lede">Add a text you think the community should read. It goes on the shelf straight away, under your wallet address <code>${esc(short(user.address))}</code>. You can edit it or take it down later.</p>
    <section class="importer" aria-labelledby="import-h">
      <h2 id="import-h">Start from a link or a PDF</h2>
      <p class="hint">The library pulls out the text and fills in the form below. Nothing is shelved until you have checked it and pressed the button at the bottom. The page or file itself is not kept.</p>
      <div class="importer-row">
        <label for="import-url">Web address</label>
        <div class="search"><input id="import-url" type="url" maxlength="2000" placeholder="https://"><button type="button" class="btn" data-import="link">Fetch the text</button></div>
      </div>
      <div class="importer-row">
        <label for="import-pdf">PDF file <span class="hint">(up to 15 MB, with real text rather than scanned pages)</span></label>
        <input id="import-pdf" type="file" accept="application/pdf,.pdf" data-import="pdf">
      </div>
      <div class="msg" data-import-msg role="status" aria-live="polite"></div>
    </section>
    <form class="form wide" method="post" action="/contribute">
      ${readingFields({ shelves, maxChars })}
      <label class="check"><input type="checkbox" name="rights" value="yes" required> <span>This text is free to share here: it is my own, in the public domain, or under a licence that allows it.</span></label>
      <button class="btn primary" type="submit">Put it on the shelf</button>
    </form>`
  );
}

function edit({ reading: r, shelves, maxChars }) {
  return box(
    'Edit reading',
    `<form class="form wide" method="post" action="/reading/${esc(r.slug)}/edit">
      ${readingFields({ r, shelves, maxChars })}
      <div class="actions"><button class="btn primary" type="submit">Save</button> <a href="/reading/${esc(r.slug)}">Cancel</a></div>
    </form>`
  );
}

// ---------- librarians' desk ----------

function desk({ removed, shelves, librarians, totals, me, notice: n }) {
  const counts = box(
    "Librarians' desk",
    `<p class="lede">The library holds ${plural(totals.readings, 'reading')} from ${plural(totals.contributors, 'contributor')}, with ${plural(totals.recs, 'recommendation')} and ${plural(totals.comments, 'comment')}.</p>
    <p>To take a reading or a comment down, open its page: librarians see the controls on every one.</p>`
  );

  const off = box(
    'Off the shelf',
    removed.length
      ? `<div class="scroll"><table class="grid">
          <tr><th>Reading</th><th>Contributor</th><th>Removed</th><th></th></tr>
          ${removed
            .map((r) => `<tr>
              <td><a href="/reading/${esc(r.slug)}">${esc(r.title)}</a><br>${byline(r)}</td>
              <td><code>${esc(short(r.contributor))}</code></td>
              <td>${r.removed_at ? day(r.removed_at) : ''} by <code>${esc(short(r.removed_by))}</code>${r.removed_by === r.contributor ? ' (the contributor)' : ''}</td>
              <td><div class="actions">
                <form method="post" action="/desk/reading/${r.id}/restore"><button class="btn" type="submit">Put back</button></form>
                <details><summary>Delete…</summary><form method="post" action="/desk/reading/${r.id}/delete"><p class="hint">This erases the text, its recommendations and comments. It cannot be undone.</p><button class="btn" type="submit">Delete for good</button></form></details>
              </div></td>
            </tr>`)
            .join('')}
        </table></div>`
      : '<p>Nothing has been taken off the shelves.</p>'
  );

  const shelfRows = shelves
    .map((s) => `<tr>
      <td><input form="shelf-${esc(s.slug)}" name="name" maxlength="40" required value="${esc(s.name)}" aria-label="Name"></td>
      <td><input form="shelf-${esc(s.slug)}" name="blurb" maxlength="200" value="${esc(s.blurb)}" aria-label="Description"></td>
      <td><input form="shelf-${esc(s.slug)}" class="narrow" name="position" inputmode="numeric" maxlength="4" value="${s.position}" aria-label="Order"></td>
      <td>${s.count}</td>
      <td><div class="actions">
        <form id="shelf-${esc(s.slug)}" method="post" action="/desk/shelves/${esc(s.slug)}"><button class="btn" type="submit">Save</button></form>
        ${s.count === 0 ? `<form method="post" action="/desk/shelves/${esc(s.slug)}/remove"><button class="btn" type="submit">Remove</button></form>` : ''}
      </div></td>
    </tr>`)
    .join('');
  const shelfBox = box(
    'Shelves',
    `<div class="scroll"><table class="grid">
      <tr><th>Name</th><th>Description</th><th>Order</th><th>Readings</th><th></th></tr>
      ${shelfRows}
    </table></div>
    <form class="form" method="post" action="/desk/shelves">
      <label for="new-shelf">New shelf</label>
      <input id="new-shelf" name="name" maxlength="40" required placeholder="Name">
      <input name="blurb" maxlength="200" placeholder="One line about what belongs on it" aria-label="Description">
      <button class="btn" type="submit">Add shelf</button>
    </form>`
  );

  const people = box(
    'Librarians',
    `<div class="scroll"><table class="grid">
      <tr><th>Wallet</th><th>Since</th><th></th></tr>
      ${librarians
        .map((l) => `<tr><td><code>${esc(l.address)}</code>${l.address === me ? ' (you)' : ''}</td><td>${day(l.created_at)}</td>
          <td>${l.address === me ? '' : `<form method="post" action="/desk/librarians/remove"><input type="hidden" name="address" value="${esc(l.address)}"><button class="btn" type="submit">Remove</button></form>`}</td></tr>`)
        .join('')}
    </table></div>
    <form class="form" method="post" action="/desk/librarians">
      <label for="new-librarian">Add a librarian by wallet address</label>
      <input id="new-librarian" name="address" maxlength="42" required placeholder="0x…">
      <button class="btn" type="submit">Add librarian</button>
    </form>`
  );

  return [note(n), counts, off, shelfBox, people].filter(Boolean).join('\n  ');
}

function message({ heading, text, signIn, goto, back }) {
  return box(
    heading,
    `${signIn ? signInBox(text, goto) : `<p class="lede">${esc(text)}</p>`}
    ${back ? '<p class="hint">Use your browser\'s back button to return to what you were writing; it should still be there.</p>' : ''}
    <p><br><a href="/">Back to the library</a></p>`
  );
}

module.exports = { layout, home, shelf, list, search, reading, contribute, edit, desk, message };
