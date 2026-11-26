// Checks for the text renderer: the markup it supports, and that nothing a
// contributor types can turn into live HTML.
const assert = require('assert');
const { render, countWords } = require('../text');

const cases = [
  ['paragraphs join wrapped lines', 'one\ntwo\n\nthree', '<p>one two</p>\n<p>three</p>'],
  ['headings start at h3', '# A\n## B\n### C', '<h3>A</h3>\n<h4>B</h4>\n<h5>C</h5>'],
  ['four hashes is not a heading', '#### D', '<p>#### D</p>'],
  ['quote', '> a\n> b\n>\n> c', '<blockquote><p>a b</p><p>c</p></blockquote>'],
  ['bullets', '- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
  ['numbers', '1. a\n2) b', '<ol><li>a</li><li>b</li></ol>'],
  ['list item continues when indented', '- a\n  more\n- b', '<ul><li>a more</li><li>b</li></ul>'],
  ['rule', 'a\n\n---\n\nb', '<p>a</p>\n<hr>\n<p>b</p>'],
  ['fence keeps lines and ignores markup', '```\n*a*\n  b\n```\nc', '<pre>*a*\n  b</pre>\n<p>c</p>'],
  ['unclosed fence', '```\na', '<pre>a</pre>'],
  ['bold and italic', 'a **b** *c* d', '<p>a <b>b</b> <i>c</i> d</p>'],
  ['stray asterisks stay', '2 * 3 * 4 and a*b*c', '<p>2 * 3 * 4 and a*b*c</p>'],
  ['code is not formatted', '`*a*`', '<p><code>*a*</code></p>'],
  ['link, trailing full stop left out', 'see https://example.com/a?b=1&c=2.', '<p>see <a href="https://example.com/a?b=1&amp;c=2" rel="noopener nofollow ugc">https://example.com/a?b=1&amp;c=2</a>.</p>'],
  ['link in brackets', '(https://example.com/x)', '<p>(<a href="https://example.com/x" rel="noopener nofollow ugc">https://example.com/x</a>)</p>'],
  ['asterisks inside a link are left alone', 'https://example.com/*a* *b*', '<p><a href="https://example.com/*a*" rel="noopener nofollow ugc">https://example.com/*a*</a> <i>b</i></p>'],
  ['html is escaped', '<script>alert(1)</script> <img src=x onerror=1>', '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=1&gt;</p>'],
  ['html in heading is escaped', '# <b>x</b>', '<h3>&lt;b&gt;x&lt;/b&gt;</h3>'],
  ['quote cannot break out of a link', 'https://example.com/"onmouseover="x', '<p><a href="https://example.com/&quot;onmouseover=&quot;x" rel="noopener nofollow ugc">https://example.com/&quot;onmouseover=&quot;x</a></p>'],
  ['javascript: is not linked', 'javascript:alert(1)', '<p>javascript:alert(1)</p>'],
  ['placeholder characters cannot be forged', 'a \u00000\u0000 b', '<p>a 0 b</p>'],
  ['empty', '  \n\n ', ''],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  const actual = render(input);
  try {
    assert.strictEqual(actual, expected);
  } catch {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// Whatever goes in, only the fixed set of tags may come out.
const ALLOWED = /^<\/?(p|h3|h4|h5|blockquote|ul|ol|li|hr|pre|b|i|code)>$|^<a href="https?:\/\/[^"<>\s]*" rel="noopener nofollow ugc">$|^<\/a>$/;
const pieces = ['<', '>', '"', "'", '&', '*', '**', '`', '```', '\n', '\n\n', '# ', '> ', '- ', '1. ', 'https://a.b/c', 'x', ' ', '<script>', 'javascript:', '\u0000', '0', '---'];
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let n = 0; n < 5000; n++) {
  let input = '';
  for (let k = 0; k < 14; k++) input += pieces[Math.floor(rand() * pieces.length)];
  const out = render(input);
  for (const tag of out.match(/<[^>]*>/g) || []) {
    if (!ALLOWED.test(tag)) { failed++; console.error(`FAIL unexpected tag ${tag} from ${JSON.stringify(input)}`); break; }
  }
  if (/\u0000/.test(out)) { failed++; console.error(`FAIL placeholder left in output from ${JSON.stringify(input)}`); }
}

assert.strictEqual(countWords("It's a well-known fact: 42 things."), 6);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log(`text: ${cases.length} cases and 5000 random inputs passed`);
