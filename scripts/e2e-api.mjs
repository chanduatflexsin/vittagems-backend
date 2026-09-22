/**
 * End-to-end API test that exercises every Swagger endpoint against the running
 * full stack (Express + worker + Postgres + Redis + live Quorum chain).
 *
 * Run (server must be up on :3000):  node scripts/e2e-api.mjs
 */
import { Wallet } from 'ethers';

const BASE = 'http://localhost:3000/api/v1';
const runId = Date.now();
let apiKey = '';

const partnerA = Wallet.createRandom().address; // this client's own wallet
const partnerB = Wallet.createRandom().address; // a counterparty

function hdr(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

async function call(method, path, { body, idem } = {}) {
  const headers = hdr(idem ? { 'Idempotency-Key': idem } : {});
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function line(label, r) {
  const d = r.json?.data ?? r.json;
  console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(d)}`);
}

async function pollMint(id) {
  for (let i = 0; i < 30; i++) {
    const r = await call('GET', `/mint/${id}`);
    const s = r.json?.data?.status;
    if (s === 'CONFIRMED' || s === 'FAILED') return r.json.data;
    await new Promise((x) => setTimeout(x, 1500));
  }
  return { status: 'TIMEOUT' };
}
async function pollTransfer(id) {
  for (let i = 0; i < 30; i++) {
    const r = await call('GET', `/transfers/${id}`);
    const s = r.json?.data?.status;
    if (s === 'CONFIRMED' || s === 'FAILED') return r.json.data;
    await new Promise((x) => setTimeout(x, 1500));
  }
  return { status: 'TIMEOUT' };
}
async function pollWithdrawal(id) {
  for (let i = 0; i < 30; i++) {
    const r = await call('GET', `/withdrawals/${id}`);
    const s = r.json?.data?.status;
    if (s === 'SETTLED' || s === 'FAILED') return r.json.data;
    await new Promise((x) => setTimeout(x, 1500));
  }
  return { status: 'TIMEOUT' };
}

async function mintFlow(tag, amount) {
  const ref = `DEP-${runId}-${tag}`;
  await call('POST', '/deposits', { body: { amount, currency: 'USD', referenceId: ref } });
  const m = await call('POST', '/mint', {
    body: { amount, referenceId: ref, toAddress: partnerA, corridor: 'US-MX' },
    idem: `mint-${runId}-${tag}`,
  });
  line(`mint(${tag}) accept`, m);
  const done = await pollMint(m.json.data.transactionId);
  console.log(`  mint(${tag}) final -> ${done.status} tx=${done.blockchainTxHash}`);
  return { ref, txId: m.json.data.transactionId, status: done.status };
}

async function main() {
  console.log('============================================================');
  console.log('  VittaGems — Full-stack API E2E (Swagger flow)');
  console.log('============================================================');
  console.log(`  partnerA (client wallet): ${partnerA}`);
  console.log(`  partnerB (counterparty):  ${partnerB}\n`);

  // 1) Register client
  const reg = await call('POST', '/clients/register', {
    body: {
      name: `E2E Client ${runId}`,
      permissions: ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'],
      blockchainAddress: partnerA,
    },
  });
  line('register', reg);
  apiKey = reg.json.data.apiKey;
  if (!apiKey) throw new Error('no apiKey returned');

  // 2) Client details (auth check)
  const who = await call('GET', '/client');
  console.log(`  GET /client -> HTTP ${who.status} name=${who.json?.data?.name} accounts=${who.json?.data?.BlockchainAccounts?.length}`);

  console.log('\n── MINT ─────────────────────────────────────────────');
  const a = await mintFlow('A', '1000');

  console.log('\n── TRANSFER ─────────────────────────────────────────');
  const b = await mintFlow('B', '1000');
  const t = await call('POST', '/transfers', {
    body: { amount: '1000', fromAddress: partnerA, toAddress: partnerB, referenceId: b.ref },
    idem: `xfer-${runId}-B`,
  });
  line('transfer accept', t);
  const tDone = await pollTransfer(t.json.data.transactionId);
  console.log(`  transfer final -> ${tDone.status} tx=${tDone.blockchainTxHash}`);

  console.log('\n── WITHDRAWAL (request -> approve -> burn) ───────────');
  const c = await mintFlow('C', '1000');
  const w = await call('POST', '/withdrawals', {
    body: { amount: '1000', bankDetails: { accountNumber: '000123', ifsc: 'HDFC0001' }, fromAddress: partnerA, referenceId: c.ref },
    idem: `wd-${runId}-C`,
  });
  line('withdrawal request', w);
  const appr = await call('POST', `/withdrawals/${w.json.data.withdrawalId}/approve`);
  line('withdrawal approve (payout confirmed)', appr);
  const wDone = await pollWithdrawal(w.json.data.withdrawalId);
  console.log(`  withdrawal final -> ${wDone.status} burnTx=${wDone.blockchainTxHash}`);

  console.log('\n── NEGATIVE CHECKS ──────────────────────────────────');
  const noAuth = await (await fetch(`${BASE}/client`)).status;
  console.log(`  GET /client without token -> HTTP ${noAuth} (expect 401)`);
  const noIdem = await call('POST', '/mint', { body: { amount: '1', referenceId: 'x', toAddress: partnerA } });
  console.log(`  POST /mint without Idempotency-Key -> HTTP ${noIdem.status} ${noIdem.json?.error?.code} (expect 400)`);
  const dupIdem = await call('POST', '/mint', {
    body: { amount: '1000', referenceId: a.ref, toAddress: partnerA },
    idem: `mint-${runId}-A`,
  });
  console.log(`  POST /mint with reused Idempotency-Key -> HTTP ${dupIdem.status} (expect 200 duplicate)`);

  console.log('\n============================================================');
  const ok = a.status === 'CONFIRMED' && tDone.status === 'CONFIRMED' && wDone.status === 'SETTLED';
  console.log(ok ? '  ✅ FULL SWAGGER FLOW PASSED END-TO-END' : '  ⚠️  Some steps did not reach terminal success — see above');
  console.log('============================================================');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E failed:', e);
  process.exit(1);
});
