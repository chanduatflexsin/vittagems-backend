import { prismaMock } from '../setup';

jest.mock('../../src/modules/webhooks/webhook.service', () => ({
  WebhookService: { dispatch: jest.fn().mockResolvedValue(undefined) },
}));

import { DaoService } from '../../src/modules/dao/dao.service';
import { transactionQueue } from '../../src/workers/transaction.worker';
import { env } from '../../src/config/env';

const member = { id: 'm1', name: 'Priya' };
const future = () => new Date(Date.now() + 10 * 60_000);
const past = () => new Date(Date.now() - 60_000);

const baseProposal = (overrides: Record<string, any> = {}) => ({
  id: 'p1',
  mode: 'OFFCHAIN',
  clientId: 'c1',
  type: 'DEPOSIT',
  state: 'PENDING',
  amount: { toString: () => '1000' },
  providerAddress: '0xabc',
  referenceId: 'INV-1',
  depositId: 'd1',
  withdrawalId: null,
  payoutReference: null,
  quorumRequired: 2,
  votesFor: 0,
  votesAgainst: 0,
  expiresAt: future(),
  extensionCount: 0,
  bankDelayFlagged: false,
  ...overrides,
});

const fullProposal = (overrides: Record<string, any> = {}) => ({
  ...baseProposal(overrides),
  client: { id: 'c1', name: 'XPZ Corp' },
  deposit: { id: 'd1', status: 'PENDING_VERIFICATION', currency: 'USD' },
  withdrawal: null,
  Votes: [],
  Events: [],
  Documents: [],
  createdAt: new Date(),
  ...overrides,
});

/** Arrange the calls castVote makes, then the getProposal it returns. */
const arrangeVote = (proposal: any, votesFor: number, votesAgainst: number, activeMembers = 3) => {
  prismaMock.proposal.findUnique
    .mockResolvedValueOnce(proposal as any)
    .mockResolvedValueOnce(fullProposal(proposal) as any);
  prismaMock.proposalVote.create.mockResolvedValue({} as any);
  prismaMock.proposalVote.count.mockResolvedValueOnce(votesFor).mockResolvedValueOnce(votesAgainst);
  prismaMock.daoMember.count.mockResolvedValue(activeMembers);
  prismaMock.proposal.update.mockResolvedValue({ ...proposal, votesFor, votesAgainst } as any);
  prismaMock.proposalEvent.create.mockResolvedValue({} as any);
  prismaMock.proposal.updateMany.mockResolvedValue({ count: 1 } as any);
};

describe('DaoService.castVote - guards', () => {
  it('rejects a decision other than APPROVE/REJECT', async () => {
    await expect(DaoService.castVote('p1', member, 'MAYBE')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses votes on a proposal that is no longer PENDING', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal({ state: 'APPROVED' }) as any);
    await expect(DaoService.castVote('p1', member, 'APPROVE')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a withdrawal vote before the payout reference is submitted', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(
      baseProposal({ type: 'WITHDRAWAL', depositId: null, withdrawalId: 'w1', payoutReference: null }) as any,
    );
    await expect(DaoService.castVote('p1', member, 'APPROVE')).rejects.toThrow(/payout reference/);
    expect(prismaMock.proposalVote.create).not.toHaveBeenCalled();
  });

  it('requires a comment when rejecting', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal() as any);
    await expect(DaoService.castVote('p1', member, 'REJECT')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('turns a duplicate vote into a 409', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal() as any);
    prismaMock.proposalVote.create.mockRejectedValue({ code: 'P2002' });
    await expect(DaoService.castVote('p1', member, 'APPROVE')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('expires instead of voting when the window has already passed', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal({ expiresAt: past() }) as any);
    prismaMock.proposal.updateMany.mockResolvedValue({ count: 1 } as any);
    await expect(DaoService.castVote('p1', member, 'APPROVE')).rejects.toThrow(/expired/);
    expect(prismaMock.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'EXPIRED' }) }),
    );
  });
});

describe('DaoService.castVote - deposit outcomes', () => {
  it('does not resolve while below quorum', async () => {
    arrangeVote(baseProposal(), 1, 0);
    await DaoService.castVote('p1', member, 'APPROVE');
    expect(prismaMock.proposal.updateMany).not.toHaveBeenCalled();
    expect(transactionQueue.add).not.toHaveBeenCalled();
  });

  it('on quorum: verifies the deposit and releases the waiting mint to the chain', async () => {
    arrangeVote(baseProposal(), 2, 0);
    prismaMock.transaction.findMany.mockResolvedValue([
      { id: 'tx1', toAddress: '0xabc', amount: { toString: () => '1000' }, corridor: 'IN-IN' },
    ] as any);

    await DaoService.castVote('p1', member, 'APPROVE');

    expect(prismaMock.deposit.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { status: 'VERIFIED' } });
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' },
      data: { status: 'PENDING', proposalId: 'p1' },
    });
    expect(transactionQueue.add).toHaveBeenCalledWith('process-mint', {
      transactionId: 'tx1',
      toAddress: '0xabc',
      amount: '1000',
      referenceId: 'INV-1',
      corridor: 'IN-IN',
    });
  });

  it('once approval is impossible: rejects the deposit and fails the waiting mint', async () => {
    // 3 members, quorum 2: two rejections leave only one possible approval.
    arrangeVote(baseProposal(), 0, 2, 3);
    prismaMock.proposalVote.findMany.mockResolvedValue([{ comment: 'UTR not on statement' }] as any);

    await DaoService.castVote('p1', member, 'REJECT', 'UTR not on statement');

    expect(prismaMock.deposit.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { status: 'REJECTED' } });
    expect(prismaMock.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
    expect(transactionQueue.add).not.toHaveBeenCalled();
  });

  it('does not double-execute when another vote already resolved the proposal', async () => {
    arrangeVote(baseProposal(), 2, 0);
    prismaMock.proposal.updateMany.mockResolvedValue({ count: 0 } as any);
    prismaMock.transaction.findMany.mockResolvedValue([{ id: 'tx1', toAddress: '0xabc', amount: 1, corridor: null }] as any);

    await DaoService.castVote('p1', member, 'APPROVE');

    expect(prismaMock.deposit.update).not.toHaveBeenCalled();
    expect(transactionQueue.add).not.toHaveBeenCalled();
  });
});

describe('DaoService.castVote - withdrawal outcomes', () => {
  const withdrawal = () =>
    baseProposal({ type: 'WITHDRAWAL', depositId: null, withdrawalId: 'w1', payoutReference: 'UTR-1' });

  it('on quorum: queues the burn and lifts the lock as part of it', async () => {
    arrangeVote(withdrawal(), 2, 0);
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'burn1', amount: { toString: () => '1000' } } as any);

    await DaoService.castVote('p1', member, 'APPROVE');

    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { status: 'BURN_PENDING' } });
    expect(transactionQueue.add).toHaveBeenCalledWith('process-burn', {
      transactionId: 'burn1',
      amount: '1000',
      referenceId: 'INV-1',
      releaseWithdrawalHold: true,
    });
  });

  it('on rejection: releases the locked funds back instead of burning', async () => {
    arrangeVote(withdrawal(), 0, 2, 3);
    prismaMock.proposalVote.findMany.mockResolvedValue([{ comment: 'payout bounced' }] as any);
    prismaMock.transaction.create.mockResolvedValue({ id: 'rel1' } as any);

    await DaoService.castVote('p1', member, 'REJECT', 'payout bounced');

    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { status: 'RELEASE_PENDING' } });
    expect(prismaMock.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'RELEASE', referenceId: 'INV-1' }) }),
    );
    expect(transactionQueue.add).toHaveBeenCalledWith('process-release', expect.objectContaining({ transactionId: 'rel1' }));
    expect(transactionQueue.add).not.toHaveBeenCalledWith('process-burn', expect.anything());
    expect(prismaMock.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resolutionMessage: expect.stringContaining('Withdrawal not yet finished') }),
      }),
    );
  });
});

describe('DaoService.extend', () => {
  it('adds the extension time and flags the bank delay', async () => {
    const expiresAt = future();
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal({ type: 'WITHDRAWAL', expiresAt }) as any);
    prismaMock.proposal.update.mockResolvedValue({ extensionCount: 1 } as any);

    await DaoService.extend('p1', { actor: 'client', reason: 'bank batch at 4pm', clientId: 'c1' });

    const data = prismaMock.proposal.update.mock.calls[0][0].data as any;
    expect(data.bankDelayFlagged).toBe(true);
    expect((data.expiresAt as Date).getTime()).toBe(expiresAt.getTime() + env.DAO_WITHDRAWAL_EXTENSION_MINUTES * 60_000);
  });

  it('stops at the maximum number of extensions', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(
      baseProposal({ type: 'WITHDRAWAL', extensionCount: env.DAO_MAX_EXTENSIONS }) as any,
    );
    await expect(DaoService.extend('p1', { actor: 'client', reason: 'still waiting', clientId: 'c1' })).rejects.toThrow(
      /extensions have already been used/,
    );
  });

  it('does not let a client extend a deposit', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal({ type: 'DEPOSIT' }) as any);
    await expect(DaoService.extend('p1', { actor: 'client', reason: 'x', clientId: 'c1' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('cannot revive a window that has already closed', async () => {
    prismaMock.proposal.findUnique.mockResolvedValue(baseProposal({ type: 'WITHDRAWAL', expiresAt: past() }) as any);
    await expect(DaoService.extend('p1', { actor: 'Priya', reason: 'late' })).rejects.toThrow(/already closed/);
  });

  it('requires a reason', async () => {
    await expect(DaoService.extend('p1', { actor: 'Priya', reason: '  ' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('DaoService.sweepExpired', () => {
  it('expires overdue proposals but leaves a withdrawal whose lock is still being placed', async () => {
    prismaMock.proposal.findMany.mockResolvedValue([
      { ...baseProposal({ id: 'dep', expiresAt: past() }), withdrawal: null },
      {
        ...baseProposal({ id: 'locking', type: 'WITHDRAWAL', depositId: null, withdrawalId: 'w1', expiresAt: past() }),
        withdrawal: { status: 'LOCK_PENDING' },
      },
    ] as any);
    prismaMock.proposal.updateMany.mockResolvedValue({ count: 1 } as any);

    const closed = await DaoService.sweepExpired();

    expect(closed).toBe(1);
    expect(prismaMock.proposal.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.proposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dep', state: 'PENDING' } }),
    );
  });
});

describe('DaoService.verificationSummary', () => {
  it('returns null when there is no proposal', () => {
    expect(DaoService.verificationSummary(null)).toBeNull();
  });

  it('marks a pending withdrawal without a payout reference as awaiting proof', () => {
    const summary = DaoService.verificationSummary(baseProposal({ type: 'WITHDRAWAL' }) as any);
    expect(summary?.awaitingPayoutProof).toBe(true);
    expect(summary?.secondsRemaining).toBeGreaterThan(0);
  });
});
