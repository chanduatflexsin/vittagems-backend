/**
 * End-to-end test of DAO verification against the running stack and live chain.
 * Requires DAO_VERIFICATION_ENABLED=true and the API on :3000.
 *
 *   node scripts/e2e-dao.mjs            full run (includes a ~70s window-expiry wait)
 *   node scripts/e2e-dao.mjs --no-expiry  skip the expiry scenario
 */
import { ethers } from 'ethers';

const BASE = 'http://localhost:3000/api/v1';
const RPC = 'http://localhost:8551';
const SETTLEMENT = process.env.VITTAGEM_CONTRACT_ADDRESS || '0xE397992D53d9cb98Fe0e9AF00010de3d59096196';
const SKIP_EXPIRY = process.argv.includes('--no-expiry');
const run = Date.now().toString().slice(-6);
const STATUS = ['CREATED', 'COMPLIANCE_APPROVED', 'MINTED', 'TRANSFERRED', 'PAYOUT_CONFIRMED', 'CLOSED', 'ON_HOLD', 'FROZEN'];

const net = new ethers.Network('quorum', 7001n);
const chain = new ethers.Contract(
  SETTLEMENT,
  ['function getSettlement(string) view returns (tuple(string referenceId, address partner, uint256 amount, uint8 status, uint256 createdAt, uint256 updatedAt, string corridor))'],
  new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net }),
);
const onChain = async (ref) => STATUS[Number((await chain.getSettlement(ref)).status)];

let apiKey = '';
const wallet = ethers.Wallet.createRandom().address;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, pred, tries = 45, gap = 2000) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await sleep(gap);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

async function depositAndMint(tag, amount) {
  const ref = `INV-${run}-${tag}`;
  const dep = await call('POST', '/deposits', {
    body: { amount, currency: 'USD', referenceId: ref, proof: { bankReference: `UTR-${run}-${tag}`, payerName: 'Alice Sharma' } },
  });
  const mint = await call('POST', '/mint', { idem: `mint-${run}-${tag}`, body: { amount, referenceId: ref, toAddress: wallet, corridor: 'IN-IN' } });
  return { ref, dep, mint, proposalId: dep.data?.verification?.proposalId };
}

async function main() {
  console.log(`DAO verification E2E  (run ${run})\n`);

  const reg = await call('POST', '/clients/register', {
    body: { name: `XPZ DAO E2E ${run}`, permissions: ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'], blockchainAddress: wallet },
  });
  apiKey = reg.data.apiKey;
  const members = [];
  for (const name of ['Priya', 'Rahul', 'Meera']) members.push({ name, token: (await call('POST', '/dao/members', { body: { name: `${name} ${run}` } })).data.token });
  const [m1, m2] = members;

  // ── 1. deposit approved ────────────────────────────────────────
  console.log('1) Deposit -> DAO approves -> minted');
  const a = await depositAndMint('A', '1000');
  check('deposit waits for verification', a.dep.data.status === 'PENDING_VERIFICATION');
  check('mint is held, not sent to chain', a.mint.data.status === 'AWAITING_APPROVAL');
  check('a member can vote on the pending deposit', (await call('GET', `/dao/proposals/${a.proposalId}`, { dao: m1.token })).data.canVote === true);
  await call('POST', `/dao/proposals/${a.proposalId}/votes`, { dao: m1.token, body: { decision: 'APPROVE', comment: 'UTR matches statement' } });
  check('still held after 1 of 2 approvals', (await call('GET', `/mint/${a.mint.data.transactionId}`)).data.status === 'AWAITING_APPROVAL');
  const dupe = await call('POST', `/dao/proposals/${a.proposalId}/votes`, { dao: m1.token, body: { decision: 'APPROVE' } });
  check('a member cannot vote twice', dupe.status === 409);
  await call('POST', `/dao/proposals/${a.proposalId}/votes`, { dao: m2.token, body: { decision: 'APPROVE', comment: 'confirmed' } });
  const mintA = await until('mint A confirmed', () => call('GET', `/mint/${a.mint.data.transactionId}`), (r) => ['CONFIRMED', 'FAILED'].includes(r.data.status));
  check('minted on-chain after quorum', mintA.data.status === 'CONFIRMED', mintA.data.blockchainTxHash);
  check('on-chain settlement is MINTED', (await onChain(a.ref)) === 'MINTED');

  // ── 2. deposit rejected ────────────────────────────────────────
  console.log('\n2) Deposit -> DAO rejects -> nothing minted');
  const b = await depositAndMint('B', '500');
  const noComment = await call('POST', `/dao/proposals/${b.proposalId}/votes`, { dao: m1.token, body: { decision: 'REJECT' } });
  check('rejection requires a comment', noComment.status === 400);
  await call('POST', `/dao/proposals/${b.proposalId}/votes`, { dao: m1.token, body: { decision: 'REJECT', comment: 'UTR not on statement' } });
  await call('POST', `/dao/proposals/${b.proposalId}/votes`, { dao: m2.token, body: { decision: 'REJECT', comment: 'no matching credit' } });
  const mintB = await call('GET', `/mint/${b.mint.data.transactionId}`);
  check('mint failed with the DAO reason', mintB.data.status === 'FAILED', mintB.data.failureReason);
  check('verification state REJECTED', mintB.data.verification?.state === 'REJECTED');
  const onB = await chain.getSettlement(b.ref);
  check('nothing exists on-chain for the rejected deposit', onB.createdAt === 0n);

  // ── 3. withdrawal verified -> burn ─────────────────────────────
  console.log('\n3) Withdrawal -> lock -> payout proof -> bank delay extension -> DAO approves -> burned');
  const w = await call('POST', '/withdrawals', {
    idem: `wd-${run}-A`,
    body: { amount: '1000', bankDetails: { holder: 'Alice Sharma', accountNumber: '0001', ifsc: 'HDFC0001' }, fromAddress: wallet, referenceId: a.ref },
  });
  check('withdrawal starts by locking funds', w.data.status === 'LOCK_PENDING');
  const wId = w.data.withdrawalId; const wProp = w.data.verification.proposalId;
  const dupW = await call('POST', '/withdrawals', { idem: `wd-${run}-A2`, body: { amount: '1000', bankDetails: {}, fromAddress: wallet, referenceId: a.ref } });
  check('a second withdrawal of the same settlement is refused', dupW.status === 409);
  await until('withdrawal locked', () => call('GET', `/withdrawals/${wId}`), (r) => r.data.status === 'LOCKED');
  check('on-chain settlement is ON_HOLD (locked)', (await onChain(a.ref)) === 'ON_HOLD');
  const early = await call('POST', `/dao/proposals/${wProp}/votes`, { dao: m1.token, body: { decision: 'APPROVE' } });
  check('DAO cannot vote before the payout reference exists', early.status === 409);
  const proofRes = await call('POST', `/withdrawals/${wId}/payout-proof`, { body: { payoutReference: `PAYOUT-${run}-A`, notes: 'IMPS' } });
  check('payout reference accepted', proofRes.data.status === 'PAYOUT_SUBMITTED');
  const before = new Date(proofRes.data.verification.expiresAt).getTime();
  const ext = await call('POST', `/withdrawals/${wId}/extend`, { body: { reason: 'bank batch settles at 4pm' } });
  check('bank delay extends the window', ext.data.verification.extensionCount === 1 && new Date(ext.data.verification.expiresAt).getTime() > before);
  await call('POST', `/dao/proposals/${wProp}/votes`, { dao: m1.token, body: { decision: 'APPROVE', comment: 'payout on statement' } });
  await call('POST', `/dao/proposals/${wProp}/votes`, { dao: m2.token, body: { decision: 'APPROVE', comment: 'ok' } });
  const settled = await until('withdrawal settled', () => call('GET', `/withdrawals/${wId}`), (r) => ['SETTLED', 'FAILED'].includes(r.data.status), 60);
  check('withdrawal SETTLED', settled.data.status === 'SETTLED', settled.data.blockchainTxHash);
  check('on-chain settlement is CLOSED (burned)', (await onChain(a.ref)) === 'CLOSED');

  // ── 4. withdrawal rejected -> released ─────────────────────────
  console.log('\n4) Withdrawal -> lock -> DAO rejects payout -> funds released');
  const c = await depositAndMint('C', '750');
  await call('POST', `/dao/proposals/${c.proposalId}/votes`, { dao: m1.token, body: { decision: 'APPROVE' } });
  await call('POST', `/dao/proposals/${c.proposalId}/votes`, { dao: m2.token, body: { decision: 'APPROVE' } });
  await until('mint C', () => call('GET', `/mint/${c.mint.data.transactionId}`), (r) => r.data.status === 'CONFIRMED');
  const wc = await call('POST', '/withdrawals', { idem: `wd-${run}-C`, body: { amount: '750', bankDetails: { holder: 'Bob' }, fromAddress: wallet, referenceId: c.ref } });
  await until('C locked', () => call('GET', `/withdrawals/${wc.data.withdrawalId}`), (r) => r.data.status === 'LOCKED');
  await call('POST', `/withdrawals/${wc.data.withdrawalId}/payout-proof`, { body: { payoutReference: `PAYOUT-${run}-C` } });
  await call('POST', `/dao/proposals/${wc.data.verification.proposalId}/votes`, { dao: m1.token, body: { decision: 'REJECT', comment: 'payout bounced' } });
  await call('POST', `/dao/proposals/${wc.data.verification.proposalId}/votes`, { dao: m2.token, body: { decision: 'REJECT', comment: 'not received by customer' } });
  const released = await until('C released', () => call('GET', `/withdrawals/${wc.data.withdrawalId}`), (r) => ['RELEASED', 'FAILED'].includes(r.data.status), 60);
  check('withdrawal RELEASED', released.data.status === 'RELEASED');
  check('client told the withdrawal is not finished', /not yet finished/.test(released.data.message || ''), released.data.message);
  check('on-chain settlement back to MINTED (spendable)', (await onChain(c.ref)) === 'MINTED');

  // ── 5. window expiry -> released ───────────────────────────────
  if (SKIP_EXPIRY) {
    console.log('\n5) (skipped window expiry)');
  } else {
    console.log('\n5) Withdrawal -> lock -> nobody verifies within the 1-minute window -> auto-released');
    const d = await depositAndMint('D', '300');
    await call('POST', `/dao/proposals/${d.proposalId}/votes`, { dao: m1.token, body: { decision: 'APPROVE' } });
    await call('POST', `/dao/proposals/${d.proposalId}/votes`, { dao: m2.token, body: { decision: 'APPROVE' } });
    await until('mint D', () => call('GET', `/mint/${d.mint.data.transactionId}`), (r) => r.data.status === 'CONFIRMED');
    const wd = await call('POST', '/withdrawals', { idem: `wd-${run}-D`, body: { amount: '300', bankDetails: { holder: 'Carol' }, fromAddress: wallet, referenceId: d.ref, windowMinutes: 1 } });
    await until('D locked', () => call('GET', `/withdrawals/${wd.data.withdrawalId}`), (r) => r.data.status === 'LOCKED');
    check('on-chain settlement ON_HOLD while the window is open', (await onChain(d.ref)) === 'ON_HOLD');
    console.log('     waiting for the window to close ...');
    const expired = await until('D expired', () => call('GET', `/withdrawals/${wd.data.withdrawalId}`), (r) => ['RELEASED', 'FAILED'].includes(r.data.status), 60, 3000);
    check('expired withdrawal RELEASED', expired.data.status === 'RELEASED');
    check('verification state EXPIRED', expired.data.verification?.state === 'EXPIRED');
    check('client told the withdrawal is not finished', /not yet finished/.test(expired.data.message || ''), expired.data.message);
    check('on-chain settlement back to MINTED', (await onChain(d.ref)) === 'MINTED');
  }

  // Leave the DAO as we found it: test members stop counting toward the member total.
  for (const m of members) await call('POST', '/dao/members/me/deactivate', { dao: m.token });

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL DAO CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nE2E aborted:', e.message);
  process.exit(1);
});
