import { ethers } from "ethers";
import { BlockchainService } from "../../src/blockchain/BlockchainService";
import { env } from "../../src/config/env";

// The unit suite runs BlockchainService in mock mode (tests/env.setup.ts sets
// BLOCKCHAIN_MODE=mock), so mint/transfer/reconcile/burn return deterministic
// mock hashes without touching a Quorum node. The constructor still derives a
// real ethers Wallet from BLOCKCHAIN_PRIVATE_KEY (env.setup provides a valid key).
describe("BlockchainService (mock mode)", () => {
  let service: BlockchainService;

  beforeEach(() => {
    service = new BlockchainService();
  });

  it("mint() resolves with a mock tx hash", async () => {
    const hash = await service.mint("VG-REF-1", "0xpartner", "100", "US-MX");
    expect(hash).toMatch(/^0xmock_mint_tx_hash_\d+$/);
  });

  it("transfer() resolves with a mock tx hash", async () => {
    const hash = await service.transfer("VG-REF-1", "0xto", "10");
    expect(hash).toMatch(/^0xmock_transfer_tx_hash_\d+$/);
  });

  it("reconcile() resolves with a mock tx hash", async () => {
    const hash = await service.reconcile("VG-REF-1");
    expect(hash).toMatch(/^0xmock_reconcile_tx_hash_\d+$/);
  });

  it("burn() resolves with a mock tx hash", async () => {
    const hash = await service.burn("VG-REF-1");
    expect(hash).toMatch(/^0xmock_burn_tx_hash_\d+$/);
  });

  it("closeSettlementForWithdrawal() resolves with a mock burn tx hash", async () => {
    const hash = await service.closeSettlementForWithdrawal("VG-REF-1");
    expect(hash).toMatch(/^0xmock_burn_tx_hash_\d+$/);
  });

  it("registerPartner() resolves with a mock tx hash", async () => {
    const hash = await service.registerPartner("0xpartner", "Acme US");
    expect(hash).toMatch(/^0xmock_register_partner_\d+$/);
  });

  it("isPartnerApproved() resolves true in mock mode", async () => {
    await expect(service.isPartnerApproved("0xpartner")).resolves.toBe(true);
  });

  it("ensureOperatorRoles() is a no-op in mock mode", async () => {
    await expect(service.ensureOperatorRoles()).resolves.toBeUndefined();
  });

  it("ensureRedemptionSink() is a no-op in mock mode", async () => {
    await expect(service.ensureRedemptionSink()).resolves.toBeUndefined();
  });

  it("uses a nonce manager for live transactions", () => {
    const originalMode = env.BLOCKCHAIN_MODE;
    env.BLOCKCHAIN_MODE = "live";
    try {
      const liveService = new BlockchainService() as unknown as {
        contract: ethers.Contract;
      };
      expect(liveService.contract.runner).toBeInstanceOf(ethers.NonceManager);
    } finally {
      env.BLOCKCHAIN_MODE = originalMode;
    }
  });

  it("shares in-flight operator role setup between concurrent calls", async () => {
    const wait = jest.fn().mockResolvedValue(undefined);
    const contract = {
      SETTLEMENT_AGENT: jest.fn().mockResolvedValue("agent"),
      COMPLIANCE_OPERATOR: jest.fn().mockResolvedValue("compliance"),
      hasRole: jest.fn().mockResolvedValue(false),
      assignRole: jest.fn().mockResolvedValue({ wait }),
    };
    Object.assign(service, { mock: false, contract });

    await Promise.all([
      service.ensureOperatorRoles(),
      service.ensureOperatorRoles(),
    ]);

    expect(contract.hasRole).toHaveBeenCalledTimes(2);
    expect(contract.assignRole).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
    await service.ensureOperatorRoles();
    expect(contract.assignRole).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying RPC reason when role setup fails", async () => {
    const contract = {
      SETTLEMENT_AGENT: jest.fn().mockResolvedValue("agent"),
      COMPLIANCE_OPERATOR: jest.fn().mockResolvedValue("compliance"),
      hasRole: jest.fn().mockResolvedValue(false),
      assignRole: jest.fn().mockRejectedValue({
        shortMessage: "could not coalesce error",
        info: { error: { message: "transaction underpriced" } },
      }),
    };
    Object.assign(service, { mock: false, contract });

    await expect(service.ensureOperatorRoles()).rejects.toThrow(
      "transaction underpriced",
    );
  });

  it("ensureRedemptionSink() registers partner and establishes KYC when needed", async () => {
    const isPartnerApproved = jest.fn().mockResolvedValue(false);
    const registerPartner = jest.fn().mockResolvedValue("0xreg_tx");
    const getIdentity = jest.fn().mockResolvedValue({ isVerified: false });
    const setIdentity = jest.fn().mockResolvedValue("0xkyc_tx");

    Object.assign(service, {
      mock: false,
      isPartnerApproved,
      registerPartner,
    });

    const kycServiceModule = require("../../src/blockchain/KYCComplianceService");
    const origGetIdentity = kycServiceModule.kycComplianceService.getIdentity;
    const origSetIdentity = kycServiceModule.kycComplianceService.setIdentity;
    kycServiceModule.kycComplianceService.getIdentity = getIdentity;
    kycServiceModule.kycComplianceService.setIdentity = setIdentity;

    try {
      await service.ensureRedemptionSink();
      expect(registerPartner).toHaveBeenCalled();
      expect(setIdentity).toHaveBeenCalled();
    } finally {
      kycServiceModule.kycComplianceService.getIdentity = origGetIdentity;
      kycServiceModule.kycComplianceService.setIdentity = origSetIdentity;
    }
  });

  it("getTransactionStatus() resolves CONFIRMED for any hash", async () => {
    const status = await service.getTransactionStatus("0xanyhash");
    expect(status).toBe("CONFIRMED");
  });
});
