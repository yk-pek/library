// Turns a reading's text into HTML. Readings are written by anyone, so everything is
// escaped first and only a small, fixed set of tags is ever produced.
//
// The markup, a small subset of Markdown:
//   # Heading, ## Smaller heading, ### Smallest heading
//   blank line between paragraphs
//   > quoted lines
//   - list items, 1. numbered items
//   --- a rule
//   ``` fenced lines keep their line breaks (verse, code)
//   *italic*, **bold**, `code`, and bare https:// links

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// `text` is already escaped. Quotes are entities by now, so a link can't break out of href.
function inline(text) {
  const kept = [];
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let out = text
    .replace(/`([^`\n]+)`/g, (m, code) => keep(`<code>${code}</code>`))
    .replace(/\bhttps?:\/\/[^\s<\u0000]+/g, (url) => {
      const trail = (url.match(/(?:[.,;:!?)\]]|&quot;|&#39;)+$/) || [''])[0];
      const href = url.slice(0, url.length - trail.length);
      if (href.length < 10) return url;
      return keep(`<a href="${href}" rel="noopener nofollow ugc">${href}</a>`) + trail;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<i>$2</i>');
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
}

function render(source) {
  const lines = String(source || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(esc(para.join(' ')))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(esc(i))}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) {
      const paras = quote.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      html.push(`<blockquote>${paras.map((p) => `<p>${inline(esc(p.replace(/\n/g, ' ')))}</p>`).join('')}</blockquote>`);
    }
    quote = [];
  };
  const flush = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      flush();
      const block = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) block.push(lines[i++]);
      html.push(`<pre>${esc(block.join('\n'))}</pre>`);
      continue;
    }
    if (!trimmed) { flushPara(); flushList(); if (quote.length) quote.push(''); continue; }

    const heading = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) {
      flush();
      const level = heading[1].length + 2; // the page's own h1 and h2 are taken
      html.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); html.push('<hr>'); continue; }

    const quoted = trimmed.match(/^>\s?(.*)$/);
    if (quoted) { flushPara(); flushList(); quote.push(quoted[1]); continue; }
    flushQuote();

    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    const numbered = trimmed.match(/^\d{1,3}[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    // An indented line right after a list item continues that item.
    if (list && /^\s+/.test(line)) { list.items[list.items.length - 1] += ` ${trimmed}`; continue; }
    flushList();
    para.push(trimmed);
  }
  // An unclosed fence is handled by the loop running off the end.
  flush();
  return html.join('\n');
}

function countWords(source) {
  const words = String(source || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}

module.exports = { render, inline, esc, countWords };
