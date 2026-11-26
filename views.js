// Server-rendered pages. Every value that comes from the database goes through esc(),
// except a reading's text, which goes through render() in text.js (it escapes first).

const { render, esc } = require('./text');

const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '');
const day = (date) => new Date(date).toISOString().slice(0, 10);
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
  return minutes < 60 ? `${minutes} min read` : `${Math.floor(minutes / 60)} h ${minutes % 60} min read`;
}

const who = (address) => `<a href="/by/${esc(address)}"><code>${esc(short(address))}</code></a>`;
const tagLinks = (tags) => (tags || []).map((t) => `<a class="tag" href="/tag/${esc(t)}">#${esc(t)}</a>`).join('');
const byline = (r) => `${esc(r.author)}${r.year ? `, ${esc(r.year)}` : ''}`;

function box(heading, inner, attrs = '') {
  return `<section class="box"${attrs}>${heading ? `<h2 class="bar">${esc(heading)}</h2>` : ''}${inner}</section>`;
}

const note = (text) => (text ? `<section class="box note" role="status">${esc(text)}</section>` : '');

function signInBox(text, goto) {
  return `<p>${esc(text)}</p>
    <button type="button" class="btn" data-action="signin"${goto ? ` data-goto="${esc(goto)}"` : ''}>Sign in with your wallet</button>
    <div class="msg" data-msg aria-live="polite"></div>`;
}

function layout({ title, shelves, user, isLibrarian, visitors, networkLabel, body }) {
  const nav = shelves.map((s) => `<a class="btn" href="/shelf/${esc(s.slug)}">${esc(s.name)}</a>`).join('\n      ');
  const whoami = user
    ? `<div class="who">Signed in as <a href="/by/${esc(user.address)}"><code>${esc(short(user.address))}</code></a>${isLibrarian ? ` · <a href="/desk">librarians' desk</a>` : ''} · <button type="button" class="linkish" data-action="signout">sign out</button></div>`
    : '';
  const counter =
    visitors === undefined
      ? ''
      : `<div>You are reader no. <span class="counter">${String(visitors).padStart(6, '0')}</span></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="page">
  <header class="banner">
    <a href="/" class="banner-title">*** ALTERNET LIBRARY ***</a>
    <div class="banner-sub">readings from the community, for the community :: now on ${esc(networkLabel)}</div>
  </header>
  <nav class="nav" aria-label="Shelves">
      ${nav}
  </nav>
  <nav class="nav" aria-label="Library">
      <a class="btn" href="/all">All readings</a>
      <a class="btn" href="/search">Search</a>
      <a class="btn" href="/contribute"><b>+ Contribute a reading</b></a>
  </nav>
  ${whoami}
  ${body}
  <hr>
  <footer class="footer">
    ${counter}
    <div>Open shelves: anyone with a wallet can add a reading. Please share only what is free to share.</div>
    <div><a href="https://wyd.silos.alternet.sh">&lt;&lt; wyd</a> | <a href="https://museum.silos.alternet.sh">Museum</a> | Alternet webring | <a href="https://silos.alternet.sh">SILOS &gt;&gt;</a></div>
  </footer>
</div>
<script src="/wallet.js" defer></script>
</body>
</html>`;
}

function entry(r, { shelf = true } = {}) {
  const meta = [
    plural(r.recs, 'recommendation'),
    plural(r.comment_count, 'comment'),
    readingTime(r.words),
    shelf ? `<a href="/shelf/${esc(r.shelf_slug)}">${esc(r.shelf_name)}</a>` : '',
    `added ${day(r.created_at)} by ${who(r.contributor)}`,
  ].filter(Boolean);
  return `<li>
    <div><a class="entry-title" href="/reading/${esc(r.slug)}">${esc(r.title)}</a> <span class="entry-by">by ${byline(r)}</span></div>
    <p>${esc(teaser(r.note))}</p>
    <div class="meta">${meta.join(' · ')}</div>
    ${r.tags && r.tags.length ? `<div class="meta">${tagLinks(r.tags)}</div>` : ''}
  </li>`;
}

const entries = (readings, opts) => `<ul class="entries">${readings.map((r) => entry(r, opts)).join('\n')}</ul>`;

function sorter(base, sort, query = '') {
  const link = (key, label) => (sort === key ? `<b>${label}</b>` : `<a href="${esc(base)}?${query}sort=${key}">${label}</a>`);
  return `<div class="sorter">Sort: ${link('new', 'newest')} | ${link('top', 'most recommended')}</div>`;
}

function pager(base, { sort, pageNo, more }, query = '') {
  if (pageNo === 1 && !more) return '';
  const href = (p) => `${esc(base)}?${query}sort=${sort}&amp;p=${p}`;
  return `<div class="pager">
    <span>${pageNo > 1 ? `<a href="${href(pageNo - 1)}">&lt;&lt; previous page</a>` : ''}</span>
    <span>${more ? `<a href="${href(pageNo + 1)}">next page &gt;&gt;</a>` : ''}</span>
  </div>`;
}

function home({ top, fresh, shelves, user }) {
  const welcome = `<section class="box welcome"><b>Welcome, reader!</b> This is the Alternet Library: texts that people here found worth their time and want you to read too. Every reading is kept in full, with a note from whoever shelved it. Read, recommend, argue in the comments, and <a href="/contribute">add your own</a>.</section>`;
  const best = top.length ? box('MOST RECOMMENDED', entries(top)) : '';
  const latest = box(
    'NEW ON THE SHELVES',
    fresh.length
      ? `${entries(fresh)}<div class="pager"><span></span><span><a href="/all">all readings &gt;&gt;</a></span></div>`
      : `<p>The shelves are empty. Be the first: <a href="/contribute">contribute a reading</a>${user ? '' : ' (you will need a wallet)'}.</p>`
  );
  const list = box(
    'THE SHELVES',
    `<ol class="shelves">${shelves
      .map((s) => `<li><a href="/shelf/${esc(s.slug)}"><b>${esc(s.name)}</b></a> (${plural(s.count, 'reading')})<br>${esc(s.blurb)}</li>`)
      .join('')}</ol>`
  );
  return [welcome, best, latest, list].filter(Boolean).join('\n  ');
}

function shelf({ shelf: s, readings, more, sort, pageNo }) {
  const base = `/shelf/${s.slug}`;
  return box(
    `SHELF: ${s.name.toUpperCase()}`,
    `<p class="lede">${esc(s.blurb)}</p>
    ${readings.length
      ? `${sorter(base, sort)}${entries(readings, { shelf: false })}${pager(base, { sort, pageNo, more })}`
      : `<p>Nothing on this shelf yet. <a href="/contribute">Contribute a reading</a>.</p>`}`
  );
}

function list({ heading, intro, base, empty, readings, more, sort, pageNo, notice: n }) {
  return `${note(n)}${box(
    heading,
    `${intro ? `<p class="meta">${esc(intro)}</p>` : ''}
    ${readings.length
      ? `${sorter(base, sort)}${entries(readings)}${pager(base, { sort, pageNo, more })}`
      : `<p>${esc(empty || 'Nothing here yet.')} <a href="/contribute">Contribute a reading</a>.</p>`}`
  )}`;
}

function search({ q, readings, more, sort, pageNo }) {
  const query = `q=${encodeURIComponent(q)}&amp;`;
  const form = `<form class="search" method="get" action="/search" role="search">
      <input type="search" name="q" value="${esc(q)}" maxlength="100" aria-label="Search the library" placeholder="title, author, tag or words from the text">
      <button class="btn" type="submit">Search</button>
    </form>`;
  let results = '';
  if (q) {
    results = readings.length
      ? `<hr>${sorter('/search', sort, query)}${entries(readings)}${pager('/search', { sort, pageNo, more }, query)}`
      : `<p>Nothing found for "${esc(q)}".</p>`;
  }
  return box('SEARCH THE LIBRARY', `${form}${results}`);
}

function reading({ reading: r, comments, user, isLibrarian, recommended, canEdit, notice: n }) {
  const removed = r.removed
    ? `<section class="box note" role="status"><b>Off the shelf.</b> Removed ${r.removed_at ? day(r.removed_at) : ''} by <code>${esc(short(r.removed_by))}</code>. Only librarians can see this page. Restore or delete it from the <a href="/desk">desk</a>.</section>`
    : '';
  const facts = [
    ['AUTHOR', esc(r.author)],
    r.year ? ['YEAR', esc(r.year)] : null,
    ['SHELF', `<a href="/shelf/${esc(r.shelf_slug)}">${esc(r.shelf_name)}</a>`],
    ['LENGTH', `${r.words.toLocaleString('en')} words${readingTime(r.words) ? ` · ${readingTime(r.words)}` : ''}`],
    r.source_url ? ['SOURCE', `<a href="${esc(r.source_url)}" rel="noopener nofollow ugc">${esc(teaser(r.source_url, 70))}</a>`] : null,
    r.tags.length ? ['TAGS', tagLinks(r.tags)] : null,
  ].filter(Boolean);

  const head = `<section class="box">
    <h1>${esc(r.title)}</h1>
    <table class="facts">${facts.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</table>
    <div class="why">
      <h2 class="plain">Why read this</h2>
      ${paragraphs(r.note)}
      <div class="meta">Shelved ${day(r.created_at)} by ${who(r.contributor)}${day(r.updated_at) !== day(r.created_at) ? ` · edited ${day(r.updated_at)}` : ''}</div>
    </div>
    ${canEdit && !r.removed
      ? `<div class="actions">
          <a class="btn" href="/reading/${esc(r.slug)}/edit">Edit</a>
          <form method="post" action="/reading/${esc(r.slug)}/remove"><button class="btn" type="submit">Take off the shelf</button></form>
        </div>`
      : ''}
  </section>`;

  const text = `<section class="box" aria-label="The text"><article class="text">${render(r.body)}</article></section>`;

  let recommendControl;
  if (r.removed) recommendControl = '';
  else if (!user) recommendControl = `<button type="button" class="btn" data-action="signin">Sign in to recommend</button>`;
  else if (recommended) recommendControl = `<span>You recommend this.</span><form method="post" action="/reading/${esc(r.slug)}/recommend"><input type="hidden" name="undo" value="yes"><button class="btn" type="submit">Withdraw</button></form>`;
  else recommendControl = `<form method="post" action="/reading/${esc(r.slug)}/recommend"><button class="btn" type="submit"><b>Recommend this reading</b></button></form>`;
  const recommend = box(
    'RECOMMEND',
    `<div class="recommend"><span class="count">${plural(r.recs, 'recommendation')}</span>${recommendControl}</div>
    <p class="hint">One wallet, one recommendation.</p><div class="msg" data-msg aria-live="polite"></div>`,
    ' id="recommend"'
  );

  const thread = comments.length
    ? `<ul class="comments">${comments
        .map((c) => `<li id="c${c.id}">
          ${paragraphs(c.body)}
          <div class="meta">${who(c.address)}${c.address === r.contributor ? ' (contributor)' : ''} · ${day(c.created_at)}${
            user && (isLibrarian || user.address === c.address)
              ? ` · <form method="post" action="/comment/${c.id}/remove"><button class="linkish" type="submit">remove</button></form>`
              : ''
          }</div>
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
  const discussion = box(`COMMENTS (${comments.length})`, `${thread}${commentForm}`, ' id="comments"');

  return [note(n), removed, head, text, recommend, discussion].filter(Boolean).join('\n  ');
}

const MARKUP_HELP = `<details>
    <summary>How to format the text</summary>
    <p class="hint">Plain text works as it is: leave a blank line between paragraphs. If you want more:</p>
    <table class="facts">
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
    return box('CONTRIBUTE A READING', signInBox('Anyone with a wallet can add a reading to the library. Signing in only proves you own the address; it costs nothing and sends no transaction.'));
  }
  return box(
    'CONTRIBUTE A READING',
    `<p>Add a text you think the community should read. It goes on the shelf straight away, under your wallet address <code>${esc(short(user.address))}</code>. You can edit it or take it down later.</p>
    <form class="form wide" method="post" action="/contribute">
      ${readingFields({ shelves, maxChars })}
      <label class="check"><input type="checkbox" name="rights" value="yes" required> <span>This text is free to share here: it is my own, in the public domain, or under a licence that allows it.</span></label>
      <button class="btn" type="submit"><b>Put it on the shelf</b></button>
    </form>`
  );
}

function edit({ reading: r, shelves, maxChars }) {
  return box(
    'EDIT READING',
    `<form class="form wide" method="post" action="/reading/${esc(r.slug)}/edit">
      ${readingFields({ r, shelves, maxChars })}
      <div class="actions"><button class="btn" type="submit"><b>Save</b></button> <a href="/reading/${esc(r.slug)}">cancel</a></div>
    </form>`
  );
}

function desk({ removed, shelves, librarians, totals, me, notice: n }) {
  const counts = `<section class="box welcome"><b>The library holds</b> ${plural(totals.readings, 'reading')} from ${plural(totals.contributors, 'contributor')}, with ${plural(totals.recs, 'recommendation')} and ${plural(totals.comments, 'comment')}.
    To take a reading or a comment down, open its page: librarians see the controls on every one.</section>`;

  const off = box(
    'OFF THE SHELF',
    removed.length
      ? `<div class="scroll"><table class="grid">
          <tr><th>Reading</th><th>Contributor</th><th>Removed</th><th></th></tr>
          ${removed
            .map((r) => `<tr>
              <td><a href="/reading/${esc(r.slug)}">${esc(r.title)}</a><br><i>${byline(r)}</i></td>
              <td><code>${esc(short(r.contributor))}</code></td>
              <td>${r.removed_at ? day(r.removed_at) : ''} by <code>${esc(short(r.removed_by))}</code>${r.removed_by === r.contributor ? ' (the contributor)' : ''}</td>
              <td><div class="actions">
                <form method="post" action="/desk/reading/${r.id}/restore"><button class="btn" type="submit">Put back</button></form>
                <details><summary>delete…</summary><form method="post" action="/desk/reading/${r.id}/delete"><p class="hint">This erases the text, its recommendations and comments. It cannot be undone.</p><button class="btn" type="submit">Delete for good</button></form></details>
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
    'SHELVES',
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
    'LIBRARIANS',
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
    `${signIn ? signInBox(text, goto) : `<p>${esc(text)}</p>`}
    ${back ? '<p class="hint">Use your browser\'s back button to return to what you were writing; it should still be there.</p>' : ''}
    <p><a href="/">&lt;&lt; back to the library</a></p>`
  );
}

module.exports = { layout, home, shelf, list, search, reading, contribute, edit, desk, message };
