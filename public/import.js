// The "start from a link or a PDF" box on the contribute page. It asks the library to pull
// the text out, then fills in the form so the contributor can check it before shelving.
(function () {
  var box = document.querySelector('.importer');
  if (!box) return;
  var msg = box.querySelector('[data-import-msg]');
  var field = function (id) { return document.getElementById(id); };

  function say(text, ok) {
    msg.textContent = text;
    msg.classList.toggle('ok', Boolean(ok));
  }

  function busy(on) {
    box.setAttribute('aria-busy', on ? 'true' : 'false');
    box.querySelectorAll('button, input').forEach(function (el) { el.disabled = on; });
  }

  // Never overwrite text the contributor has already typed or pasted.
  function ready() {
    if (field('body').value.trim() && !field('scan-file').value) {
      say('The text box below already has text in it. Clear it first, then import.');
      return false;
    }
    return true;
  }

  function fill(data) {
    ['title', 'author', 'year', 'source_url'].forEach(function (name) {
      var el = field(name);
      if (el && !el.value.trim() && data[name]) el.value = data[name];
    });
    // A scan has no text: the PDF waits on the server and is attached when the reading is shelved.
    field('scan-file').value = data.scan ? data.file : '';
    field('scan-note').hidden = !data.scan;
    field('body').required = !data.scan;
    if (data.scan) {
      say('This PDF is a scan (' + data.pages + (data.pages === 1 ? ' page' : ' pages') + '), so there is no text to pull out. It will be attached to the reading as a PDF. Fill in the title and author, choose a shelf and say why it is worth reading. The text box is optional. Shelve it within a day or the upload is cleared.', true);
      field('title').focus();
      return;
    }
    field('body').value = data.body;
    var parts = ['Pulled in ' + Number(data.words).toLocaleString('en') + ' words' + (data.pages ? ' from ' + data.pages + (data.pages === 1 ? ' page' : ' pages') : '') + '.'];
    parts.push('Check the title, author and text below, choose a shelf, and say why it is worth reading.');
    (data.notes || []).forEach(function (n) { parts.push(n); });
    say(parts.join(' '), true);
    field('title').focus();
  }

  async function send(url, options) {
    busy(true);
    try {
      var res = await fetch(url, options);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'That could not be imported.');
      fill(data);
    } catch (err) {
      say((err && err.message) || 'That could not be imported.');
    } finally {
      busy(false);
    }
  }

  function fromLink() {
    var url = field('import-url').value.trim();
    if (!url) { say('Type or paste a web address first.'); return; }
    if (!ready()) return;
    say('Fetching the page…', true);
    send('/api/import/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url }) });
  }

  function fromPdf(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { say('That PDF is over 15 MB.'); input.value = ''; return; }
    if (!ready()) { input.value = ''; return; }
    say('Reading the PDF…', true);
    send('/api/import/pdf', { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file }).then(function () { input.value = ''; });
  }

  box.addEventListener('click', function (event) {
    if (event.target.closest('[data-import="link"]')) fromLink();
  });
  field('import-url').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); fromLink(); }
  });
  box.addEventListener('change', function (event) {
    if (event.target.matches('[data-import="pdf"]')) fromPdf(event.target);
  });
})();
