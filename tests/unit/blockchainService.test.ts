import { BlockchainService } from '../../src/blockchain/BlockchainService';

// The unit suite runs BlockchainService in mock mode (tests/env.setup.ts sets
// BLOCKCHAIN_MODE=mock), so mint/transfer/reconcile/burn return deterministic
// mock hashes without touching a Quorum node. The constructor still derives a
// real ethers Wallet from BLOCKCHAIN_PRIVATE_KEY (env.setup provides a valid key).
describe('BlockchainService (mock mode)', () => {
  let service: BlockchainService;

  beforeEach(() => {
    service = new BlockchainService();
  });

  it('mint() resolves with a mock tx hash', async () => {
    const hash = await service.mint('VG-REF-1', '0xpartner', '100', 'US-MX');
    expect(hash).toMatch(/^0xmock_mint_tx_hash_\d+$/);
  });

  it('transfer() resolves with a mock tx hash', async () => {
    const hash = await service.transfer('VG-REF-1', '0xto', '10');
    expect(hash).toMatch(/^0xmock_transfer_tx_hash_\d+$/);
  });

  it('reconcile() resolves with a mock tx hash', async () => {
    const hash = await service.reconcile('VG-REF-1');
    expect(hash).toMatch(/^0xmock_reconcile_tx_hash_\d+$/);
  });

  it('burn() resolves with a mock tx hash', async () => {
    const hash = await service.burn('VG-REF-1');
    expect(hash).toMatch(/^0xmock_burn_tx_hash_\d+$/);
  });

  it('closeSettlementForWithdrawal() resolves with a mock burn tx hash', async () => {
    const hash = await service.closeSettlementForWithdrawal('VG-REF-1');
    expect(hash).toMatch(/^0xmock_burn_tx_hash_\d+$/);
  });

  it('registerPartner() resolves with a mock tx hash', async () => {
    const hash = await service.registerPartner('0xpartner', 'Acme US');
    expect(hash).toMatch(/^0xmock_register_partner_\d+$/);
  });

  it('isPartnerApproved() resolves true in mock mode', async () => {
    await expect(service.isPartnerApproved('0xpartner')).resolves.toBe(true);
  });

  it('ensureOperatorRoles() is a no-op in mock mode', async () => {
    await expect(service.ensureOperatorRoles()).resolves.toBeUndefined();
  });

  it('getTransactionStatus() resolves CONFIRMED for any hash', async () => {
    const status = await service.getTransactionStatus('0xanyhash');
    expect(status).toBe('CONFIRMED');
  });
});
