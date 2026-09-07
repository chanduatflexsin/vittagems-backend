/**
 * Live on-chain settlement verification.
 *
 * Drives the backend's own BlockchainService against the running VittaGems
 * Quorum network to prove the full settlement lifecycle works end-to-end:
 *   ensureOperatorRoles -> registerPartner -> mint -> transfer -> reconcile -> burn
 *
 * Requires: the Quorum network up on QUORUM_RPC_URL, BLOCKCHAIN_MODE=live,
 * and a funded/permissioned operator key in BLOCKCHAIN_PRIVATE_KEY.
 *
 * Run:  npx ts-node scripts/verify-onchain.ts
 */
import { ethers } from 'ethers';
import { blockchainService } from '../src/blockchain/BlockchainService';
import { env } from '../src/config/env';

function log(step: string, msg: string) {
  console.log(`  [${step}] ${msg}`);
}

async function main() {
  console.log('============================================================');
  console.log('  VittaGems — Live On-Chain Settlement Verification');
  console.log('============================================================');
  console.log(`  RPC:      ${env.QUORUM_RPC_URL}`);
  console.log(`  ChainId:  ${env.QUORUM_CHAIN_ID}`);
  console.log(`  Contract: ${env.VITTAGEM_CONTRACT_ADDRESS}`);
  console.log(`  Mode:     ${env.BLOCKCHAIN_MODE}`);
  console.log(`  Operator: ${(blockchainService as any).signerAddress}`);
  console.log('');

  if (env.BLOCKCHAIN_MODE !== 'live') {
    console.error('  ✗ BLOCKCHAIN_MODE is not "live" — set it to run a real verification.');
    process.exit(1);
  }

  const runId = Date.now();
  const refId = `VG-BACKEND-${runId}`;
  const corridor = 'US-MX';
  const amount = '1000'; // 1000 units -> 1000e18 on-chain
  const partner1 = ethers.Wallet.createRandom().address;
  const partner2 = ethers.Wallet.createRandom().address;

  log('1', 'Ensuring operator roles (SETTLEMENT_AGENT + COMPLIANCE_OPERATOR)...');
  await blockchainService.ensureOperatorRoles();
  console.log('    ✓ roles ensured');

  log('2', `Registering partner1 ${partner1}...`);
  await blockchainService.registerPartner(partner1, 'Acme US Provider');
  await blockchainService.registerPartner(partner2, 'LatAm Regional Partner');
  console.log(`    ✓ approved: p1=${await blockchainService.isPartnerApproved(partner1)}, p2=${await blockchainService.isPartnerApproved(partner2)}`);

  log('3', `Minting ${amount} to partner1 (ref=${refId})...`);
  const mintHash = await blockchainService.mint(refId, partner1, amount, corridor);
  console.log(`    ✓ mint tx: ${mintHash} (${await blockchainService.getTransactionStatus(mintHash)})`);

  let s = await blockchainService.getSettlement(refId);
  console.log(`    settlement: status=${s.status} amount=${ethers.formatUnits(s.amount, env.SETTLEMENT_TOKEN_DECIMALS)} partner=${s.partner}`);
  console.log(`    partner1 balance: ${ethers.formatUnits(await blockchainService.getOutstandingBalance(partner1), env.SETTLEMENT_TOKEN_DECIMALS)}`);

  log('4', `Transferring settlement ${refId} -> partner2...`);
  const transferHash = await blockchainService.transfer(refId, partner2, amount);
  s = await blockchainService.getSettlement(refId);
  console.log(`    ✓ transfer tx: ${transferHash} | status now: ${s.status}`);

  log('5', `Reconciling ${refId} (off-chain payout confirmed)...`);
  const reconcileHash = await blockchainService.reconcile(refId);
  s = await blockchainService.getSettlement(refId);
  console.log(`    ✓ reconcile tx: ${reconcileHash} | status now: ${s.status}`);

  log('6', `Burning ${refId} (settlement closure)...`);
  const burnHash = await blockchainService.burn(refId);
  s = await blockchainService.getSettlement(refId);
  console.log(`    ✓ burn tx: ${burnHash} | status now: ${s.status}`);

  console.log('');
  console.log('  ── Withdrawal redemption path (mint -> confirm payout -> burn) ──');
  const wRef = `VG-WITHDRAW-${runId}`;
  const wPartner = ethers.Wallet.createRandom().address;
  log('7', `Registering + minting ${amount} to a withdrawing partner (ref=${wRef})...`);
  await blockchainService.registerPartner(wPartner, 'Withdrawing Partner');
  await blockchainService.mint(wRef, wPartner, amount, corridor);
  let ws = await blockchainService.getSettlement(wRef);
  console.log(`    settlement status: ${ws.status}`);

  log('8', 'Off-chain fiat payout confirmed -> closeSettlementForWithdrawal()...');
  const closeHash = await blockchainService.closeSettlementForWithdrawal(wRef);
  ws = await blockchainService.getSettlement(wRef);
  console.log(`    ✓ close burn tx: ${closeHash} | status now: ${ws.status}`);

  if (ws.status !== 'CLOSED') {
    throw new Error(`Expected CLOSED, got ${ws.status}`);
  }

  console.log('');
  console.log('  ✅ Full settlement lifecycle AND withdrawal redemption succeeded on-chain.');
  process.exit(0);
}

main().catch((err) => {
  console.error('  ✗ Verification failed:', err?.message || err);
  process.exit(1);
});
