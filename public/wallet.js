// Wallet sign-in and sign-out. Everything else on the site is plain HTML.
(function () {
  function say(el, text) {
    var box = el.closest('section, div');
    var msg = (box && box.querySelector('[data-msg]')) || document.querySelector('[data-msg]');
    if (msg) msg.textContent = text;
  }

  function toHex(text) {
    var bytes = new TextEncoder().encode(text);
    var hex = '0x';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }

  async function post(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  async function signIn(button) {
    if (!window.ethereum) {
      say(button, 'No wallet found. Open this page in a browser with a wallet such as MetaMask.');
      return;
    }
    button.disabled = true;
    try {
      say(button, 'Waiting for your wallet…');
      var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      var address = accounts[0];
      var challenge = await post('/api/auth/nonce', { address: address });
      var signature = await window.ethereum.request({ method: 'personal_sign', params: [toHex(challenge.message), address] });
      await post('/api/auth/verify', { nonce: challenge.nonce, signature: signature });
      var next = button.getAttribute('data-goto');
      if (next) location.href = next; else location.reload();
    } catch (err) {
      say(button, err && err.code === 4001 ? 'Sign-in cancelled.' : (err && err.message) || 'Sign-in failed.');
      button.disabled = false;
    }
  }

  async function signOut() {
    try { await post('/api/auth/logout'); } catch (e) {}
    location.reload();
  }

  document.addEventListener('click', function (event) {
    var el = event.target.closest('[data-action]');
    if (!el) return;
    if (el.getAttribute('data-action') === 'signin') signIn(el);
    if (el.getAttribute('data-action') === 'signout') signOut();
  });
})();
