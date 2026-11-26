/* Small shared helpers: no build, no dependencies, loaded with <script> */
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, body, method) {
  const m = method || (body === undefined ? 'GET' : 'POST');
  const opts = { method: m };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

let toastTimer;
function toast(msg, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3400);
}

/* ---------- Current user: kept in localStorage so it survives page changes ---------- */

const MEMBER_KEY = 'sdbl.member';

function currentMember() {
  const saved = (localStorage.getItem(MEMBER_KEY) || '').trim();
  return saved || 'Alice';
}

function setMember(name) {
  const v = String(name || '').trim();
  if (v) localStorage.setItem(MEMBER_KEY, v);
  else localStorage.removeItem(MEMBER_KEY);
}

function bindMemberInput() {
  const el = $('member');
  if (!el) return;
  el.value = currentMember();
  el.addEventListener('input', () => setMember(el.value));
}

/* ---------- Display helpers ---------- */

function stars(n) {
  const r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function fmtRating(v) {
  return v ? Number(v).toFixed(1) : '—';
}

function markNav() {
  const here = location.pathname.replace(/index\.html$/, '') || '/';
  document.querySelectorAll('.nav a').forEach((a) => {
    const href = (a.getAttribute('href') || '').replace(/index\.html$/, '');
    if (href === here) a.classList.add('active');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindMemberInput();
  markNav();
});
