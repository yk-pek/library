// Pulls the text out of a web page or a PDF and writes it in the library's own markup
// (see text.js), so a contributor can start from a link or a file instead of pasting.
// Nothing fetched or uploaded is kept: only the text that comes back to the form.

const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');

const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 800;

class ImportError extends Error {}

// ---------- shared ----------

function tidy(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/­/g, '') // soft hyphens
    .replace(/[  -   　]/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl');
}

const squash = (text) => tidy(text).replace(/\s+/g, ' ').trim();

function finish(blocks) {
  return blocks.map((b) => b.trim()).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function yearFrom(value) {
  const m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(value || ''));
  return m ? m[1] : '';
}

// ---------- fetching a link ----------

// The address is typed by whoever is contributing, so it is treated as hostile: public
// web hosts only, every redirect checked again, a time limit and a size limit.
function safeUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new ImportError('That does not look like a web address. It should start with https://'); }
  const host = url.hostname.toLowerCase();
  const looksLikeIp = /^[0-9.]+$/.test(host) || host.includes(':') || host.startsWith('[');
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !host.includes('.') || looksLikeIp || host === 'localhost' ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost') || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) {
    throw new ImportError('The library will not fetch that address. Use a public web page.');
  }
  return url;
}

async function fetchLink(raw) {
  let url = safeUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'User-Agent': 'AlternetLibrary/0.1 (reading importer)' },
      });
    } catch (err) {
      throw new ImportError(err && err.name === 'TimeoutError' ? 'That page took too long to answer.' : 'That page could not be reached.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = safeUrl(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    if (!res.ok) throw new ImportError(`That page answered with an error (${res.status}). It may need a sign-in or block automatic readers.`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const isPdf = type.includes('application/pdf') || (!type.includes('html') && /\.pdf$/i.test(url.pathname));
    const max = isPdf ? MAX_PDF_BYTES : MAX_PAGE_BYTES;
    if (Number(res.headers.get('content-length') || 0) > max) throw new ImportError('That file is too large to import.');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > max) throw new ImportError('That file is too large to import.');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), type, isPdf, url: url.href };
  }
  throw new ImportError('That address redirects too many times.');
}

function decode(bytes, type) {
  let charset = (/charset=["']?([\w-]+)/i.exec(type) || [])[1];
  if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

// ---------- web pages ----------

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'FIGURE', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'FORM', 'BUTTON', 'NAV', 'ASIDE', 'TEMPLATE', 'CANVAS', 'OBJECT', 'EMBED']);
const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'HR', 'TABLE', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'ADDRESS']);

// Inline content as one line of the library's markup.
function inline(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += tidy(child.textContent).replace(/\s+/g, ' '); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toUpperCase();
    if (SKIP.has(tag)) continue;
    if (tag === 'BR') { out += ' '; continue; }
    const inner = inline(child);
    const core = inner.trim();
    if (!core) { out += inner ? ' ' : ''; continue; }
    const pad = (mark) => `${/^\s/.test(inner) ? ' ' : ''}${mark}${core}${mark}${/\s$/.test(inner) ? ' ' : ''}`;
    if ((tag === 'EM' || tag === 'I' || tag === 'CITE') && !core.includes('*')) out += pad('*');
    else if ((tag === 'STRONG' || tag === 'B') && !core.includes('*')) out += pad('**');
    else if ((tag === 'CODE' || tag === 'KBD' || tag === 'TT') && !core.includes('`')) out += pad('`');
    else out += inner;
  }
  return out;
}

// `top` is the heading level that becomes "#"; by default the highest one present.
function htmlToMarkup(root, top = 0) {
  const levels = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  if (!top) top = levels.length ? Math.min(...levels) : 1;
  const blocks = [];
  const para = (text) => { const t = text.replace(/\s+/g, ' ').trim(); if (t) blocks.push(t); };

  function walk(node) {
    let loose = ''; // text and inline elements sitting directly in a container
    const flushLoose = () => { para(loose); loose = ''; };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { loose += tidy(child.textContent).replace(/\s+/g, ' '); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (!BLOCKS.has(tag)) {
        if (tag === 'BR') { loose += ' '; continue; }
        // An inline wrapper that holds blocks (a link around paragraphs, say) is walked instead.
        if (child.querySelector && child.querySelector('p,div,h1,h2,h3,h4,ul,ol,blockquote,pre')) { flushLoose(); walk(child); } else loose += inline({ childNodes: [child] });
        continue;
      }
      flushLoose();
      if (/^H[1-6]$/.test(tag)) {
        const text = inline(child).replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
        if (text) blocks.push(`${'#'.repeat(Math.max(1, Math.min(3, Number(tag[1]) - top + 1)))} ${text}`);
      } else if (tag === 'P' || tag === 'DT' || tag === 'DD' || tag === 'SUMMARY' || tag === 'ADDRESS') {
        if (child.querySelector('p,ul,ol,blockquote,pre')) walk(child); else para(inline(child));
      } else if (tag === 'BLOCKQUOTE') {
        const inner = htmlToMarkup(child);
        if (inner) blocks.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      } else if (tag === 'UL' || tag === 'OL') {
        const items = [...child.children].filter((li) => li.tagName.toUpperCase() === 'LI')
          .map((li) => inline(li).replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (items.length) blocks.push(items.map((t, i) => (tag === 'OL' ? `${i + 1}. ${t}` : `- ${t}`)).join('\n'));
      } else if (tag === 'PRE') {
        const code = tidy(child.textContent).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '').replace(/```/g, "'''");
        if (code) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      } else if (tag === 'HR') {
        blocks.push('---');
      } else if (tag === 'TABLE') {
        for (const row of child.querySelectorAll('tr')) {
          para([...row.children].map((c) => squash(c.textContent)).filter(Boolean).join(' | '));
        }
      } else {
        walk(child);
      }
    }
    flushLoose();
  }

  walk(root);
  return finish(blocks);
}

function meta(document, names) {
  for (const name of names) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    const value = el && squash(el.getAttribute('content'));
    if (value) return value;
  }
  return '';
}

function fromHtml(html, url) {
  const { document } = parseHTML(html);
  const author0 = meta(document, ['author', 'article:author', 'citation_author', 'dc.creator', 'DC.creator', 'parsely-author']);
  const date0 = meta(document, ['article:published_time', 'citation_publication_date', 'citation_date', 'dc.date', 'DC.date', 'date', 'pubdate']);
  const h1 = squash((document.querySelector('h1') || {}).textContent);
  let article = null;
  try { article = new Readability(document, { charThreshold: 200 }).parse(); } catch { article = null; }

  let body = '';
  if (article && article.content) body = htmlToMarkup(parseHTML(`<html><body>${article.content}</body></html>`).document.body);
  // Very plain pages (old text-heavy sites) can defeat the article finder; fall back to the whole page.
  if (body.length < 400) {
    const whole = parseHTML(html).document;
    const fallback = whole.body ? htmlToMarkup(whole.body) : '';
    if (fallback.length > body.length * 1.5) body = fallback;
  }
  if (body.length < 200) throw new ImportError('The library could not find an article on that page. It may load its text with scripts or need a sign-in. Paste the text instead.');

  let author = squash((article && article.byline) || author0).replace(/^by\s+/i, '');
  if (/^https?:\/\//i.test(author) || author.length > 120) author = '';
  let title = squash((article && article.title) || (document.querySelector('title') || {}).textContent);
  // Page titles often carry the site's name ("Essay | Site"); the page's main heading is cleaner.
  if (h1 && h1.length >= 4 && title.toLowerCase().includes(h1.toLowerCase())) title = h1;
  title = title.slice(0, 200);
  // A leading "By So-and-so" line repeats the author field.
  if (author) {
    const lead = body.split('\n\n')[0];
    if (lead.length < author.length + 12 && squash(lead.replace(/\*/g, '')).toLowerCase().replace(/^by\s+/, '') === author.toLowerCase()) body = body.slice(lead.length).trim();
  }
  // The page's own heading often repeats as the first line of the text.
  const first = body.split('\n\n')[0];
  if (title && /^#+ /.test(first) && squash(first.replace(/^#+ /, '')).toLowerCase() === title.toLowerCase()) body = body.slice(first.length).trim();
  return { title, author: author.slice(0, 200), year: yearFrom((article && article.publishedTime) || date0), source_url: url, body };
}

function fromPlainText(text, url) {
  const body = tidy(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length < 50) throw new ImportError('There is hardly any text at that address.');
  return { title: '', author: '', year: '', source_url: url, body };
}

// ---------- PDFs ----------

// PDFs have no paragraphs or headings, only runs of text at positions. This rebuilds
// lines, then guesses paragraphs from spacing and indents and headings from type size.
function pdfLines(items) {
  const lines = [];
  let cur = null;
  const end = () => { if (cur && cur.text.trim()) lines.push({ ...cur, text: cur.text.replace(/\s+/g, ' ').trim() }); cur = null; };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const size = it.height || Math.abs(it.transform[3]) || 10;
    const x = it.transform[4];
    const y = it.transform[5];
    if (cur && Math.abs(y - cur.y) > Math.max(2, cur.size * 0.5)) end();
    if (it.str) {
      if (!cur) cur = { text: '', x, y, size, endX: x };
      else if (x - cur.endX > cur.size * 0.2 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      cur.text += tidy(it.str);
      if (it.str.trim()) cur.size = Math.max(cur.size, size);
      cur.endX = x + (it.width || 0);
    }
    if (it.hasEOL) end();
  }
  end();
  return lines;
}

function mode(values) {
  const counts = new Map();
  let best = null;
  for (const [v, w] of values) {
    const n = (counts.get(v) || 0) + w;
    counts.set(v, n);
    if (best === null || n > counts.get(best)) best = v;
  }
  return best;
}

const furniture = (text) => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const isPageNumber = (text) => /^(page\s+)?[-–—\s]*(\d{1,4}|[ivxlc]{1,7})[-–—\s]*(\s*(of|\/)\s*\d{1,4})?$/i.test(text.trim());

function pagesToMarkup(pages) {
  // Running heads, feet and page numbers: the top two and bottom two lines of a page, by
  // position, when they are a page number or the same on most pages.
  const edgesOf = (lines) => {
    const byHeight = [...lines].sort((a, b) => b.y - a.y);
    return new Set([...byHeight.slice(0, 2), ...byHeight.slice(-2)]);
  };
  const seen = new Map();
  for (const lines of pages) {
    for (const key of new Set([...edgesOf(lines)].map((l) => furniture(l.text)))) seen.set(key, (seen.get(key) || 0) + 1);
  }
  const repeated = new Set([...seen].filter(([, n]) => pages.length >= 3 && n >= pages.length * 0.5).map(([k]) => k));
  const cleaned = pages.map((lines) => {
    const edges = edgesOf(lines);
    return lines.filter((l) => !(edges.has(l) && l.text.length < 120 && (isPageNumber(l.text) || repeated.has(furniture(l.text)))));
  });

  const all = cleaned.flat();
  if (!all.length) return '';
  const round = (n) => Math.round(n * 2) / 2;
  const bodySize = mode(all.map((l) => [round(l.size), l.text.length]));
  const gaps = [];
  for (const lines of cleaned) {
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i - 1].y - lines[i].y;
      if (gap > 0 && round(lines[i].size) === bodySize && round(lines[i - 1].size) === bodySize) gaps.push([Math.round(gap), 1]);
    }
  }
  const leading = mode(gaps) || bodySize * 1.2;
  const margin = mode(all.filter((l) => round(l.size) === bodySize).map((l) => [Math.round(l.x), 1])) || 0;

  const blocks = [];
  let para = null; // { lines: [], heading: 0 }
  const close = () => {
    if (!para) return;
    let text = '';
    for (const line of para.lines) {
      if (!text) text = line;
      else if (/[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(line)) text = text.slice(0, -1) + line; // word broken across lines
      else text += ` ${line}`;
    }
    if (para.heading) text = `${'#'.repeat(para.heading)} ${text.replace(/\*+/g, '')}`;
    else text = text.replace(/^[•‣◦▪●○■–]\s+/, '- ');
    blocks.push(text);
    para = null;
  };

  let prev = null;
  cleaned.forEach((lines) => {
    lines.forEach((line, i) => {
      const size = round(line.size);
      const heading = size >= bodySize * 1.5 && line.text.length < 140 ? 1 : size >= bodySize * 1.15 && line.text.length < 140 ? 2 : 0;
      const bullet = /^[•‣◦▪●○■]\s+/.test(line.text);
      let fresh = !para || bullet || heading !== para.heading;
      if (!fresh && prev) {
        const newPage = i === 0;
        const gap = prev.y - line.y;
        const indented = line.x - margin > bodySize * 0.8 && prev.x - margin <= bodySize * 0.8;
        const ended = /[.!?:;"”’)\]]$/.test(prev.text);
        if (newPage || gap < 0) fresh = ended && (indented || prev.endX < margin + bodySize * 20); // carried over a page or column
        else if (gap > leading * 1.45) fresh = true;
        else if (indented && !para.heading) fresh = true;
      }
      if (fresh) { close(); para = { lines: [], heading }; }
      para.lines.push(line.text);
      prev = line;
    });
  });
  close();
  return finish(blocks);
}

async function fromPdf(bytes, url = '') {
  if (bytes.subarray(0, 1024).indexOf('%PDF-') === -1) throw new ImportError('That file is not a PDF.');
  const { getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    throw new ImportError(/password/i.test(String(err && err.message)) ? 'That PDF is locked with a password.' : 'That PDF could not be read.');
  }
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new ImportError(`That PDF has ${pdf.numPages} pages; the library imports up to ${MAX_PDF_PAGES}.`);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(pdfLines(content.items));
      page.cleanup();
    }
    const body = pagesToMarkup(pages);
    // No text to speak of means pictures of pages: a scan. The caller keeps the file itself.
    const scan = body.replace(/\s/g, '').length < 100;
    let info = {};
    try { info = (await pdf.getMetadata()).info || {}; } catch { info = {}; }
    let title = squash(info.Title);
    const junk = /^(untitled|microsoft word|scan|document|.*\.(docx?|pdf|tex|indd|tiff?|jpe?g))/i;
    if (!title || junk.test(title)) title = scan ? '' : squash((/^# (.+)$/m.exec(body) || [])[1]);
    return {
      title: title.slice(0, 200), author: squash(info.Author).slice(0, 200), // A scan's file date is when it was scanned, not when the work was written.
      year: scan ? '' : yearFrom(info.CreationDate && String(info.CreationDate).slice(0, 6)),
      source_url: url, body: scan ? '' : body, pages: pdf.numPages, scan,
    };
  } finally {
    try { await (pdf.destroy ? pdf.destroy() : pdf.cleanup && pdf.cleanup()); } catch { /* nothing to free */ }
  }
}

async function fromLink(raw) {
  const got = await fetchLink(raw);
  if (got.isPdf) {
    const result = await fromPdf(got.bytes, got.url);
    if (result.scan) throw new ImportError('That PDF is a scan: pictures of pages with no text to pull out. Download it and upload the file here instead, and the library will attach it to the reading.');
    return result;
  }
  const text = decode(got.bytes, got.type);
  if (got.type.includes('text/plain')) return fromPlainText(text, got.url);
  if (got.type && !/html|xml/.test(got.type)) throw new ImportError('That address is not a web page or a PDF.');
  return fromHtml(text, got.url);
}

module.exports = { fromLink, fromPdf, fromHtml, fromPlainText, htmlToMarkup, pagesToMarkup, pdfLines, safeUrl, ImportError, MAX_PDF_BYTES };
