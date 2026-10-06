'use strict';

/* global browserApi, KeystoneTheme */

const $ = (id) => document.getElementById(id);
const view = $('view');

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\//i.test(t)) return t.replace(/^http:/i, 'https:');
  // Looks like a domain: go there. Anything else: a web search.
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

// A <webview> attaches asynchronously. Navigating before it's ready got
// overwritten by its initial about:blank, leaving the browser blank on open,
// so the first URL waits for the webview's first dom-ready.
let viewReady = false;
let pendingUrl = null;
view.addEventListener('dom-ready', () => {
  if (viewReady) return;
  viewReady = true;
  if (pendingUrl) { view.loadURL(pendingUrl); pendingUrl = null; }
});

function go(url) {
  if (!url) return;
  $('addr').value = url;
  $('error').hidden = true;
  if (viewReady) view.loadURL(url);
  else pendingUrl = url;
}

function syncNav() {
  try {
    $('back').disabled = !view.canGoBack();
    $('fwd').disabled = !view.canGoForward();
  } catch { /* webview not ready yet */ }
}

view.addEventListener('did-navigate', (e) => { if (document.activeElement !== $('addr')) $('addr').value = e.url; syncNav(); });
view.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame && document.activeElement !== $('addr')) $('addr').value = e.url; syncNav(); });
view.addEventListener('did-start-loading', () => { $('progress').hidden = false; });
view.addEventListener('did-stop-loading', () => { $('progress').hidden = true; syncNav(); });
// Without this a failed load just leaves a blank white page.
view.addEventListener('did-fail-load', (e) => {
  if (!e.isMainFrame || e.errorCode === -3) return; // -3: navigation replaced, not a real failure
  $('errorText').textContent = `Couldn't load ${e.validatedURL || 'the page'} (${e.errorDescription || e.errorCode}). Check your internet connection, then reload.`;
  $('error').hidden = false;
});
view.addEventListener('did-navigate', () => { $('error').hidden = true; });
view.addEventListener('page-title-updated', (e) => { document.title = `${e.title} - Keystone browser`; });

$('back').addEventListener('click', () => view.canGoBack() && view.goBack());
$('fwd').addEventListener('click', () => view.canGoForward() && view.goForward());
$('reload').addEventListener('click', () => view.reload());
$('addrForm').addEventListener('submit', (e) => { e.preventDefault(); go(toUrl($('addr').value)); $('addr').blur(); });
$('addr').addEventListener('focus', () => $('addr').select());
$('links').addEventListener('change', (e) => { if (e.target.value) go(e.target.value); e.target.value = ''; });

$('pin').addEventListener('click', async () => {
  const on = $('pin').getAttribute('aria-pressed') !== 'true';
  const res = await browserApi.setOnTop(on);
  if (res.ok) $('pin').setAttribute('aria-pressed', String(res.data));
});
$('more').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('menu').hidden;
  $('menu').hidden = !open;
  $('more').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('menu').hidden = true; });
$('opacity').addEventListener('input', (e) => browserApi.setOpacity(e.target.value));
$('setHome').addEventListener('click', async () => {
  const url = view.getURL();
  const res = await browserApi.setHome(url);
  $('menu').hidden = true;
  $('setHome').textContent = res.ok ? 'Start page saved' : res.error;
  setTimeout(() => { $('setHome').textContent = 'Make this my start page'; }, 2000);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') browserApi.hide();
  if (e.altKey && e.key === 'ArrowLeft' && view.canGoBack()) view.goBack();
  if (e.altKey && e.key === 'ArrowRight' && view.canGoForward()) view.goForward();
});

browserApi.onNavigate(go);

let noticeTimer = null;
browserApi.onNotice(({ text, kind }) => {
  $('noticeText').textContent = text;
  $('notice').classList.toggle('bad', kind === 'error');
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 12000);
});
$('noticeClose').addEventListener('click', () => { $('notice').hidden = true; });
browserApi.appearance().then((r) => { if (r.ok) KeystoneTheme.applyAccent(r.data.accent); });
browserApi.onAppearance((a) => KeystoneTheme.applyAccent(a.accent));

(async () => {
  const res = await browserApi.state();
  if (!res.ok) return;
  const st = res.data;
  $('pin').setAttribute('aria-pressed', String(st.onTop));
  $('opacity').value = String(st.opacity);
  $('hotkeyHint').textContent = st.hotkeyError ? `Hotkey unavailable: ${st.hotkeyError}.` : `${st.hotkey} shows or hides this window. Esc hides it.`;
  const opts = [{ label: 'Go to…', url: '' }, ...st.links];
  $('links').replaceChildren(...opts.map((l) => Object.assign(document.createElement('option'), { value: l.url, textContent: l.label })));
  $('links').hidden = st.links.length === 0;
  go(st.initialUrl);
})();
