import { SettlementV2Service, PROPOSAL_STATE, PROPOSAL_TYPE } from '../../src/blockchain/SettlementV2Service';

// Runs in mock mode (tests/env.setup.ts sets BLOCKCHAIN_MODE=mock), so no v2
// addresses are required and nothing touches the network.
describe('SettlementV2Service (mock mode)', () => {
  let svc: SettlementV2Service;

  beforeEach(() => {
    svc = new SettlementV2Service();
  });

  describe('enum ordering matches the Solidity enums', () => {
    it('ProposalState indices match IDAOGovernor.ProposalState', () => {
      expect(PROPOSAL_STATE).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED']);
    });

    it('ProposalType indices match IDAOGovernor.ProposalType', () => {
      expect(PROPOSAL_TYPE).toEqual(['DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER']);
    });
  });

  describe('reference and document hashing', () => {
    it('maps a business reference to a deterministic bytes32', () => {
      const a = SettlementV2Service.referenceToBytes32('DEP-2026-0001');
      const b = SettlementV2Service.referenceToBytes32('DEP-2026-0001');
      expect(a).toBe(b);
      expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('maps different references to different keys', () => {
      expect(SettlementV2Service.referenceToBytes32('DEP-1')).not.toBe(
        SettlementV2Service.referenceToBytes32('DEP-2'),
      );
    });

    it('hashes proof documents to bytes32', () => {
      expect(SettlementV2Service.hashDocument('bank statement body')).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe('two-phase flow', () => {
    it('requestMint returns a proposal id', async () => {
      await expect(svc.requestMint('0xprovider', '1000', 'DEP-1')).resolves.toMatch(/^\d+$/);
    });

    it('requestBurn returns a proposal id', async () => {
      await expect(svc.requestBurn('0xprovider', '500', '0xpayouthash')).resolves.toMatch(/^\d+$/);
    });

    it('requestInternalTransfer returns a proposal id', async () => {
      await expect(svc.requestInternalTransfer('0xfrom', '0xto', '250')).resolves.toMatch(/^\d+$/);
    });

    it('executeMint resolves with a tx hash', async () => {
      await expect(svc.executeMint('1')).resolves.toMatch(/^0xmock_execute_mint_\d+$/);
    });

    it('executeBurn resolves with a tx hash', async () => {
      await expect(svc.executeBurn('1')).resolves.toMatch(/^0xmock_execute_burn_\d+$/);
    });

    it('executeInternalTransfer resolves with a tx hash', async () => {
      await expect(svc.executeInternalTransfer('1', '0xto')).resolves.toMatch(/^0xmock_execute_transfer_\d+$/);
    });
  });

  describe('registries', () => {
    it('submitProof resolves with a tx hash', async () => {
      await expect(svc.submitProof('DEP-1', SettlementV2Service.hashDocument('x'))).resolves.toMatch(
        /^0xmock_proof_\d+$/,
      );
    });

    it('onboardProvider resolves with a tx hash', async () => {
      await expect(svc.onboardProvider('0xprovider', 'Acme', true)).resolves.toMatch(/^0xmock_onboard_\d+$/);
    });

    it('isProviderApproved and isProofValid resolve', async () => {
      await expect(svc.isProviderApproved('0xprovider')).resolves.toBe(true);
      await expect(svc.isProofValid('DEP-1')).resolves.toBe(true);
    });
  });

  describe('reads', () => {
    it('getProposal returns a shaped proposal', async () => {
      const p = await svc.getProposal('1');
      expect(p.exists).toBe(true);
      expect(PROPOSAL_STATE).toContain(p.state);
      expect(PROPOSAL_TYPE).toContain(p.proposalType);
    });

    it('getQuorumThreshold returns a number', async () => {
      await expect(svc.getQuorumThreshold()).resolves.toBe(3);
    });

    it('formatAmount converts base units back to a decimal string', () => {
      expect(svc.formatAmount(1000000000000000000n)).toBe('1.0');
    });

    it('preflight is a no-op in mock mode', async () => {
      await expect(svc.preflight()).resolves.toBeUndefined();
    });
  });
});
