// Checks for the importer: a web page becomes the library's markup, and the address
// guard refuses anything that is not a public web page.
const assert = require('assert');
const imp = require('../import');

const filler = 'The reading room is quiet in the morning and the shelves are full of things somebody thought worth keeping. ';
const html = `<!doctype html><html><head><title>On Keeping Books | The Site</title><meta name="author" content="Jane Reader">
<meta property="article:published_time" content="2019-04-02T10:00:00Z"><script>evil()</script></head><body>
<nav><a href="/">Home</a></nav><article><h1>On Keeping Books</h1><p>By Jane Reader</p>
<p>${filler.repeat(4)}With <em>emphasis</em> and <strong>strength</strong> and <a href="https://example.com/x">a link</a>.</p>
<h2>The first part</h2><p>${filler.repeat(4)}</p><blockquote><p>A quoted line.</p></blockquote>
<figure><img src="x"><figcaption>caption</figcaption></figure><ul><li>one</li><li>two</li></ul>
<pre>line 1\n  line 2</pre><p>${filler.repeat(3)}<script>alert(1)</script></p></article><footer>Copyright</footer></body></html>`;

const r = imp.fromHtml(html, 'https://example.com/a');
assert.strictEqual(r.title, 'On Keeping Books');
assert.strictEqual(r.author, 'Jane Reader');
assert.strictEqual(r.year, '2019');
assert.strictEqual(r.source_url, 'https://example.com/a');
assert(r.body.includes('With *emphasis* and **strength** and a link.'));
assert(r.body.includes('# The first part'));
assert(r.body.includes('> A quoted line.'));
assert(r.body.includes('- one\n- two'));
assert(r.body.includes('```\nline 1\n  line 2\n```'));
for (const gone of ['By Jane Reader', 'caption', 'alert(1)', 'evil()', 'Copyright', 'Home', '<']) assert(!r.body.includes(gone), `should not contain ${gone}`);

assert.throws(() => imp.fromHtml('<html><body><p>Too short.</p></body></html>', 'https://example.com/'), imp.ImportError);

for (const bad of ['http://localhost/x', 'https://10.0.0.1/', 'https://library-db/', 'ftp://a.example/c', 'https://a.example:5432/', 'https://user:pw@a.example/', 'https://[::1]/', 'file:///etc/passwd', 'https://db.internal/x', 'nonsense']) {
  assert.throws(() => imp.safeUrl(bad), imp.ImportError, bad);
}
assert.strictEqual(imp.safeUrl('https://example.com/a').href, 'https://example.com/a');

console.log('import: web page and address checks passed');
