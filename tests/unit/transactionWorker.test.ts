import { prismaMock } from '../setup';

jest.mock('../../src/blockchain/BlockchainService', () => ({
  blockchainService: {
    mint: jest.fn(),
    transfer: jest.fn(),
    burn: jest.fn(),
    closeSettlementForWithdrawal: jest.fn(),
    hold: jest.fn(),
    releaseHold: jest.fn(),
    getSettlement: jest.fn(),
    getTransactionStatus: jest.fn(),
    ensureOperatorRoles: jest.fn().mockResolvedValue(undefined),
    isPartnerApproved: jest.fn().mockResolvedValue(true),
    registerPartner: jest.fn().mockResolvedValue('0xregister'),
  },
}));

jest.mock('../../src/modules/webhooks/webhook.service', () => ({
  WebhookService: {
    dispatch: jest.fn().mockResolvedValue(undefined),
  },
}));

import { transactionWorker } from '../../src/workers/transaction.worker';
import { blockchainService } from '../../src/blockchain/BlockchainService';
import { WebhookService } from '../../src/modules/webhooks/webhook.service';

// The BullMQ Worker constructor is mocked (tests/setup.ts) to stash the real
// processor function under `__processor`, since it is normally invoked only
// by the BullMQ runtime. This tests that processor directly.
const runProcessor = (job: any) => (transactionWorker as any).__processor(job);

describe('transaction.worker processJob', () => {
  const job = {
    name: 'process-mint',
    data: { transactionId: 'tx-1', toAddress: '0xdead', amount: '50', referenceId: 'VG-REF-1', corridor: 'US-MX' },
  };

  it('skips processing when the transaction no longer exists', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(null);

    await runProcessor(job);

    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
    expect(blockchainService.mint).not.toHaveBeenCalled();
  });

  it('skips processing when the transaction is no longer PENDING', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({ id: 'tx-1', status: 'CONFIRMED' } as any);

    await runProcessor(job);

    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
  });

  it('processes a MINT job: marks SUBMITTED, calls blockchainService.mint, then CONFIRMED + webhook', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      type: 'MINT',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '50',
      fromAddress: null,
    } as any);
    (blockchainService.mint as jest.Mock).mockResolvedValue('0xhash1');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');
    prismaMock.transaction.update.mockResolvedValue({} as any);

    await runProcessor(job);

    expect(prismaMock.transaction.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'tx-1' },
      data: { status: 'SUBMITTED' },
    });
    expect(blockchainService.mint).toHaveBeenCalledWith('VG-REF-1', '0xdead', '50', 'US-MX');
    expect(prismaMock.transaction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tx-1' },
      data: { status: 'CONFIRMED', blockchainTxHash: '0xhash1' },
    });
    expect(WebhookService.dispatch).toHaveBeenCalledWith('client-1', 'mint.completed', {
      transactionId: 'tx-1',
      amount: '50',
      status: 'CONFIRMED',
      blockchainTxHash: '0xhash1',
    });
  });

  it('processes a TRANSFER job using the transaction fromAddress', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-2',
      type: 'TRANSFER',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '10',
      fromAddress: '0xfrom',
    } as any);
    (blockchainService.transfer as jest.Mock).mockResolvedValue('0xhash2');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');

    await runProcessor({
      name: 'process-transfer',
      data: { transactionId: 'tx-2', toAddress: '0xto', amount: '10', referenceId: 'VG-REF-2' },
    });

    expect(blockchainService.transfer).toHaveBeenCalledWith('VG-REF-2', '0xto', '10');
  });

  it('processes a BURN job by closing the settlement (transfer -> reconcile -> burn)', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-3',
      type: 'BURN',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '5',
      fromAddress: '0xfrom',
    } as any);
    (blockchainService.closeSettlementForWithdrawal as jest.Mock).mockResolvedValue('0xhash3');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');

    await runProcessor({ name: 'process-burn', data: { transactionId: 'tx-3', amount: '5', referenceId: 'VG-REF-3' } });

    expect(blockchainService.closeSettlementForWithdrawal).toHaveBeenCalledWith('VG-REF-3');
  });

  it('marks the withdrawal SETTLED after a BURN confirms', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-3',
      type: 'BURN',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '5',
      fromAddress: '0xfrom',
      withdrawalId: 'wd-1',
    } as any);
    (blockchainService.closeSettlementForWithdrawal as jest.Mock).mockResolvedValue('0xhash3');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');

    await runProcessor({ name: 'process-burn', data: { transactionId: 'tx-3', amount: '5', referenceId: 'VG-REF-3' } });

    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 'wd-1' },
      data: { status: 'SETTLED' },
    });
  });

  it('fails fast with "Unknown transaction type" for an unrecognized tx type', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-4',
      type: 'SOMETHING_ELSE',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '1',
    } as any);

    await expect(
      runProcessor({ name: 'process-unknown', data: { transactionId: 'tx-4', toAddress: '0xdead', amount: '1' } })
    ).rejects.toThrow('Unknown transaction type SOMETHING_ELSE');

    expect(prismaMock.transaction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tx-4' },
      data: { status: 'FAILED', failureReason: 'Unknown transaction type SOMETHING_ELSE' },
    });
    expect(WebhookService.dispatch).toHaveBeenCalledWith('client-1', 'something_else.failed', {
      transactionId: 'tx-4',
      error: 'Unknown transaction type SOMETHING_ELSE',
    });
  });

  it('marks the transaction FAILED, dispatches a failure webhook, and rethrows when the blockchain call errors', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      type: 'MINT',
      status: 'PENDING',
      clientId: 'client-1',
      amount: '50',
    } as any);
    (blockchainService.mint as jest.Mock).mockRejectedValue(new Error('chain unreachable'));

    await expect(runProcessor(job)).rejects.toThrow('chain unreachable');

    expect(prismaMock.transaction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tx-1' },
      data: { status: 'FAILED', failureReason: 'chain unreachable' },
    });
    expect(WebhookService.dispatch).toHaveBeenCalledWith('client-1', 'mint.failed', {
      transactionId: 'tx-1',
      error: 'chain unreachable',
    });
  });
});

describe('transaction.worker - DAO withdrawal lock / release', () => {
  const lockTx = {
    id: 'lock-1',
    type: 'LOCK',
    status: 'PENDING',
    clientId: 'client-1',
    amount: '1000',
    fromAddress: '0xAbC',
    withdrawalId: 'w1',
    proposalId: 'p1',
  };
  const lockJob = { name: 'process-lock', data: { transactionId: 'lock-1', referenceId: 'INV-1', amount: '1000' } };

  it('locks a settlement held by the withdrawing wallet and marks the withdrawal LOCKED', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(lockTx as any);
    (blockchainService.getSettlement as jest.Mock).mockResolvedValue({ exists: true, status: 'MINTED', partner: '0xabc' });
    (blockchainService.hold as jest.Mock).mockResolvedValue('0xlock');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');

    await runProcessor(lockJob);

    expect(blockchainService.hold).toHaveBeenCalledWith('INV-1', expect.stringContaining('pending DAO verification'));
    expect(prismaMock.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', status: 'LOCK_PENDING' },
      data: { status: 'LOCKED' },
    });
    expect(prismaMock.proposal.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { lockTxHash: '0xlock' } });
  });

  it('refuses to lock a settlement held by another wallet and fails the withdrawal', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(lockTx as any);
    (blockchainService.getSettlement as jest.Mock).mockResolvedValue({ exists: true, status: 'TRANSFERRED', partner: '0xpartner' });

    await expect(runProcessor(lockJob)).rejects.toThrow(/held by 0xpartner/);

    expect(blockchainService.hold).not.toHaveBeenCalled();
    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { status: 'FAILED' } });
    expect(prismaMock.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1', state: 'PENDING' }, data: expect.objectContaining({ state: 'REJECTED' }) }),
    );
  });

  it('treats a release of an already-unlocked settlement as done without a transaction', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({ ...lockTx, id: 'rel-1', type: 'RELEASE' } as any);
    (blockchainService.releaseHold as jest.Mock).mockResolvedValue(null);

    await runProcessor({ name: 'process-release', data: { transactionId: 'rel-1', referenceId: 'INV-1' } });

    expect(blockchainService.getTransactionStatus).not.toHaveBeenCalled();
    expect(prismaMock.transaction.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'rel-1' },
      data: { status: 'CONFIRMED', blockchainTxHash: null },
    });
    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { status: 'RELEASED' } });
  });

  it('passes releaseWithdrawalHold through to the burn for DAO-approved withdrawals', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({ ...lockTx, id: 'burn-1', type: 'BURN' } as any);
    (blockchainService.closeSettlementForWithdrawal as jest.Mock).mockResolvedValue('0xburn');
    (blockchainService.getTransactionStatus as jest.Mock).mockResolvedValue('CONFIRMED');

    await runProcessor({
      name: 'process-burn',
      data: { transactionId: 'burn-1', referenceId: 'INV-1', releaseWithdrawalHold: true },
    });

    expect(blockchainService.closeSettlementForWithdrawal).toHaveBeenCalledWith('INV-1', { releaseWithdrawalHold: true });
    expect(prismaMock.proposal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'EXECUTED', executeTxHash: '0xburn' }) }),
    );
  });
});

describe("transaction.worker 'completed' / 'failed' event handlers", () => {
  it('the completed handler runs without throwing', () => {
    const handler = (transactionWorker as any).__handlers['completed'][0];
    expect(() => handler({ id: 'job-1' })).not.toThrow();
  });

  it('the failed handler runs without throwing', () => {
    const handler = (transactionWorker as any).__handlers['failed'][0];
    expect(() => handler({ id: 'job-1' }, new Error('blew up'))).not.toThrow();
  });
});
