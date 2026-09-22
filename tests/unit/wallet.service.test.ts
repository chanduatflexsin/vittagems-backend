import { prismaMock } from '../setup';
import { WalletService } from '../../src/modules/wallets/wallet.service';
import { env } from '../../src/config/env';

const ADDR = '0x0133F71677B3de040CA09c63F285DE5EDD3912Be';
const lower = ADDR.toLowerCase();

const wallet = (over: Record<string, any> = {}) => ({
  id: 'w1',
  address: lower,
  label: 'Acme settlement wallet',
  clientId: 'c1',
  status: 'PENDING',
  reason: null,
  decidedBy: null,
  decidedAt: null,
  onChainRegisteredAt: null,
  createdAt: new Date(),
  ...over,
});

/** The suite runs with enforcement off; these tests turn it on deliberately. */
const withEnforcement = async (fn: () => Promise<void>) => {
  (env as any).WALLET_WHITELIST_ENABLED = true;
  try {
    await fn();
  } finally {
    (env as any).WALLET_WHITELIST_ENABLED = false;
  }
};

describe('WalletService.request', () => {
  it('rejects a malformed address', async () => {
    await expect(WalletService.request('c1', 'not-an-address', 'x')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires a label', async () => {
    await expect(WalletService.request('c1', ADDR, '   ')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('stores a new wallet lowercased and PENDING', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);
    prismaMock.whitelistedWallet.create.mockResolvedValue(wallet() as any);

    await WalletService.request('c1', ADDR, 'Acme settlement wallet');

    expect(prismaMock.whitelistedWallet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ address: lower, status: 'PENDING', clientId: 'c1' }),
    });
  });

  it('is idempotent for an address already registered by the same client', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'ACTIVE' }) as any);

    const result = await WalletService.request('c1', ADDR, 'again');

    expect(result.status).toBe('ACTIVE');
    expect(prismaMock.whitelistedWallet.create).not.toHaveBeenCalled();
  });

  it('refuses an address already claimed by another client', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ clientId: 'other' }) as any);
    await expect(WalletService.request('c1', ADDR, 'mine')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets a client re-apply after a rejection', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'REJECTED', reason: 'bad KYC' }) as any);
    prismaMock.whitelistedWallet.update.mockResolvedValue(wallet() as any);

    await WalletService.request('c1', ADDR, 'with new documents');

    expect(prismaMock.whitelistedWallet.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: expect.objectContaining({ status: 'PENDING', reason: null }),
    });
  });
});

describe('WalletService.decide', () => {
  it('approves a pending wallet', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet() as any);
    prismaMock.whitelistedWallet.update.mockResolvedValue(wallet({ status: 'ACTIVE', decidedBy: 'Priya' }) as any);

    const result = await WalletService.decide('w1', 'ACTIVE', 'Priya');

    expect(result.status).toBe('ACTIVE');
    expect(result.decidedBy).toBe('Priya');
  });

  it('requires a reason to reject', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet() as any);
    await expect(WalletService.decide('w1', 'REJECTED', 'Priya')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('only revokes a wallet that is currently active', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'PENDING' }) as any);
    await expect(WalletService.decide('w1', 'REVOKED', 'Priya', 'sanctions')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s for an unknown wallet', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);
    await expect(WalletService.decide('nope', 'ACTIVE', 'Priya')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('WalletService.assertActive', () => {
  it('blocks an address that was never registered', async () => {
    await withEnforcement(async () => {
      prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);
      await expect(WalletService.assertActive(ADDR, 'destination')).rejects.toMatchObject({
        statusCode: 403,
        code: 'WALLET_NOT_WHITELISTED',
      });
    });
  });

  it('blocks a wallet still awaiting approval, and says so', async () => {
    await withEnforcement(async () => {
      prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'PENDING' }) as any);
      await expect(WalletService.assertActive(ADDR, 'destination')).rejects.toThrow(/awaiting DAO whitelist approval/);
    });
  });

  it('blocks a revoked wallet and includes the reason', async () => {
    await withEnforcement(async () => {
      prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'REVOKED', reason: 'sanctions hit' }) as any);
      await expect(WalletService.assertActive(ADDR, 'source')).rejects.toThrow(/REVOKED \(sanctions hit\)/);
    });
  });

  it('allows an active wallet', async () => {
    await withEnforcement(async () => {
      prismaMock.whitelistedWallet.findUnique.mockResolvedValue(wallet({ status: 'ACTIVE' }) as any);
      await expect(WalletService.assertActive(ADDR, 'destination')).resolves.toBeUndefined();
    });
  });

  it('is a no-op when enforcement is switched off', async () => {
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);
    await expect(WalletService.assertActive(ADDR, 'destination')).resolves.toBeUndefined();
    expect(prismaMock.whitelistedWallet.findUnique).not.toHaveBeenCalled();
  });
});

describe('mint is blocked for a wallet that is not whitelisted', () => {
  it('refuses before any deposit lookup happens', async () => {
    await withEnforcement(async () => {
      const { MintService } = require('../../src/modules/mint/mint.service');
      prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);

      await expect(
        MintService.processMintRequest({
          clientId: 'c1',
          idempotencyKey: 'idem-key-12345',
          amount: '100',
          referenceId: 'ref-1',
          toAddress: ADDR,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_NOT_WHITELISTED' });

      expect(prismaMock.deposit.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.transaction.create).not.toHaveBeenCalled();
    });
  });
});
