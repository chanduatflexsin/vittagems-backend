/* ─────────────────────────────────────────────────────────────────────────
 * XPZ Corp — Operations Portal (demo integrator)
 *
 * XPZ manages its own customers / invoices / payouts in this app (state is
 * kept in localStorage). ONLY the settlement step is delegated to the
 * VittaGems Settlement API:
 *   settle invoice   → POST /deposits, POST /mint, poll GET /mint/{id}
 *   partner payout   → POST /transfers, poll GET /transfers/{id}
 *   customer cashout → POST /withdrawals … POST /withdrawals/{id}/approve, poll GET /withdrawals/{id}
 * ───────────────────────────────────────────────────────────────────────── */

const LS_KEY = 'xpz_portal_state_v1';
const SCOPES = ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'];
const POLL = { tries: 30, interval: 4000 };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── state ─────────────────────────────────────────────────────────────── */
const defaultState = () => ({
  config: { baseUrl: 'http://localhost:3000/api/v1', apiKey: '', wallet: '', clientId: '', company: 'XPZ Corp' },
  invoices: [],    // {id, ref, customer, amount, currency, corridor, status, txId, txHash, error, createdAt}
  payouts: [],     // {id, ref, toAddress, amount, status, txId, txHash, error, createdAt}
  withdrawals: [], // {id(withdrawalId), ref, amount, bank, status, burnTxHash, error, createdAt}
  log: [],
});
let state = load();
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && s.config) return { ...defaultState(), ...s }; } catch {}
  return defaultState();
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

/* ── helpers ───────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');
const fmt = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleTimeString();
function randomAddress() {
  const b = new Uint8Array(20); crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function toast(msg, kind = 'info') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 5000);
}
const connected = () => !!state.config.apiKey && !!state.config.wallet;

/* ── API client (logs every call to the console tab) ───────────────────── */
async function api(method, path, { body, idem, auth = true } = {}) {
  const url = state.config.baseUrl.replace(/\/$/, '') + path;
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.config.apiKey) headers['Authorization'] = `Bearer ${state.config.apiKey}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const t0 = performance.now();
  let res, json;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    logEntry({ method, path, status: 'NET', ms: performance.now() - t0, req: body, res: { error: e.message } });
    throw new Error(`Network error — is the Settlement API running at ${state.config.baseUrl}?`);
  }
  logEntry({ method, path, status: res.status, ms: performance.now() - t0, req: body, res: json, idem });
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    err.status = res.status; err.code = json?.error?.code; throw err;
  }
  return json;
}
function logEntry(e) {
  state.log.unshift({ ...e, at: now() });
  state.log = state.log.slice(0, 300);
  save(); renderLog();
}
async function poll(path, isDone) {
  for (let i = 0; i < POLL.tries; i++) {
    const r = await api('GET', path);
    if (isDone(r.data)) return r.data;
    await sleep(POLL.interval);
  }
  return { status: 'TIMEOUT' };
}

/* ── connection ────────────────────────────────────────────────────────── */
async function checkHealth() {
  const conn = $('#conn'), txt = $('#conn-text');
  conn.className = 'conn';
  try {
    const origin = new URL(state.config.baseUrl).origin;
    const r = await fetch(`${origin}/health`); const j = await r.json();
    if (j.status === 'ok') { conn.classList.add(connected() ? 'ok' : 'warn'); txt.textContent = connected() ? 'API online · authenticated' : 'API online · not onboarded'; return true; }
    throw new Error('bad health');
  } catch { conn.classList.add('bad'); txt.textContent = 'API unreachable'; return false; }
}

async function onboard(company, wallet) {
  wallet = wallet || randomAddress();
  const r = await api('POST', '/clients/register', { auth: false, body: { name: company, permissions: SCOPES, blockchainAddress: wallet } });
  state.config.company = company; state.config.apiKey = r.data.apiKey; state.config.clientId = r.data.clientId; state.config.wallet = wallet;
  save(); render(); checkHealth();
  toast(`Onboarded ${company}. API key stored in this browser.`, 'ok');
}

/* ── XPZ business flows ────────────────────────────────────────────────── */
function recordPayment({ customer, invoice, amount, currency, corridor }) {
  if (state.invoices.some((i) => i.ref === invoice)) { toast(`Invoice ${invoice} already exists`, 'warn'); return; }
  state.invoices.unshift({ id: uid('inv'), ref: invoice, customer, amount: String(amount), currency, corridor: corridor || 'IN-IN', status: 'RECORDED', createdAt: now() });
  save(); render(); toast(`Recorded ${invoice} — ₹${fmt(amount)} from ${customer}`, 'ok');
}

async function settleInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id); if (!inv) return;
  if (!connected()) { toast('Connect to the Settlement API first', 'warn'); return; }
  inv.status = 'SETTLING'; inv.error = null; save(); render();
  try {
    // 1) Tell the settlement network the fiat has been received (verified deposit)
    try { await api('POST', '/deposits', { body: { amount: inv.amount, currency: inv.currency, referenceId: inv.ref } }); }
    catch (e) { if (e.status !== 409) throw e; } // already registered → carry on
    // 2) Mint settlement value to XPZ's wallet, keyed by the invoice reference
    const m = await api('POST', '/mint', { idem: uid(`xpz-mint-${inv.ref}`), body: { amount: inv.amount, referenceId: inv.ref, toAddress: state.config.wallet, corridor: inv.corridor } });
    inv.txId = m.data.transactionId || m.data.id; save(); render();
    // 3) Wait for on-chain confirmation
    const f = await poll(`/mint/${inv.txId}`, (d) => ['CONFIRMED', 'FAILED'].includes(d.status));
    if (f.status === 'CONFIRMED') { inv.status = 'SETTLED'; inv.txHash = f.blockchainTxHash; toast(`${inv.ref} settled on-chain`, 'ok'); }
    else { inv.status = 'FAILED'; inv.error = f.failureReason || f.status; toast(`${inv.ref} settlement failed`, 'bad'); }
  } catch (e) { inv.status = 'FAILED'; inv.error = e.message; toast(e.message, 'bad'); }
  save(); render();
}

async function createPayout(ref, toAddress) {
  const inv = state.invoices.find((i) => i.ref === ref); if (!inv) return;
  const p = { id: uid('po'), ref, toAddress, amount: inv.amount, status: 'SUBMITTING', createdAt: now() };
  state.payouts.unshift(p); save(); render();
  try {
    const r = await api('POST', '/transfers', { idem: uid(`xpz-xfer-${ref}`), body: { amount: inv.amount, fromAddress: state.config.wallet, toAddress, referenceId: ref } });
    p.txId = r.data.transactionId || r.data.id; p.status = 'PENDING'; save(); render();
    const f = await poll(`/transfers/${p.txId}`, (d) => ['CONFIRMED', 'FAILED'].includes(d.status));
    if (f.status === 'CONFIRMED') { p.status = 'CONFIRMED'; p.txHash = f.blockchainTxHash; inv.status = 'TRANSFERRED'; toast(`Payout for ${ref} confirmed`, 'ok'); }
    else { p.status = 'FAILED'; p.error = f.failureReason || f.status; toast(`Payout for ${ref} failed`, 'bad'); }
  } catch (e) { p.status = 'FAILED'; p.error = e.message; toast(e.message, 'bad'); }
  save(); render();
}

async function requestWithdrawal(ref, bank) {
  const inv = state.invoices.find((i) => i.ref === ref); if (!inv) return;
  const w = { id: null, ref, amount: inv.amount, bank, status: 'REQUESTING', createdAt: now() };
  state.withdrawals.unshift(w); save(); render();
  try {
    const r = await api('POST', '/withdrawals', { idem: uid(`xpz-wd-${ref}`), body: { amount: inv.amount, bankDetails: bank, fromAddress: state.config.wallet, referenceId: ref } });
    w.id = r.data.withdrawalId; w.status = r.data.status; inv.status = 'WITHDRAWAL_REQUESTED';
    toast(`Withdrawal requested for ${ref}. Pay the customer, then click "Fiat sent".`, 'ok');
  } catch (e) { w.status = 'FAILED'; w.error = e.message; toast(e.message, 'bad'); }
  save(); render();
}

async function confirmFiatSent(wid) {
  const w = state.withdrawals.find((x) => x.id === wid); if (!w) return;
  const inv = state.invoices.find((i) => i.ref === w.ref);
  w.status = 'CLOSING'; w.error = null; save(); render();
  try {
    await api('POST', `/withdrawals/${w.id}/approve`, { auth: false });
    const f = await poll(`/withdrawals/${w.id}`, (d) => d.status === 'SETTLED' || d.burnTransactionStatus === 'FAILED');
    if (f.status === 'SETTLED') { w.status = 'SETTLED'; w.burnTxHash = f.blockchainTxHash; if (inv) inv.status = 'CLOSED'; toast(`${w.ref} closed on-chain (burned)`, 'ok'); }
    else { w.status = 'FAILED'; w.error = f.failureReason || `Burn ${f.burnTransactionStatus || f.status}`; toast(`Closing ${w.ref} failed`, 'bad'); }
  } catch (e) { w.status = 'FAILED'; w.error = e.message; toast(e.message, 'bad'); }
  save(); render();
}

async function refreshWithdrawal(wid) {
  const w = state.withdrawals.find((x) => x.id === wid); if (!w) return;
  try {
    const r = await api('GET', `/withdrawals/${w.id}`); const d = r.data;
    w.status = d.status; w.burnTxHash = d.blockchainTxHash || w.burnTxHash;
    if (d.status === 'SETTLED') { const inv = state.invoices.find((i) => i.ref === w.ref); if (inv) inv.status = 'CLOSED'; }
    if (d.burnTransactionStatus === 'FAILED') { w.status = 'FAILED'; w.error = d.failureReason || 'Burn failed'; }
  } catch (e) { toast(e.message, 'bad'); }
  save(); render();
}

/* ── rendering ─────────────────────────────────────────────────────────── */
const badge = (s) => `<span class="badge ${esc(s)}">${['SETTLING','SUBMITTING','CLOSING','REQUESTING','PENDING','BURN_PENDING'].includes(s) ? '<span class="spin"></span>' : ''}${esc(s)}</span>`;
const txLink = (h) => (h ? `<span class="mono" title="${esc(h)}">${short(h)}</span>` : '<span class="muted">—</span>');
const sum = (arr) => arr.reduce((a, x) => a + Number(x.amount || 0), 0);

function render() {
  $('#brand-name').textContent = state.config.company || 'XPZ Corp';
  $('#setup-banner').classList.toggle('hidden', connected());
  renderStats(); renderActivity(); renderInvoices(); renderPayouts(); renderWithdrawals(); renderSettings(); renderLog();
}

function renderStats() {
  const inv = state.invoices;
  const settled = inv.filter((i) => ['SETTLED', 'TRANSFERRED', 'WITHDRAWAL_REQUESTED', 'CLOSED'].includes(i.status));
  const pending = inv.filter((i) => ['RECORDED', 'SETTLING'].includes(i.status));
  const payouts = state.payouts.filter((p) => p.status === 'CONFIRMED');
  const closed = state.withdrawals.filter((w) => w.status === 'SETTLED');
  const cards = [
    ['Fiat collected', `₹${fmt(sum(inv))}`, `${inv.length} invoices`],
    ['Settled on-chain', `₹${fmt(sum(settled))}`, `${settled.length} settlements`],
    ['Awaiting settlement', `₹${fmt(sum(pending))}`, `${pending.length} pending`],
    ['Partner payouts', `₹${fmt(sum(payouts))}`, `${payouts.length} confirmed`],
    ['Cash-outs closed', `₹${fmt(sum(closed))}`, `${closed.length} burned`],
  ];
  $('#stats').innerHTML = cards.map(([l, v, s]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
}

function renderActivity() {
  const items = [
    ...state.invoices.map((i) => ({ at: i.createdAt, text: `Invoice ${i.ref} · ${i.customer} · ₹${fmt(i.amount)}`, status: i.status })),
    ...state.payouts.map((p) => ({ at: p.createdAt, text: `Payout ${p.ref} → ${short(p.toAddress)}`, status: p.status })),
    ...state.withdrawals.map((w) => ({ at: w.createdAt, text: `Withdrawal ${w.ref} · ${w.bank?.holder || ''}`, status: w.status })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  $('#activity').innerHTML = items.length ? items.map((x) => `<div class="item"><div>${esc(x.text)} ${badge(x.status)}</div><div class="when">${when(x.at)}</div></div>`).join('') : '<div class="muted">No activity yet — record a customer payment to begin.</div>';
}

function renderInvoices() {
  const rows = state.invoices.map((i) => {
    const canSettle = ['RECORDED', 'FAILED'].includes(i.status);
    return `<tr>
      <td><strong>${esc(i.ref)}</strong><div class="muted mono">${esc(i.corridor)}</div></td>
      <td>${esc(i.customer)}</td>
      <td>₹${fmt(i.amount)} <span class="muted">${esc(i.currency)}</span></td>
      <td>${badge(i.status)}${i.error ? `<div class="err">${esc(i.error)}</div>` : ''}</td>
      <td>${txLink(i.txHash)}</td>
      <td>${canSettle ? `<button class="btn sm primary" data-action="settle" data-id="${i.id}" ${connected() ? '' : 'disabled'}>${i.status === 'FAILED' ? 'Retry' : 'Settle on-chain'}</button>` : ''}
          <button class="btn sm" data-action="del-invoice" data-id="${i.id}" title="Remove from XPZ books (local only)">✕</button></td>
    </tr>`;
  });
  $('#tbl-invoices').innerHTML = rows.join('') || '<tr><td class="empty" colspan="6">No invoices yet. Record a payment or seed samples.</td></tr>';
  const opts = state.invoices.filter((i) => i.status === 'SETTLED').map((i) => `<option value="${esc(i.ref)}">${esc(i.ref)} — ₹${fmt(i.amount)} (${esc(i.customer)})</option>`).join('');
  $('#sel-payout-invoice').innerHTML = opts || '<option value="">— no settled invoices —</option>';
  const wdOpts = state.invoices.filter((i) => ['SETTLED', 'TRANSFERRED'].includes(i.status)).map((i) => `<option value="${esc(i.ref)}">${esc(i.ref)} — ₹${fmt(i.amount)} (${esc(i.customer)})</option>`).join('');
  $('#sel-wd-invoice').innerHTML = wdOpts || '<option value="">— no settled invoices —</option>';
}

function renderPayouts() {
  const rows = state.payouts.map((p) => `<tr>
    <td><strong>${esc(p.ref)}</strong></td>
    <td><span class="mono" title="${esc(p.toAddress)}">${short(p.toAddress)}</span></td>
    <td>₹${fmt(p.amount)}</td>
    <td>${badge(p.status)}${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}</td>
    <td>${txLink(p.txHash)}</td>
    <td><button class="btn sm" data-action="del-payout" data-id="${p.id}">✕</button></td>
  </tr>`);
  $('#tbl-payouts').innerHTML = rows.join('') || '<tr><td class="empty" colspan="6">No payouts yet.</td></tr>';
}

function renderWithdrawals() {
  const rows = state.withdrawals.map((w) => `<tr>
    <td><span class="mono">${w.id ? short(w.id) : '—'}</span></td>
    <td><strong>${esc(w.ref)}</strong></td>
    <td>₹${fmt(w.amount)}</td>
    <td>${esc(w.bank?.holder || '')}<div class="muted mono">${esc(w.bank?.accountNumber || '')} · ${esc(w.bank?.ifsc || '')}</div></td>
    <td>${badge(w.status)}${w.error ? `<div class="err">${esc(w.error)}</div>` : ''}</td>
    <td>${txLink(w.burnTxHash)}</td>
    <td>
      ${w.status === 'REQUESTED' ? `<button class="btn sm primary" data-action="fiat-sent" data-id="${w.id}">💸 Fiat sent → close</button>` : ''}
      ${w.id && !['SETTLED', 'CLOSING', 'REQUESTING'].includes(w.status) ? `<button class="btn sm" data-action="refresh-wd" data-id="${w.id}">Refresh</button>` : ''}
    </td>
  </tr>`);
  $('#tbl-withdrawals').innerHTML = rows.join('') || '<tr><td class="empty" colspan="7">No withdrawal requests yet.</td></tr>';
}

function renderSettings() {
  const f = $('#form-settings');
  f.baseUrl.value = state.config.baseUrl; f.apiKey.value = state.config.apiKey; f.clientId.value = state.config.clientId || ''; f.wallet.value = state.config.wallet || '';
  $('#form-onboard').company.value = state.config.company || 'XPZ Corp';
}

function renderLog() {
  $('#log-count').textContent = state.log.length;
  const cls = (s) => (typeof s === 'number' ? `s${String(s)[0]}` : 'sN');
  $('#log').innerHTML = state.log.length ? state.log.map((e) => `<details>
    <summary><span class="method ${esc(e.method)}">${esc(e.method)}</span><span>${esc(e.path)}</span><span class="status ${cls(e.status)}">${esc(e.status)}</span>${e.idem ? `<span class="muted">idem:${esc(e.idem)}</span>` : ''}<span class="ms">${Math.round(e.ms)} ms · ${when(e.at)}</span></summary>
    ${e.req ? `<div class="pre-label">Request</div><pre>${esc(JSON.stringify(e.req, null, 2))}</pre>` : ''}
    <div class="pre-label">Response</div><pre>${esc(JSON.stringify(e.res, null, 2))}</pre>
  </details>`).join('') : '<div class="muted">No API calls yet.</div>';
}

/* ── wiring ────────────────────────────────────────────────────────────── */
function showTab(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]'); if (go) showTab(go.dataset.goto);
  const a = e.target.closest('[data-action]'); if (!a) return;
  const { action, id } = a.dataset;
  if (action === 'settle') settleInvoice(id);
  if (action === 'fiat-sent') confirmFiatSent(id);
  if (action === 'refresh-wd') refreshWithdrawal(id);
  if (action === 'del-invoice') { state.invoices = state.invoices.filter((i) => i.id !== id); save(); render(); }
  if (action === 'del-payout') { state.payouts = state.payouts.filter((p) => p.id !== id); save(); render(); }
});

$('#form-payment').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  recordPayment({ customer: f.customer.value.trim(), invoice: f.invoice.value.trim(), amount: f.amount.value, currency: f.currency.value.trim() || 'INR', corridor: f.corridor.value.trim() });
  f.customer.value = ''; f.invoice.value = ''; f.amount.value = '';
});
$('#btn-seed').addEventListener('click', () => {
  const n = Date.now().toString().slice(-5);
  [['Alice Sharma', 1000], ['Bob Mehta', 2500], ['Carol Iyer', 750]].forEach(([c, a], i) =>
    recordPayment({ customer: c, invoice: `INV-${n}-${i + 1}`, amount: a, currency: 'INR', corridor: 'IN-IN' }));
});
$('#form-payout').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  if (!f.ref.value) return toast('No settled invoice to pay out', 'warn');
  createPayout(f.ref.value, f.toAddress.value.trim());
});
$('#btn-sample-partner').addEventListener('click', () => { $('#form-payout').toAddress.value = randomAddress(); });
$('#form-withdrawal').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  if (!f.ref.value) return toast('No settled invoice to withdraw', 'warn');
  requestWithdrawal(f.ref.value, { holder: f.holder.value.trim(), accountNumber: f.account.value.trim(), ifsc: f.ifsc.value.trim() });
});
$('#form-onboard').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  try { await onboard(f.company.value.trim(), f.wallet.value.trim()); showTab('dashboard'); } catch (err) { toast(err.message, 'bad'); }
});
$('#btn-gen-wallet').addEventListener('click', () => { $('#form-onboard').wallet.value = randomAddress(); });
$('#form-settings').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  state.config.baseUrl = f.baseUrl.value.trim().replace(/\/$/, ''); state.config.apiKey = f.apiKey.value.trim();
  save(); render(); checkHealth(); toast('Settings saved', 'ok');
});
$('#btn-toggle-key').addEventListener('click', (e) => { const i = $('#form-settings').apiKey; i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'Show' : 'Hide'; });
$('#btn-test-conn').addEventListener('click', async () => {
  const ok = await checkHealth(); if (!ok) return toast('API unreachable', 'bad');
  if (!state.config.apiKey) return toast('API online. Onboard to get an API key.', 'warn');
  try { const r = await api('GET', '/client'); toast(`Authenticated as ${r.data.name} (${r.data.BlockchainAccounts?.length || 0} wallet)`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
});
$('#btn-reset').addEventListener('click', () => { if (confirm('Clear all XPZ demo data (invoices, payouts, withdrawals, API key)?')) { state = defaultState(); save(); render(); checkHealth(); } });
$('#btn-clear-log').addEventListener('click', () => { state.log = []; save(); renderLog(); });

render(); checkHealth(); setInterval(checkHealth, 20000);
