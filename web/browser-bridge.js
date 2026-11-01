/* Value Forge's browser transport. The UI is shared with Companion for Android. */
'use strict';
(() => {
  const reads = new Set();
  const $ = id => document.getElementById(id);
  const actions = new Set(['settings', 'permission', 'pair', 'forget', 'state', 'processes', 'ping', 'command']);
  const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');

  async function send(action, args) {
    if (action === 'cancel_reads') {
      for (const controller of reads) controller.abort();
      return {};
    }
    if (!actions.has(action)) throw new Error('Unsupported browser request.');
    if (action === 'permission') action = 'settings';
    let path = action, method = 'GET', body;
    if (action === 'state') path += '?refresh=' + (args.refresh ? '1' : '0');
    if (action === 'forget') { path = 'unpair'; method = 'POST'; body = {}; }
    if (action === 'pair') {
      if (!/^[0-9]{6}$/.test(args.code)) throw new Error('Enter the six-digit pairing code shown in Decky.');
      method = 'POST'; body = {code:args.code, device_name:'Web browser · ' + (navigator.userAgent.includes('Android') ? 'Android' : /iPhone|iPad/.test(navigator.userAgent) ? 'iOS' : 'Computer')};
    }
    if (action === 'command') { method = 'POST'; body = {...args, request_id:requestId()}; }
    const controller = new AbortController();
    const read = ['state', 'processes', 'ping'].includes(action);
    if (read) reads.add(controller);
    const timeout = setTimeout(() => controller.abort(), action === 'command' ? 200000 : Math.max(1, Math.min(8000, args.timeout_ms || 8000)));
    try {
      const response = await fetch('/web-api/' + path, {
        method, credentials:'same-origin', cache:'no-store', redirect:'error', signal:controller.signal,
        headers:{'X-Value-Forge-Web':'1', ...(method === 'POST' ? {'Content-Type':'application/json'} : {})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || 'The request failed.'); error.status = response.status; throw error;
      }
      return result.data;
    } catch (error) {
      if (error.status) throw error;
      const failure = new Error(error.name === 'AbortError' ? 'Connection request stopped or timed out.' : 'Could not reach Value Forge. Check the local network and connection.');
      failure.status = 0; throw failure;
    } finally { clearTimeout(timeout); reads.delete(controller); }
  }
  window.ForgeNative = {request(id, action, text) {
    Promise.resolve().then(() => send(action, JSON.parse(text))).then(
      data => window.ForgeReply(id, {ok:true, data}),
      error => window.ForgeReply(id, {ok:false, error:error.message, status:error.status || 0})
    );
  }};

  // Keep all workspace logic shared; only the connection instructions differ.
  $('endpoint').value = location.host;
  $('endpoint').closest('label').hidden = true;
  document.querySelector('[data-action="address"]').hidden = true;
  $('pairButton').textContent = 'Pair this browser';
  document.querySelector('#pairForm ol').innerHTML = '<li>In Decky, enable <strong>Phone &amp; web companion</strong>.</li><li>Choose <strong>Pair a phone or browser</strong> to create a six-digit code.</li><li>Enter the code below. This browser remembers its pairing.</li>';
  document.querySelector('#pairForm > p').textContent = 'Use this machine’s local HTTPS address on the same home network. Cookies must be allowed. Clearing site data or using a different address requires pairing again.';
  document.querySelector('.about > strong').textContent = 'Value Forge Web · 0.8.0';
  const about = document.createElement('p');
  about.textContent = 'Runs entirely on your local network. No account or internet connection required. If your browser warns about the local certificate, compare its SHA-256 fingerprint in the browser’s certificate details with Decky before trusting it. Android’s app performs this check in its pairing dialog.';
  document.querySelector('.about').append(about);
  // A modal action can lose its connection after the user presses Confirm.
  window.addEventListener('unhandledrejection', event => {
    if (!(event.reason instanceof Error)) return;
    const modal = !$('modalBackdrop').hidden, target = modal ? $('modalMessage') : $('alert');
    (modal ? target : target.querySelector('span')).textContent = event.reason.message;
    target.hidden = false; event.preventDefault();
  });
  let visible = true;
  const lifecycle = next => { if (visible !== next) { visible = next; window.ForgeLifecycle?.(next); } };
  document.addEventListener('visibilitychange', () => lifecycle(!document.hidden));
  window.addEventListener('pagehide', () => lifecycle(false));
  window.addEventListener('pageshow', () => lifecycle(!document.hidden));
  document.addEventListener('DOMContentLoaded', () => lifecycle(!document.hidden));
})();
