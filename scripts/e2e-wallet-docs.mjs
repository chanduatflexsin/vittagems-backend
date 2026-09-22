/**
 * Live test of the wallet whitelist and proof documents.
 * Needs the API on :3000 with WALLET_WHITELIST_ENABLED=true and DAO verification on.
 *
 *   node scripts/e2e-wallet-docs.mjs
 */
import { ethers } from 'ethers';
import crypto from 'crypto';

const BASE = 'http://localhost:3000/api/v1';
const run = Date.now().toString().slice(-6);
const wallet = ethers.Wallet.createRandom().address;
const stranger = ethers.Wallet.createRandom().address;
let apiKey = '';
let failures = 0;

async function call(method, path, { body, idem, dao } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && !dao) headers.Authorization = `Bearer ${apiKey}`;
  if (dao) headers['X-DAO-Token'] = dao;
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, error: json.error };
}

/** Upload a file exactly the way the portal does: raw body + Content-Type + X-File-Name. */
async function upload(path, { name, type, bytes }) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-File-Name': name, Authorization: `Bearer ${apiKey}` },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data, error: json.error };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, pred, tries = 40, gap = 2000) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (pred(v)) return v; await sleep(gap); }
  throw new Error(`timed out waiting for: ${label}`);
}
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// A tiny but genuinely valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

async function main() {
  console.log(`Wallet whitelist + proof documents  (run ${run})\n`);

  // ── setup ──
  const reg = await call('POST', '/clients/register', {
    body: {
      name: `XPZ Docs ${run}`,
      permissions: ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'],
      blockchainAddress: wallet,
    },
  });
  apiKey = reg.data.apiKey;
  check('onboarding registers the wallet as PENDING, not usable', reg.data.wallet?.status === 'PENDING');

  const members = [];
  for (const name of ['Priya', 'Rahul']) {
    members.push((await call('POST', '/dao/members', { body: { name: `${name} wd-${run}` } })).data.token);
  }
  const [m1, m2] = members;

  // ── 1. nothing settles to a wallet that is not whitelisted ──
  console.log('1) A wallet must be whitelisted before anything can settle to it');
  const ref = `INV-${run}-A`;
  const dep = await call('POST', '/deposits', {
    body: { amount: '1000', currency: 'USD', referenceId: ref, proof: { bankReference: `UTR-${run}`, payerName: 'Alice Sharma' } },
  });
  const blocked = await call('POST', '/mint', { idem: `m-${run}-1`, body: { amount: '1000', referenceId: ref, toAddress: wallet } });
  check('mint to a PENDING wallet is refused', blocked.status === 403 && blocked.error?.code === 'WALLET_NOT_WHITELISTED', blocked.error?.message);

  const strangerMint = await call('POST', '/mint', { idem: `m-${run}-2`, body: { amount: '1000', referenceId: ref, toAddress: stranger } });
  check('mint to a completely unknown wallet is refused', strangerMint.status === 403, strangerMint.error?.code);

  // ── 2. proof documents ──
  console.log('\n2) Proof documents attached to the deposit');
  const png = await upload(`/deposits/${dep.data.depositId}/documents`, { name: 'receipt.png', type: 'image/png', bytes: PNG });
  check('image accepted', png.status === 201 && png.data.viewable === true, `${png.data?.filename} ${png.data?.sizeBytes}B`);
  const pdf = await upload(`/deposits/${dep.data.depositId}/documents`, { name: 'statement.pdf', type: 'application/pdf', bytes: PDF });
  check('pdf accepted', pdf.status === 201, pdf.data?.sha256?.slice(0, 12));
  check('hash matches the bytes we sent', pdf.data?.sha256 === crypto.createHash('sha256').update(PDF).digest('hex'));

  const bad = await upload(`/deposits/${dep.data.depositId}/documents`, { name: 'virus.exe', type: 'application/x-msdownload', bytes: Buffer.from('MZ') });
  check('executable rejected', bad.status === 400, bad.error?.message?.slice(0, 60));

  // ── 3. DAO whitelists the wallet ──
  console.log('\n3) DAO reviews the wallet and the evidence');
  const queue = await call('GET', '/dao/wallets?status=PENDING', { dao: m1 });
  const mine = queue.data.items.find((w) => w.address === wallet.toLowerCase());
  check('wallet appears in the DAO queue', !!mine, mine?.label);

  const noReason = await call('POST', `/dao/wallets/${mine.walletId}/reject`, { dao: m1, body: {} });
  check('rejecting without a reason is refused', noReason.status === 400);

  const approved = await call('POST', `/dao/wallets/${mine.walletId}/approve`, { dao: m1 });
  check('DAO whitelists the wallet', approved.data?.status === 'ACTIVE', `by ${approved.data?.decidedBy}`);

  // ── 4. the deposit proposal carries the documents ──
  const proposal = await call('GET', `/dao/proposals/${dep.data.verification.proposalId}`, { dao: m1 });
  const docs = proposal.data.documents || [];
  check('DAO sees both documents with the bank reference', docs.length === 2, docs.map((d) => d.filename).join(', '));
  check('bank reference is still there too', proposal.data.evidence.bankReference === `UTR-${run}`);

  const view = await fetch(`${BASE}/dao/documents/${docs[0].documentId}`, { headers: { 'X-DAO-Token': m1 } });
  const body = Buffer.from(await view.arrayBuffer());
  check('DAO can open the document and the bytes are intact', view.ok && body.equals(PNG), `${body.length} bytes, ${view.headers.get('content-type')}`);

  const noToken = await fetch(`${BASE}/dao/documents/${docs[0].documentId}`);
  check('a document is not readable without a DAO token', noToken.status === 401);

  // ── 5. minting now works, and revoking blocks it again ──
  console.log('\n4) Settlement works once whitelisted, and stops if the wallet is revoked');
  const mint = await call('POST', '/mint', { idem: `m-${run}-3`, body: { amount: '1000', referenceId: ref, toAddress: wallet } });
  check('mint is accepted once the wallet is ACTIVE', mint.status === 202, mint.data?.status);

  await call('POST', `/dao/proposals/${dep.data.verification.proposalId}/votes`, { dao: m1, body: { decision: 'APPROVE', comment: 'receipt and statement match' } });
  await call('POST', `/dao/proposals/${dep.data.verification.proposalId}/votes`, { dao: m2, body: { decision: 'APPROVE' } });
  const done = await until('mint confirmed', () => call('GET', `/mint/${mint.data.transactionId}`), (r) => ['CONFIRMED', 'FAILED'].includes(r.data.status));
  check('minted on-chain after DAO approval', done.data.status === 'CONFIRMED', done.data.blockchainTxHash);

  const revoked = await call('POST', `/dao/wallets/${mine.walletId}/revoke`, { dao: m2, body: { reason: 'sanctions screening hit' } });
  check('DAO can revoke an active wallet', revoked.data?.status === 'REVOKED');

  const ref2 = `INV-${run}-B`;
  await call('POST', '/deposits', { body: { amount: '50', currency: 'USD', referenceId: ref2, proof: { bankReference: `UTR-${run}-B` } } });
  const afterRevoke = await call('POST', '/mint', { idem: `m-${run}-4`, body: { amount: '50', referenceId: ref2, toAddress: wallet } });
  check('minting to a revoked wallet is refused, with the reason', afterRevoke.status === 403 && /sanctions screening hit/.test(afterRevoke.error?.message || ''), afterRevoke.error?.message);

  for (const t of members) await call('POST', '/dao/members/me/deactivate', { dao: t });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL WALLET + DOCUMENT CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\naborted:', e.message); process.exit(1); });
