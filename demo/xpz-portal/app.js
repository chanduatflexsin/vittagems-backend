/* ─────────────────────────────────────────────────────────────────────────
 * XPZ Corp — Operations Portal (demo integrator) + VittaGems DAO console
 *
 * Two personas share this page:
 *   XPZ Corp        runs its own invoices, payouts and cash-outs, calling the
 *                   Settlement API only for settlement.
 *   VittaGems DAO   independent verifiers who review bank evidence and vote.
 *                   They authenticate with their own member tokens.
 *
 * Settle:     POST /deposits (+ bank proof) -> POST /mint (held) -> DAO votes
 *             -> approved: minted on-chain   | rejected/expired: nothing minted
 * Withdraw:   POST /withdrawals (funds locked on-chain) -> pay customer
 *             -> POST /withdrawals/{id}/payout-proof -> DAO votes
 *             -> approved: burned            | rejected/expired: funds released back
 * ───────────────────────────────────────────────────────────────────────── */

const LS_KEY = 'xpz_portal_state_v2';
const SCOPES = ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'];
const REFRESH_MS = 3000;
const DEMO_MEMBERS = ['Priya (Compliance)', 'Rahul (Treasury)', 'Meera (Audit)'];
const ACTIVE_WD = ['LOCK_PENDING', 'LOCKED', 'PAYOUT_SUBMITTED', 'BURN_PENDING', 'RELEASE_PENDING', 'REQUESTED'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── state ─────────────────────────────────────────────────────────────── */
const defaultState = () => ({
  config: { baseUrl: 'http://localhost:3000/api/v1', apiKey: '', wallet: '', clientId: '', company: 'XPZ Corp' },
  invoices: [],     // {id, ref, customer, amount, currency, corridor, utr, payer, status, txId, txHash, verification, error, createdAt}
  payouts: [],      // {id, ref, toAddress, amount, status, txId, txHash, error, createdAt}
  withdrawals: [],  // {id, ref, amount, bank, status, verification, lockTxHash, releaseTxHash, burnTxHash, message, error, createdAt}
  dao: { members: [], activeMemberId: null, filter: 'MINE' },
  log: [],
});
let state = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.config) return { ...defaultState(), ...s, dao: { ...defaultState().dao, ...(s.dao || {}) } };
  } catch {}
  return defaultState();
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

// Not persisted: server-derived and per-session.
const live = {
  daoConfig: null, proposals: [], needsMyVote: 0, seen: null, proofSeen: new Set(),
  wallets: [], daoWallets: [], walletsPending: 0,
  openDocs: new Set(), docUrls: {},   // blob URLs for previewed documents
};
const drafts = {};
const pendingDocs = {};               // File objects waiting to be uploaded, by invoice id

/* ── helpers ───────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleTimeString();
function randomAddress() {
  const b = new Uint8Array(20); crypto.getRandomValues(b);
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function randomUtr(bank = 'ICIC') { return `UTR-${bank}-${Math.floor(100000 + Math.random() * 899999)}`; }
function toast(msg, kind = 'info') {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 6000);
}
const connected = () => !!state.config.apiKey && !!state.config.wallet;
const daoOn = () => !!live.daoConfig?.enabled;
const activeMember = () => state.dao.members.find((m) => m.id === state.dao.activeMemberId) || state.dao.members[0] || null;
const invoiceByRef = (ref) => state.invoices.find((i) => i.ref === ref);
const myWallet = () => live.wallets.find((w) => w.address?.toLowerCase() === state.config.wallet?.toLowerCase()) || null;

/* ── API client ────────────────────────────────────────────────────────── */
async function api(method, path, { body, idem, auth = true, dao, quiet = false } = {}) {
  const url = state.config.baseUrl.replace(/\/$/, '') + path;
  const headers = { 'Content-Type': 'application/json' };
  if (dao) headers['X-DAO-Token'] = dao;
  else if (auth && state.config.apiKey) headers.Authorization = `Bearer ${state.config.apiKey}`;
  if (idem) headers['Idempotency-Key'] = idem;
  const t0 = performance.now();
  let res, json;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    if (!quiet) logEntry({ method, path, status: 'NET', ms: performance.now() - t0, req: body, res: { error: e.message } });
    throw new Error(`Network error — is the Settlement API running at ${state.config.baseUrl}?`);
  }
  if (!quiet) logEntry({ method, path, status: res.status, ms: performance.now() - t0, req: body, res: json, idem, dao: !!dao });
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

/**
 * Upload a proof document. The file goes up as the raw request body with its own
 * Content-Type, which is what the API expects - no multipart, no base64.
 */
async function uploadDoc(path, file) {
  const url = state.config.baseUrl.replace(/\/$/, '') + path;
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': file.name,
      Authorization: `Bearer ${state.config.apiKey}`,
    },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  logEntry({ method: 'POST', path, status: res.status, ms: performance.now() - t0, req: { file: file.name, type: file.type, bytes: file.size }, res: json });
  if (!res.ok) throw new Error(json?.error?.message || `Upload failed (HTTP ${res.status})`);
  return json.data;
}

/** Fetch a document as the acting DAO member and keep a blob URL to preview it. */
async function loadDocPreview(docId) {
  const m = activeMember(); if (!m) return;
  if (live.docUrls[docId]) { live.openDocs.add(docId); render(); return; }
  try {
    const url = state.config.baseUrl.replace(/\/$/, '') + `/dao/documents/${docId}`;
    const res = await fetch(url, { headers: { 'X-DAO-Token': m.token } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live.docUrls[docId] = URL.createObjectURL(await res.blob());
    live.openDocs.add(docId);
    render();
  } catch (e) { toast(`Could not open the document: ${e.message}`, 'bad'); }
}

/* ── connection & DAO config ───────────────────────────────────────────── */
async function checkHealth() {
  const conn = $('#conn'), txt = $('#conn-text');
  conn.className = 'conn';
  try {
    const origin = new URL(state.config.baseUrl).origin;
    const j = await (await fetch(`${origin}/health`)).json();
    if (j.status !== 'ok') throw new Error('bad health');
    conn.classList.add(connected() ? 'ok' : 'warn');
    txt.textContent = connected() ? 'API online · authenticated' : 'API online · not onboarded';
  } catch {
    conn.classList.add('bad'); txt.textContent = 'API unreachable';
  }
  await loadDaoConfig();
}

async function loadDaoConfig() {
  const el = $('#dao-mode'), txt = $('#dao-mode-text');
  el.className = 'conn';
  try {
    live.daoConfig = (await api('GET', '/dao/config', { auth: false, quiet: true })).data;
    if (live.daoConfig.enabled) {
      el.classList.add(live.daoConfig.quorumReachable ? 'ok' : 'warn');
      txt.textContent = `DAO on · ${live.daoConfig.activeMembers} member(s) · quorum ${live.daoConfig.quorum}`;
    } else {
      el.classList.add('warn'); txt.textContent = 'DAO verification off';
    }
  } catch {
    live.daoConfig = null; el.classList.add('bad'); txt.textContent = 'DAO status unknown';
  }
  renderDaoHeader(); renderSettingsMembers();
}

async function loadWallets() {
  if (!connected()) { live.wallets = []; return; }
  try { live.wallets = (await api('GET', '/wallets', { quiet: true })).data; } catch { /* shown by the banner */ }
}

async function loadDaoWallets() {
  const m = activeMember();
  if (!m || !daoOn()) { live.daoWallets = []; live.walletsPending = 0; return; }
  try {
    const r = await api('GET', '/dao/wallets', { dao: m.token, quiet: true });
    live.daoWallets = r.data.items; live.walletsPending = r.data.pending;
  } catch { /* ignore: token errors surface via loadProposals */ }
}

/** Submit this client's settlement wallet for whitelisting. */
async function registerOwnWallet() {
  try {
    const r = await api('POST', '/wallets', { body: { address: state.config.wallet, label: `${state.config.company} settlement wallet` } });
    toast(`Wallet submitted for DAO approval (${r.data.status})`, 'ok');
    await Promise.all([loadWallets(), loadDaoWallets()]);
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function decideWallet(walletId, action) {
  const m = activeMember(); if (!m) return;
  const reason = (drafts[`wallet:${walletId}`] || '').trim();
  if (action !== 'approve' && !reason) { toast('Enter a reason first', 'warn'); return; }
  try {
    const r = await api('POST', `/dao/wallets/${walletId}/${action}`, { dao: m.token, body: action === 'approve' ? {} : { reason } });
    delete drafts[`wallet:${walletId}`];
    toast(`Wallet ${r.data.address.slice(0, 10)}… is now ${r.data.status}`, action === 'approve' ? 'ok' : 'warn');
    await Promise.all([loadDaoWallets(), loadWallets(), loadDaoConfig()]);
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function onboard(company, wallet) {
  wallet = wallet || randomAddress();
  const r = await api('POST', '/clients/register', { auth: false, body: { name: company, permissions: SCOPES, blockchainAddress: wallet } });
  state.config.company = company; state.config.apiKey = r.data.apiKey; state.config.clientId = r.data.clientId; state.config.wallet = wallet;
  save(); render(); checkHealth();
  toast(`Onboarded ${company}. API key stored in this browser.`, 'ok');
}

async function addDemoMembers() {
  const have = new Set(state.dao.members.map((m) => m.name));
  const tag = Date.now().toString(36).slice(-4);
  let added = 0;
  for (const name of DEMO_MEMBERS) {
    if (have.has(name)) continue;
    const r = await api('POST', '/dao/members', { auth: false, body: { name: `${name} #${tag}` } });
    state.dao.members.push({ id: r.data.memberId, name, token: r.data.token });
    added++;
  }
  if (!state.dao.activeMemberId && state.dao.members[0]) state.dao.activeMemberId = state.dao.members[0].id;
  save(); await loadDaoConfig(); render();
  toast(added ? `Added ${added} DAO member(s). Switch between them in the DAO console.` : 'Demo members already added.', 'ok');
}

/* ── XPZ: customer payments → settlement ───────────────────────────────── */
function recordPayment({ customer, invoice, amount, currency, corridor, utr, payer }) {
  if (invoiceByRef(invoice)) { toast(`Invoice ${invoice} already exists`, 'warn'); return; }
  state.invoices.unshift({ id: uid('inv'), ref: invoice, customer, amount: String(amount), currency, corridor: corridor || 'IN-IN', utr, payer, status: 'RECORDED', createdAt: now() });
  save(); render(); toast(`Recorded ${invoice} — $${fmt(amount)} from ${customer}`, 'ok');
}

function applyMintStatus(inv, d) {
  const before = inv.status;
  inv.verification = d.verification || null;
  if (d.status === 'AWAITING_APPROVAL') inv.status = 'AWAITING_DAO';
  else if (d.status === 'PENDING' || d.status === 'SUBMITTED') inv.status = 'MINTING';
  else if (d.status === 'CONFIRMED') { inv.status = 'SETTLED'; inv.txHash = d.blockchainTxHash; inv.error = null; }
  else if (d.status === 'FAILED') {
    const vs = d.verification?.state;
    inv.status = vs === 'REJECTED' || vs === 'EXPIRED' ? 'REJECTED' : 'FAILED';
    inv.error = d.verification?.resolutionMessage || d.failureReason;
  }
  if (before !== inv.status) {
    if (inv.status === 'SETTLED') toast(`${inv.ref} minted on-chain${daoOn() ? ' after DAO approval' : ''}`, 'ok');
    if (inv.status === 'MINTING' && before === 'AWAITING_DAO') toast(`DAO approved ${inv.ref} — minting on-chain`, 'ok');
    if (inv.status === 'REJECTED') toast(`${inv.ref}: ${inv.error}`, 'bad');
  }
}

async function settleInvoice(id) {
  const inv = state.invoices.find((i) => i.id === id); if (!inv) return;
  if (!connected()) { toast('Connect to the Settlement API first', 'warn'); return; }
  inv.status = 'SUBMITTING'; inv.error = null; save(); render();
  try {
    let depositRes = null;
    try {
      depositRes = await api('POST', '/deposits', {
        body: {
          amount: inv.amount, currency: inv.currency, referenceId: inv.ref,
          proof: { bankReference: inv.utr, payerName: inv.customer, notes: inv.payer || undefined },
        },
      });
    } catch (e) { if (e.status !== 409) throw e; }
    // The deposit now exists, so any attached evidence can be stored against it.
    const dep = depositRes?.data;
    if (dep?.depositId) inv.depositId = dep.depositId;
    if (inv.depositId && pendingDocs[inv.id]) {
      try {
        const doc = await uploadDoc(`/deposits/${inv.depositId}/documents`, pendingDocs[inv.id]);
        inv.docs = [...(inv.docs || []), doc.filename];
        delete pendingDocs[inv.id];
      } catch (e) { toast(`Proof upload failed: ${e.message}`, 'warn'); }
    }

    const m = await api('POST', '/mint', {
      idem: uid(`xpz-mint-${inv.ref}`),
      body: { amount: inv.amount, referenceId: inv.ref, toAddress: state.config.wallet, corridor: inv.corridor },
    });
    inv.txId = m.data.transactionId || m.data.id;
    applyMintStatus(inv, m.data);
    if (inv.status === 'AWAITING_DAO') toast(`${inv.ref} sent to the DAO for verification`, 'info');
  } catch (e) { inv.status = 'FAILED'; inv.error = e.message; toast(e.message, 'bad'); }
  save(); render();
}

/** Attach a document to an existing deposit or withdrawal. */
async function attachDoc(kind, id, file, localId) {
  if (!file) return;
  try {
    const doc = await uploadDoc(`/${kind}/${id}/documents`, file);
    const target = kind === 'deposits'
      ? state.invoices.find((i) => i.id === localId)
      : state.withdrawals.find((w) => w.id === localId);
    if (target) target.docs = [...(target.docs || []), doc.filename];
    toast(`Attached ${doc.filename} for the DAO to review`, 'ok');
    save(); render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ── XPZ: partner payouts (direct transfer) ────────────────────────────── */
async function createPayout(ref, toAddress) {
  const inv = invoiceByRef(ref); if (!inv) return;
  const p = { id: uid('po'), ref, toAddress, amount: inv.amount, status: 'SUBMITTING', createdAt: now() };
  state.payouts.unshift(p); inv.status = 'PAYING_OUT'; save(); render();
  try {
    const r = await api('POST', '/transfers', { idem: uid(`xpz-xfer-${ref}`), body: { amount: inv.amount, fromAddress: state.config.wallet, toAddress, referenceId: ref } });
    p.txId = r.data.transactionId || r.data.id; p.status = 'PENDING'; save(); render();
    for (let i = 0; i < 40; i++) {
      const d = (await api('GET', `/transfers/${p.txId}`, { quiet: true })).data;
      if (d.status === 'CONFIRMED') { p.status = 'CONFIRMED'; p.txHash = d.blockchainTxHash; inv.status = 'TRANSFERRED'; toast(`Payout for ${ref} confirmed`, 'ok'); break; }
      if (d.status === 'FAILED') { p.status = 'FAILED'; p.error = d.failureReason; inv.status = 'SETTLED'; toast(`Payout for ${ref} failed`, 'bad'); break; }
      await sleep(REFRESH_MS);
    }
  } catch (e) { p.status = 'FAILED'; p.error = e.message; inv.status = 'SETTLED'; toast(e.message, 'bad'); }
  save(); render();
}

/* ── XPZ: withdrawals (lock → payout proof → DAO → burn | release) ─────── */
function applyWithdrawalStatus(w, d) {
  const before = w.status;
  w.status = d.status;
  w.verification = d.verification || null;
  w.lockTxHash = d.lockTxHash ?? w.lockTxHash;
  w.releaseTxHash = d.releaseTxHash ?? w.releaseTxHash;
  if (d.status === 'SETTLED') w.burnTxHash = d.blockchainTxHash;
  w.message = d.message ?? w.message;
  w.error = d.failureReason || null;

  const inv = invoiceByRef(w.ref);
  if (inv) {
    if (ACTIVE_WD.includes(d.status)) inv.status = 'WITHDRAWING';
    if (d.status === 'SETTLED') inv.status = 'CLOSED';
    if (d.status === 'RELEASED' || d.status === 'FAILED') inv.status = 'SETTLED';
  }

  if (before !== w.status) {
    const msgs = {
      LOCKED: [`Funds for ${w.ref} are locked on-chain. Pay the customer, then submit the payout reference.`, 'info'],
      BURN_PENDING: [`DAO verified the payout for ${w.ref} — burning the locked funds`, 'ok'],
      SETTLED: [`Withdrawal for ${w.ref} complete: locked funds burned on-chain`, 'ok'],
      RELEASE_PENDING: [w.message || `Withdrawal for ${w.ref} was not verified — releasing funds`, 'warn'],
      RELEASED: [w.message || `Withdrawal for ${w.ref} not finished — funds released back`, 'warn'],
      FAILED: [w.error || `Withdrawal for ${w.ref} failed`, 'bad'],
    };
    if (msgs[w.status]) toast(...msgs[w.status]);
  }
}

async function requestWithdrawal(ref, bank, windowMinutes) {
  const inv = invoiceByRef(ref); if (!inv) return;
  const w = { id: null, ref, amount: inv.amount, bank, status: 'REQUESTING', createdAt: now() };
  state.withdrawals.unshift(w); inv.status = 'WITHDRAWING'; save(); render();
  try {
    const body = { amount: inv.amount, bankDetails: bank, fromAddress: state.config.wallet, referenceId: ref };
    if (windowMinutes) body.windowMinutes = Number(windowMinutes);
    const r = await api('POST', '/withdrawals', { idem: uid(`xpz-wd-${ref}`), body });
    w.id = r.data.withdrawalId;
    applyWithdrawalStatus(w, r.data);
    toast(daoOn() ? `Withdrawal requested for ${ref}. Locking funds on-chain…` : `Withdrawal requested for ${ref}.`, 'ok');
  } catch (e) { w.status = 'FAILED'; w.error = e.message; inv.status = 'SETTLED'; toast(e.message, 'bad'); }
  save(); render();
}

async function submitPayoutProof(wid) {
  const w = state.withdrawals.find((x) => x.id === wid); if (!w) return;
  const ref = (drafts[`payout:${wid}`] || '').trim();
  if (!ref) { toast('Enter the bank reference (UTR) of the payout you sent', 'warn'); return; }
  try {
    const r = await api('POST', `/withdrawals/${wid}/payout-proof`, { body: { payoutReference: ref, notes: `Paid to ${w.bank?.holder || 'customer'}` } });
    delete drafts[`payout:${wid}`];
    applyWithdrawalStatus(w, r.data);
    if (pendingDocs[wid]) {
      try {
        const doc = await uploadDoc(`/withdrawals/${wid}/documents`, pendingDocs[wid]);
        w.docs = [...(w.docs || []), doc.filename];
        delete pendingDocs[wid];
      } catch (e) { toast(`Receipt upload failed: ${e.message}`, 'warn'); }
    }
    toast(`Payout reference submitted for ${w.ref}. The DAO can now verify it.`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  save(); render();
}

async function extendWithdrawal(wid) {
  const w = state.withdrawals.find((x) => x.id === wid); if (!w) return;
  try {
    const r = await api('POST', `/withdrawals/${wid}/extend`, { body: { reason: 'Bank payout still processing' } });
    applyWithdrawalStatus(w, r.data);
    const v = r.data.verification;
    toast(`Bank delay flagged: window extended (${v.extensionCount}/${v.maxExtensions})`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  save(); render();
}

async function confirmFiatSentDirect(wid) {
  // Only used when the server runs without DAO verification.
  const w = state.withdrawals.find((x) => x.id === wid); if (!w) return;
  try {
    await api('POST', `/withdrawals/${w.id}/approve`, { auth: false });
    toast(`Closing ${w.ref} on-chain…`, 'info');
  } catch (e) { toast(e.message, 'bad'); }
}

/* ── DAO: verifier actions ─────────────────────────────────────────────── */
async function loadProposals(quiet = true) {
  const m = activeMember();
  if (!m || !daoOn()) { live.proposals = []; live.needsMyVote = 0; return; }
  try {
    const r = await api('GET', '/dao/proposals', { dao: m.token, quiet });
    const items = r.data.items;
    notifyNewProposals(items);
    live.proposals = items;
    live.needsMyVote = r.data.needsMyVote;
  } catch (e) {
    if (e.status === 401) {
      toast(`${m.name}'s DAO token is no longer valid — add demo members again`, 'warn');
      state.dao.members = state.dao.members.filter((x) => x.id !== m.id);
      state.dao.activeMemberId = state.dao.members[0]?.id || null; save();
    }
  }
}

function notifyNewProposals(items) {
  if (live.seen === null) {           // first load: learn what already exists silently
    live.seen = new Set(items.map((i) => i.proposalId));
    items.filter((i) => i.evidence.payoutReference).forEach((i) => live.proofSeen.add(i.proposalId));
    return;
  }
  for (const i of items) {
    if (!live.seen.has(i.proposalId)) {
      live.seen.add(i.proposalId);
      if (i.state === 'PENDING') {
        const what = i.type === 'DEPOSIT' ? 'New deposit' : 'New withdrawal';
        toast(`🔔 DAO: ${what} to verify — ${i.referenceId} ($${fmt(i.amount)}) from ${i.client.name}`, 'info');
      }
    }
    if (i.type === 'WITHDRAWAL' && i.evidence.payoutReference && !live.proofSeen.has(i.proposalId)) {
      live.proofSeen.add(i.proposalId);
      if (i.state === 'PENDING') toast(`🔔 DAO: payout reference submitted for ${i.referenceId} — ready to verify`, 'info');
    }
  }
}

async function castVote(pid, decision) {
  const m = activeMember(); if (!m) return;
  const comment = (drafts[`vote:${pid}`] || '').trim();
  try {
    const r = await api('POST', `/dao/proposals/${pid}/votes`, { dao: m.token, body: { decision, comment: comment || undefined } });
    delete drafts[`vote:${pid}`];
    const p = r.data;
    const outcome = p.state === 'PENDING'
      ? `${m.name} voted ${decision} (${p.votes.for}/${p.votes.quorumRequired} approvals)`
      : `${p.referenceId} ${p.state}: ${p.outcome.resolutionMessage}`;
    toast(outcome, p.state === 'APPROVED' ? 'ok' : p.state === 'PENDING' ? 'info' : 'warn');
    await loadProposals(); await refreshClientSide();
  } catch (e) { toast(e.message, 'bad'); }
  render();
}

async function extendProposal(pid) {
  const m = activeMember(); if (!m) return;
  const reason = (drafts[`vote:${pid}`] || '').trim();
  if (!reason) { toast('Enter a reason for the extension in the comment box', 'warn'); return; }
  try {
    const r = await api('POST', `/dao/proposals/${pid}/extend`, { dao: m.token, body: { reason } });
    delete drafts[`vote:${pid}`];
    toast(`Window extended (${r.data.window.extensionCount}/${r.data.window.maxExtensions})`, 'ok');
    await loadProposals();
  } catch (e) { toast(e.message, 'bad'); }
  render();
}

/* ── background refresh ────────────────────────────────────────────────── */
async function refreshClientSide() {
  if (!connected()) return;
  for (const inv of state.invoices.filter((i) => i.txId && ['AWAITING_DAO', 'MINTING'].includes(i.status))) {
    try { applyMintStatus(inv, (await api('GET', `/mint/${inv.txId}`, { quiet: true })).data); } catch {}
  }
  for (const w of state.withdrawals.filter((x) => x.id && ACTIVE_WD.includes(x.status))) {
    try { applyWithdrawalStatus(w, (await api('GET', `/withdrawals/${w.id}`, { quiet: true })).data); } catch {}
  }
  save();
}

let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshClientSide();
    await Promise.all([loadProposals(), loadWallets(), loadDaoWallets()]);
    render();
  } finally { refreshing = false; }
}

/* ── rendering ─────────────────────────────────────────────────────────── */
const SPIN = ['SUBMITTING', 'MINTING', 'LOCK_PENDING', 'BURN_PENDING', 'RELEASE_PENDING', 'REQUESTING', 'PAYING_OUT', 'PENDING'];
const LABEL = {
  AWAITING_DAO: 'AWAITING DAO', PAYOUT_SUBMITTED: 'AWAITING DAO', LOCK_PENDING: 'LOCKING', BURN_PENDING: 'BURNING',
  RELEASE_PENDING: 'RELEASING', PAYING_OUT: 'PAYING OUT',
};
const badge = (s, label) => `<span class="badge ${esc(s)}">${SPIN.includes(s) ? '<span class="spin"></span>' : ''}${esc(label || LABEL[s] || s)}</span>`;
const txLink = (h, label) => (h ? `<span class="txrow" title="${esc(h)}">${label ? `<b>${esc(label)}</b> ` : ''}${short(h)}</span>` : '');
const sum = (arr) => arr.reduce((a, x) => a + Number(x.amount || 0), 0);
const countdown = (iso) => (iso ? `<span class="countdown" data-expires="${esc(iso)}">…</span>` : '');
function voteBar(v) {
  if (!v) return '';
  const q = v.quorumRequired || live.daoConfig?.quorum || 2;
  const cells = [];
  for (let i = 0; i < q; i++) cells.push(`<i class="${i < v.votesFor ? 'for' : ''}"></i>`);
  if (v.votesAgainst) for (let i = 0; i < v.votesAgainst; i++) cells.push('<i class="against"></i>');
  return `<span class="votebar">${cells.join('')}</span>`;
}

/**
 * Replace a region's markup only when it actually changed. Re-writing identical
 * HTML every refresh would swap out buttons under the cursor and swallow clicks.
 */
function setHTML(el, html) {
  if (!el || el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
}

/** Skip re-rendering a region while the user is typing in it. */
function guarded(sel, fn) {
  const el = $(sel), a = document.activeElement;
  if (el && a && el.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
  fn();
}

function render() {
  $('#brand-name').textContent = state.config.company || 'XPZ Corp';
  $('#setup-banner').classList.toggle('hidden', connected());
  renderWalletBanner(); renderClientWallets();
  guarded('#dao-wallets-card', renderDaoWallets);
  renderStats(); renderActivity();
  guarded('#tab-payments', renderInvoices);
  renderPayouts();
  guarded('#tab-withdrawals', renderWithdrawals);
  renderDaoHeader();
  guarded('#dao-list', renderDaoList);
  renderSettings(); renderSettingsMembers(); renderLog();
  tickCountdowns();
}

function renderWalletBanner() {
  const el = $('#wallet-banner');
  const w = myWallet();
  if (!connected() || w?.status === 'ACTIVE') { el.classList.add('hidden'); el.__html = null; return; }
  el.classList.remove('hidden');

  // A wallet from before the whitelist existed has no entry at all: offer to register it.
  if (!w) {
    setHTML(el, `<div><strong>Settlement wallet is not whitelisted</strong>
        <div class="muted"><span class="mono">${esc(state.config.wallet)}</span> — register it so the DAO can approve it. Nothing can be settled until then.</div></div>
      <button class="btn primary" data-action="register-wallet">Register wallet</button>`);
    return;
  }
  const detail = w.status === 'PENDING'
    ? 'A DAO member must whitelist it before you can settle anything to it.'
    : `It is ${esc(w.status)}${w.reason ? ` — ${esc(w.reason)}` : ''}. Settlement to this wallet is blocked.`;
  setHTML(el, `<div><strong>Settlement wallet ${esc(w.status === 'PENDING' ? 'awaiting whitelist approval' : w.status.toLowerCase())}</strong>
      <div class="muted"><span class="mono">${esc(w.address)}</span> — ${detail}</div></div>
    <button class="btn primary" data-goto="dao">Open DAO console →</button>`);
}

function renderClientWallets() {
  setHTML($('#client-wallets'), live.wallets.length
    ? live.wallets.map((w) => `<div class="m"><span>${esc(w.label)}<div class="addr">${esc(w.address)}</div></span>
        <span>${badge(w.status === 'PENDING' ? 'PENDING_WALLET' : w.status, w.status)}</span></div>`).join('')
    : '<div class="muted">No wallets registered yet.</div>');
}

function renderDaoWallets() {
  const pill = $('#wallet-pending-pill');
  pill.textContent = live.walletsPending;
  pill.classList.toggle('hidden', !live.walletsPending);

  const rows = live.daoWallets.map((w) => {
    const pending = w.status === 'PENDING';
    const acts = pending
      ? `<input data-draft="wallet:${w.walletId}" placeholder="Reason (to reject)" value="${esc(drafts[`wallet:${w.walletId}`] || '')}" />
         <button class="btn sm approve" data-action="wallet-approve" data-id="${w.walletId}">Whitelist</button>
         <button class="btn sm reject" data-action="wallet-reject" data-id="${w.walletId}">Reject</button>`
      : w.status === 'ACTIVE'
        ? `<input data-draft="wallet:${w.walletId}" placeholder="Reason (to revoke)" value="${esc(drafts[`wallet:${w.walletId}`] || '')}" />
           <button class="btn sm reject" data-action="wallet-revoke" data-id="${w.walletId}">Revoke</button>`
        : `<span class="muted">${esc(w.reason || '')}</span>`;
    return `<div class="wallet-row">
      <div class="who"><strong>${esc(w.client?.name || 'unassigned')}</strong> · ${esc(w.label)}
        <div class="addr">${esc(w.address)}</div></div>
      <div class="acts">${badge(w.status === 'PENDING' ? 'PENDING_WALLET' : w.status, w.status)}${acts}</div>
    </div>`;
  });
  setHTML($('#dao-wallets'), rows.join('') || '<div class="muted">No wallets registered yet.</div>');
}

function renderStats() {
  const inv = state.invoices;
  const onChain = inv.filter((i) => ['SETTLED', 'TRANSFERRED', 'WITHDRAWING', 'CLOSED', 'PAYING_OUT'].includes(i.status));
  const awaiting = inv.filter((i) => ['AWAITING_DAO', 'MINTING', 'SUBMITTING'].includes(i.status));
  const rejected = inv.filter((i) => i.status === 'REJECTED');
  const locked = state.withdrawals.filter((w) => ACTIVE_WD.includes(w.status));
  const closed = state.withdrawals.filter((w) => w.status === 'SETTLED');
  const cards = [
    ['Fiat collected', `$${fmt(sum(inv))}`, `${inv.length} invoices`],
    ['Settled on-chain', `$${fmt(sum(onChain))}`, `${onChain.length} DAO-approved`],
    ['Awaiting DAO', `$${fmt(sum(awaiting))}`, `${awaiting.length} pending · ${rejected.length} rejected`],
    ['Locked for withdrawal', `$${fmt(sum(locked))}`, `${locked.length} in verification`],
    ['Cash-outs completed', `$${fmt(sum(closed))}`, `${closed.length} burned`],
  ];
  setHTML($('#stats'), cards.map(([l, v, s]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join(''));
}

function renderActivity() {
  const items = [
    ...state.invoices.map((i) => ({ at: i.createdAt, text: `Invoice ${i.ref} · ${i.customer} · $${fmt(i.amount)}`, status: i.status })),
    ...state.payouts.map((p) => ({ at: p.createdAt, text: `Payout ${p.ref} → ${short(p.toAddress)}`, status: p.status })),
    ...state.withdrawals.map((w) => ({ at: w.createdAt, text: `Withdrawal ${w.ref} · ${w.bank?.holder || ''}`, status: w.status })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
  setHTML($('#activity'), items.length
    ? items.map((x) => `<div class="item"><div>${esc(x.text)} ${badge(x.status)}</div><div class="when">${when(x.at)}</div></div>`).join('')
    : '<div class="muted">No activity yet — record a customer payment to begin.</div>');
}

function verificationBlock(v, { deposit } = {}) {
  if (!v) return '';
  const parts = [];
  if (v.state === 'PENDING') {
    parts.push(`<div>${voteBar(v)} ${v.votesFor}/${v.quorumRequired} approvals${v.votesAgainst ? ` · ${v.votesAgainst} against` : ''} · closes in ${countdown(v.expiresAt)}</div>`);
    if (!deposit && v.awaitingPayoutProof) parts.push('<div class="note">Voting opens once you submit the payout reference.</div>');
    if (v.extensionCount) parts.push(`<div>Bank delay flagged · extended ${v.extensionCount}/${v.maxExtensions}</div>`);
  } else if (v.resolutionMessage) {
    const good = ['APPROVED', 'EXECUTED'].includes(v.state);
    parts.push(`<div class="note ${good ? 'good' : 'bad'}">${esc(v.resolutionMessage)}</div>`);
  }
  return `<div class="verif">${parts.join('')}</div>`;
}

function renderInvoices() {
  const rows = state.invoices.map((i) => {
    const canSettle = ['RECORDED', 'FAILED'].includes(i.status);
    return `<tr>
      <td><strong>${esc(i.ref)}</strong><div class="muted mono">${esc(i.corridor)}</div></td>
      <td>${esc(i.customer)}</td>
      <td>$${fmt(i.amount)} <span class="muted">${esc(i.currency)}</span></td>
      <td><span class="mono">${esc(i.utr || '—')}</span>${i.payer ? `<div class="muted small-inline">${esc(i.payer)}</div>` : ''}</td>
      <td>${badge(i.status)}${verificationBlock(i.verification, { deposit: true })}${i.error && i.status !== 'REJECTED' ? `<div class="err">${esc(i.error)}</div>` : ''}
          ${(i.docs || []).length ? `<div class="muted small-inline">📎 ${i.docs.map(esc).join(', ')}</div>` : ''}
          ${i.status === 'AWAITING_DAO' && i.depositId ? `<input class="file-mini" type="file" data-attach="deposits" data-id="${i.depositId}" data-local="${i.id}" title="Attach another proof document" />` : ''}</td>
      <td>${txLink(i.txHash) || '<span class="muted">—</span>'}</td>
      <td>${canSettle ? `<button class="btn sm primary" data-action="settle" data-id="${i.id}" ${connected() ? '' : 'disabled'}>${i.status === 'FAILED' ? 'Retry' : 'Settle on-chain'}</button>` : ''}
          ${['RECORDED', 'FAILED', 'REJECTED'].includes(i.status) ? `<button class="btn sm" data-action="del-invoice" data-id="${i.id}" title="Remove from XPZ books (local only)">✕</button>` : ''}</td>
    </tr>`;
  });
  setHTML($('#tbl-invoices'), rows.join('') || '<tr><td class="empty" colspan="7">No invoices yet. Record a payment or seed samples.</td></tr>');

  const settled = state.invoices.filter((i) => i.status === 'SETTLED');
  const opts = settled.map((i) => `<option value="${esc(i.ref)}">${esc(i.ref)} — $${fmt(i.amount)} (${esc(i.customer)})</option>`).join('');
  setHTML($('#sel-payout-invoice'), opts || '<option value="">— no settled invoices —</option>');
  setHTML($('#sel-wd-invoice'), opts || '<option value="">— no settled invoices —</option>');
}

function renderPayouts() {
  const rows = state.payouts.map((p) => `<tr>
    <td><strong>${esc(p.ref)}</strong></td>
    <td><span class="mono" title="${esc(p.toAddress)}">${short(p.toAddress)}</span></td>
    <td>$${fmt(p.amount)}</td>
    <td>${badge(p.status)}${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}</td>
    <td>${txLink(p.txHash) || '<span class="muted">—</span>'}</td>
    <td><button class="btn sm" data-action="del-payout" data-id="${p.id}">✕</button></td>
  </tr>`);
  setHTML($('#tbl-payouts'), rows.join('') || '<tr><td class="empty" colspan="6">No payouts yet.</td></tr>');
}

function withdrawalActions(w) {
  const v = w.verification;
  const canExtend = v && v.state === 'PENDING' && v.extensionCount < v.maxExtensions;
  const extendBtn = canExtend ? `<button class="btn sm" data-action="extend-wd" data-id="${w.id}" title="Flag a bank delay">⏱ Bank delay +${live.daoConfig?.extensionMinutes ?? ''}m</button>` : '';
  if (w.status === 'LOCKED') {
    return `<div class="inline-act"><input data-draft="payout:${w.id}" placeholder="Payout UTR" value="${esc(drafts[`payout:${w.id}`] || '')}" /><button class="btn sm primary" data-action="payout-proof" data-id="${w.id}">Submit payout proof</button></div>
      <div class="inline-act"><input class="file-mini" type="file" data-pending="${w.id}" title="Attach the payout receipt" />${extendBtn}</div>`;
  }
  if (w.status === 'PAYOUT_SUBMITTED') {
    return `<div class="muted">Awaiting DAO verification</div>
      <div class="inline-act"><input class="file-mini" type="file" data-attach="withdrawals" data-id="${w.id}" data-local="${w.id}" title="Attach the payout receipt" />${extendBtn}</div>`;
  }
  if (w.status === 'REQUESTED' && !daoOn()) return `<button class="btn sm primary" data-action="fiat-sent" data-id="${w.id}">💸 Fiat sent → close</button>`;
  if (w.status === 'LOCK_PENDING') return '<div class="muted">Locking funds on-chain…</div>';
  return '';
}

function renderWithdrawals() {
  const rows = state.withdrawals.map((w) => {
    const v = w.verification;
    const note = w.status === 'RELEASED' || w.status === 'SETTLED' ? w.message : null;
    return `<tr>
      <td><span class="mono">${w.id ? short(w.id) : '—'}</span></td>
      <td><strong>${esc(w.ref)}</strong></td>
      <td>$${fmt(w.amount)}</td>
      <td>${esc(w.bank?.holder || '')}<div class="muted mono">${esc(w.bank?.accountNumber || '')} · ${esc(w.bank?.ifsc || '')}</div></td>
      <td>${badge(w.status)}${(w.docs || []).length ? `<div class="muted small-inline">📎 ${w.docs.map(esc).join(', ')}</div>` : ''}${v && v.state === 'PENDING' ? verificationBlock(v) : ''}${note ? `<div class="verif"><div class="note ${w.status === 'SETTLED' ? 'good' : 'bad'}">${esc(note)}</div></div>` : ''}${w.error ? `<div class="err">${esc(w.error)}</div>` : ''}</td>
      <td>${txLink(w.lockTxHash, 'lock')}${txLink(w.burnTxHash, 'burn')}${txLink(w.releaseTxHash, 'release')}${!w.lockTxHash && !w.burnTxHash && !w.releaseTxHash ? '<span class="muted">—</span>' : ''}</td>
      <td>${withdrawalActions(w)}</td>
    </tr>`;
  });
  setHTML($('#tbl-withdrawals'), rows.join('') || '<tr><td class="empty" colspan="7">No withdrawal requests yet.</td></tr>');
}

/* ── DAO console rendering ── */
function renderDaoHeader() {
  const badgeEl = $('#dao-badge');
  badgeEl.textContent = live.needsMyVote;
  badgeEl.classList.toggle('hidden', !live.needsMyVote);

  const c = live.daoConfig;
  setHTML($('#dao-config'), c
    ? (c.enabled
      ? `<span>Quorum</span><b>${c.quorum} of ${c.activeMembers}</b><span>Deposit window</span><b>${c.depositWindowMinutes} min</b>
         <span>Withdrawal window</span><b>${c.withdrawalWindowMinutes} min</b><span>Extensions</span><b>${c.maxExtensions} × ${c.extensionMinutes} min</b>`
      : '<span>DAO verification is <b>disabled</b> on the server (DAO_VERIFICATION_ENABLED=false). Deposits mint immediately.</span>')
    : '<span>Could not load DAO settings.</span>');

  const m = activeMember();
  setHTML($('#dao-member-chips'), state.dao.members.length
    ? state.dao.members.map((x) => `<button class="chip ${m && x.id === m.id ? 'active' : ''}" data-action="switch-member" data-id="${x.id}">${esc(x.name)}${m && x.id === m.id && live.needsMyVote ? `<span class="n">${live.needsMyVote}</span>` : ''}</button>`).join('')
    : '<button class="btn primary" data-action="add-members">Add demo DAO members</button>');

  const pending = live.proposals.filter((p) => p.state === 'PENDING').length;
  $('#f-mine').textContent = live.needsMyVote;
  $('#f-pending').textContent = pending;
  $$('[data-dao-filter]').forEach((b) => b.classList.toggle('active', b.dataset.daoFilter === state.dao.filter));
}

function proposalCard(p) {
  const m = activeMember();
  const isDeposit = p.type === 'DEPOSIT';
  const ev = p.evidence;
  const bank = p.withdrawal?.bankDetails || {};
  const evidenceRows = isDeposit
    ? `<dt>Bank reference</dt><dd class="mono">${esc(ev.bankReference || '—')}</dd>
       <dt>Payer</dt><dd>${esc(ev.payerName || '—')}</dd>
       <dt>Notes</dt><dd>${esc(ev.notes || '—')}</dd>
       <dt>Proof hash</dt><dd class="mono">${short(ev.documentHash)}</dd>
       <dt>Mints to</dt><dd class="mono">${short(p.providerAddress)}</dd>`
    : `<dt>Pay to</dt><dd>${esc(bank.holder || '—')}</dd>
       <dt>Account · IFSC</dt><dd class="mono">${esc(bank.accountNumber || '—')} · ${esc(bank.ifsc || '—')}</dd>
       <dt>Payout reference</dt><dd class="${ev.payoutReference ? 'mono' : 'waiting'}">${ev.payoutReference ? esc(ev.payoutReference) : 'Waiting for the client to pay out and report it'}</dd>
       <dt>Locked on-chain</dt><dd class="mono">${p.outcome.lockTxHash ? short(p.outcome.lockTxHash) : '<span class="waiting">locking…</span>'}</dd>
       <dt>From wallet</dt><dd class="mono">${short(p.providerAddress)}</dd>`;

  const docs = (p.documents || []).map((d) => {
    const open = live.openDocs.has(d.documentId) && live.docUrls[d.documentId];
    const preview = !open ? '' : d.mimeType.startsWith('image/')
      ? `<div class="doc-preview"><img src="${live.docUrls[d.documentId]}" alt="${esc(d.filename)}" /></div>`
      : `<div class="doc-preview"><iframe src="${live.docUrls[d.documentId]}" title="${esc(d.filename)}"></iframe></div>`;
    return `<div class="doc">
        <span>${d.mimeType.startsWith('image/') ? '🖼️' : d.mimeType === 'application/pdf' ? '📄' : '📎'}</span>
        <span class="name" title="${esc(d.filename)}">${esc(d.filename)}</span>
        <span class="meta">${d.sizeBytes < 1024 ? `${d.sizeBytes} B` : `${Math.round(d.sizeBytes / 1024)} KB`} · ${esc(d.sha256.slice(0, 10))}…</span>
        <button class="btn sm" data-action="${d.viewable ? 'doc-view' : 'doc-save'}" data-id="${d.documentId}">${open ? 'Hide' : d.viewable ? 'View' : 'Download'}</button>
      </div>${preview}`;
  }).join('');

  const votes = p.votes.list.map((v) => `<div class="vote ${v.decision}"><b>${v.decision === 'APPROVE' ? '✓' : '✕'} ${esc(v.memberName.replace(/ #\w+$/, ''))}</b> <span class="c">${v.comment ? `“${esc(v.comment)}”` : ''}</span></div>`).join('')
    || '<div class="muted small-inline">No votes yet.</div>';

  let actions = '';
  const input = `<input data-draft="vote:${p.proposalId}" placeholder="Comment (required to reject) or extension reason" value="${esc(drafts[`vote:${p.proposalId}`] || '')}" />`;
  const canExtend = p.state === 'PENDING' && p.window.extensionCount < p.window.maxExtensions;
  const extendBtn = canExtend ? `<button class="btn" data-action="dao-extend" data-id="${p.proposalId}">⏱ Extend +${p.window.extensionMinutes}m</button>` : '';
  if (p.state === 'PENDING') {
    if (p.canVote) {
      actions = `<div class="p-actions">${input}<button class="btn approve" data-action="vote-approve" data-id="${p.proposalId}">Approve</button><button class="btn reject" data-action="vote-reject" data-id="${p.proposalId}">Reject</button>${extendBtn}</div>`;
    } else if (p.myVote) {
      actions = `<div class="p-status wait">You (${esc(m?.name || '')}) voted ${p.myVote}. Waiting for other members — ${p.votes.for}/${p.votes.quorumRequired} approvals.</div>${canExtend ? `<div class="p-actions">${input}${extendBtn}</div>` : ''}`;
    } else if (p.awaitingPayoutProof) {
      actions = `<div class="p-status wait">Funds are locked. Voting opens when the client pays the customer and submits the payout reference.</div>${canExtend ? `<div class="p-actions">${input}${extendBtn}</div>` : ''}`;
    }
  } else {
    const good = ['APPROVED', 'EXECUTED'].includes(p.state);
    const tx = [txLink(p.outcome.executeTxHash, isDeposit ? 'mint' : 'burn'), txLink(p.outcome.releaseTxHash, 'release')].join('');
    actions = `<div class="p-status ${good ? 'good' : 'bad'}">${esc(p.outcome.resolutionMessage || p.state)}${tx ? `<div style="margin-top:6px">${tx}</div>` : ''}</div>`;
  }

  const timeline = p.timeline.map((e) => `<li class="${esc(e.type)}"><span class="t">${when(e.createdAt)}</span>${esc(e.message.replace(/ #\w+/g, ''))}</li>`).join('');

  return `<div class="proposal ${p.canVote ? 'needs' : ''}">
    <div class="p-head">
      <div>
        <div class="p-title">${badge(p.type)}<span class="p-amount">$${fmt(p.amount)}</span>${badge(p.state === 'PENDING' ? 'PENDING_VOTE' : p.state, p.state === 'PENDING' ? 'AWAITING VOTES' : p.state)}</div>
        <div class="p-meta">${esc(p.client.name)} · ${esc(p.referenceId)} · opened ${when(p.createdAt)}</div>
      </div>
      <div class="p-right">
        ${p.state === 'PENDING' ? `<div>Window closes in ${countdown(p.window.expiresAt)}</div>` : ''}
        ${p.window.bankDelayFlagged ? `<div class="muted">Bank delay flagged · extended ${p.window.extensionCount}/${p.window.maxExtensions}</div>` : ''}
      </div>
    </div>
    <div class="p-grid">
      <div class="evidence"><h4>Evidence to verify</h4><dl class="kv">${evidenceRows}</dl>
        ${docs ? `<div class="docs">${docs}</div>` : '<div class="muted small-inline" style="margin-top:8px">No supporting documents attached.</div>'}</div>
      <div class="votes"><h4>Votes</h4><div class="tally">${voteBar({ ...p.votes, votesFor: p.votes.for, votesAgainst: p.votes.against })} ${p.votes.for} of ${p.votes.quorumRequired} approvals · ${p.votes.against} against</div><div class="vote-list">${votes}</div></div>
    </div>
    ${actions}
    <details class="timeline"><summary>Timeline · ${p.timeline.length} events</summary><ol>${timeline}</ol></details>
  </div>`;
}

function renderDaoList() {
  const list = $('#dao-list');
  if (!daoOn()) { setHTML(list, '<div class="empty-card">DAO verification is not enabled on this server.</div>'); return; }
  if (!state.dao.members.length) { setHTML(list, '<div class="empty-card">Add demo DAO members to start verifying.<br /><br /><button class="btn primary" data-action="add-members">Add demo DAO members</button></div>'); return; }
  const f = state.dao.filter;
  const items = live.proposals.filter((p) => (f === 'MINE' ? p.canVote : f === 'PENDING' ? p.state === 'PENDING' : true));
  setHTML(list, items.length
    ? items.map(proposalCard).join('')
    : `<div class="empty-card">${f === 'MINE' ? `Nothing needs ${esc(activeMember()?.name || 'your')} vote right now.` : 'No verification requests yet.'}</div>`);
}

function renderSettings() {
  guarded('#form-settings', () => {
    const f = $('#form-settings');
    f.baseUrl.value = state.config.baseUrl; f.apiKey.value = state.config.apiKey; f.clientId.value = state.config.clientId || ''; f.wallet.value = state.config.wallet || '';
  });
  guarded('#form-onboard', () => { $('#form-onboard').company.value = state.config.company || 'XPZ Corp'; });
}

function renderSettingsMembers() {
  setHTML($('#settings-members'), state.dao.members.length
    ? state.dao.members.map((m) => `<div class="m"><span>${esc(m.name)}</span><span class="muted mono">${esc(m.id.slice(0, 8))}</span></div>`).join('')
    : '<div class="muted">No DAO members yet.</div>');
}

function renderLog() {
  $('#log-count').textContent = state.log.length;
  const cls = (s) => (typeof s === 'number' ? `s${String(s)[0]}` : 'sN');
  setHTML($('#log'), state.log.length ? state.log.map((e) => `<details>
    <summary><span class="method ${esc(e.method)}">${esc(e.method)}</span><span>${esc(e.path)}</span><span class="status ${cls(e.status)}">${esc(e.status)}</span>${e.dao ? '<span class="muted">as DAO member</span>' : ''}${e.idem ? `<span class="muted">idem:${esc(e.idem)}</span>` : ''}<span class="ms">${Math.round(e.ms)} ms · ${when(e.at)}</span></summary>
    ${e.req ? `<div class="pre-label">Request</div><pre>${esc(JSON.stringify(e.req, null, 2))}</pre>` : ''}
    <div class="pre-label">Response</div><pre>${esc(JSON.stringify(e.res, null, 2))}</pre>
  </details>`).join('') : '<div class="muted">No API calls yet.</div>');
}

function tickCountdowns() {
  $$('[data-expires]').forEach((el) => {
    const s = Math.round((new Date(el.dataset.expires).getTime() - Date.now()) / 1000);
    if (s <= 0) { el.textContent = 'closing…'; el.classList.add('urgent'); return; }
    const m = Math.floor(s / 60), sec = String(s % 60).padStart(2, '0');
    el.textContent = m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${sec}`;
    el.classList.toggle('urgent', s < 60);
  });
}

/* ── wiring ────────────────────────────────────────────────────────────── */
function showTab(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  if (name === 'dao') loadProposals().then(render);
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

document.addEventListener('input', (e) => {
  const key = e.target.dataset?.draft;
  if (key) drafts[key] = e.target.value;
});

// File inputs: either upload straight away, or hold the file until the record exists.
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.type !== 'file' || !el.files?.length) return;
  const file = el.files[0];
  if (el.dataset.attach) {
    attachDoc(el.dataset.attach, el.dataset.id, file, el.dataset.local);
    el.value = '';
  } else if (el.dataset.pending) {
    pendingDocs[el.dataset.pending] = file;
    toast(`${file.name} will be attached with the payout reference`, 'info');
  }
});

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]'); if (go) showTab(go.dataset.goto);
  const filt = e.target.closest('[data-dao-filter]');
  if (filt) { state.dao.filter = filt.dataset.daoFilter; save(); renderDaoHeader(); renderDaoList(); tickCountdowns(); return; }
  const a = e.target.closest('[data-action]'); if (!a) return;
  const { action, id } = a.dataset;
  if (action === 'settle') settleInvoice(id);
  if (action === 'payout-proof') submitPayoutProof(id);
  if (action === 'extend-wd') extendWithdrawal(id);
  if (action === 'fiat-sent') confirmFiatSentDirect(id);
  if (action === 'vote-approve') castVote(id, 'APPROVE');
  if (action === 'vote-reject') castVote(id, 'REJECT');
  if (action === 'dao-extend') extendProposal(id);
  if (action === 'register-wallet') registerOwnWallet();
  if (action === 'wallet-approve') decideWallet(id, 'approve');
  if (action === 'wallet-reject') decideWallet(id, 'reject');
  if (action === 'wallet-revoke') decideWallet(id, 'revoke');
  if (action === 'doc-view' || action === 'doc-save') {
    if (live.openDocs.has(id)) { live.openDocs.delete(id); render(); } else loadDocPreview(id);
  }
  if (action === 'add-members') addDemoMembers().catch((err) => toast(err.message, 'bad'));
  if (action === 'switch-member') {
    state.dao.activeMemberId = id; save();
    toast(`Now acting as ${activeMember().name}`, 'info');
    loadProposals().then(render);
  }
  if (action === 'del-invoice') { state.invoices = state.invoices.filter((i) => i.id !== id); save(); render(); }
  if (action === 'del-payout') { state.payouts = state.payouts.filter((p) => p.id !== id); save(); render(); }
});

$('#form-payment').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  const ref = f.invoice.value.trim();
  recordPayment({ customer: f.customer.value.trim(), invoice: ref, amount: f.amount.value, currency: f.currency.value.trim() || 'USD', corridor: f.corridor.value.trim(), utr: f.utr.value.trim(), payer: f.payer.value.trim() });
  // Hold the file in memory; it is uploaded once the deposit exists on settle.
  const created = invoiceByRef(ref);
  if (created && f.doc.files?.length) {
    pendingDocs[created.id] = f.doc.files[0];
    toast(`${f.doc.files[0].name} will be attached when you settle ${ref}`, 'info');
  }
  ['customer', 'invoice', 'amount', 'utr', 'payer'].forEach((k) => { f[k].value = ''; });
  f.doc.value = '';
});
$('#btn-seed').addEventListener('click', () => {
  const n = Date.now().toString().slice(-5);
  [['Alice Sharma', 1000, 'ICIC', 'NEFT from ICICI a/c ending 4411'], ['Bob Mehta', 2500, 'HDFC', 'IMPS from HDFC a/c ending 0932'], ['Carol Iyer', 750, 'SBIN', 'RTGS from SBI a/c ending 7710']]
    .forEach(([c, a, bank, payer], i) => recordPayment({ customer: c, invoice: `INV-${n}-${i + 1}`, amount: a, currency: 'USD', corridor: 'IN-IN', utr: randomUtr(bank), payer }));
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
  requestWithdrawal(f.ref.value, { holder: f.holder.value.trim(), accountNumber: f.account.value.trim(), ifsc: f.ifsc.value.trim() }, f.window.value);
});
$('#form-onboard').addEventListener('submit', async (e) => {
  e.preventDefault(); const f = e.target;
  try { await onboard(f.company.value.trim(), f.wallet.value.trim()); showTab('dashboard'); } catch (err) { toast(err.message, 'bad'); }
});
$('#btn-gen-wallet').addEventListener('click', () => { $('#form-onboard').wallet.value = randomAddress(); });
$('#btn-add-members').addEventListener('click', () => addDemoMembers().catch((err) => toast(err.message, 'bad')));
$('#form-settings').addEventListener('submit', (e) => {
  e.preventDefault(); const f = e.target;
  state.config.baseUrl = f.baseUrl.value.trim().replace(/\/$/, ''); state.config.apiKey = f.apiKey.value.trim();
  save(); render(); checkHealth(); toast('Settings saved', 'ok');
});
$('#btn-toggle-key').addEventListener('click', (e) => { const i = $('#form-settings').apiKey; i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'Show' : 'Hide'; });
$('#btn-test-conn').addEventListener('click', async () => {
  await checkHealth();
  if (!state.config.apiKey) return toast('API online. Onboard to get an API key.', 'warn');
  try { const r = await api('GET', '/client'); toast(`Authenticated as ${r.data.name} (${r.data.BlockchainAccounts?.length || 0} wallet)`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
});
$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Clear all XPZ demo data (invoices, payouts, withdrawals, API key, DAO members)?')) return;
  // Stop this browser's demo members counting toward the DAO before forgetting their tokens.
  for (const m of state.dao.members) { try { await api('POST', '/dao/members/me/deactivate', { dao: m.token, quiet: true }); } catch {} }
  state = defaultState(); live.proposals = []; live.needsMyVote = 0; live.seen = null; save(); render(); checkHealth();
});
$('#btn-clear-log').addEventListener('click', () => { state.log = []; save(); renderLog(); });

render();
checkHealth().then(loadWallets).then(refreshAll);
setInterval(refreshAll, REFRESH_MS);
setInterval(tickCountdowns, 1000);
setInterval(loadDaoConfig, 15000);
