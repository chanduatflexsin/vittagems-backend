import { WithdrawalService } from '../../src/modules/withdrawals/withdrawal.service';
import { transactionQueue } from '../../src/workers/transaction.worker';
import { prismaMock } from '../setup';

describe('WithdrawalService.createWithdrawalRequest', () => {
  const baseInput = {
    clientId: 'client-1',
    idempotencyKey: 'idem-key-12345',
    amount: '25',
    bankDetails: { accountNumber: '123' },
    fromAddress: '0xfrom',
    referenceId: 'VG-REF-1',
  };

  it('throws ForbiddenError when the client does not own an active fromAddress', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue(null);

    await expect(WithdrawalService.createWithdrawalRequest(baseInput)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCESS_DENIED',
    });
  });

  it('returns the existing withdrawal when the idempotency key was already used', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.withdrawal.findUnique.mockResolvedValue({ id: 'wd-existing', status: 'REQUESTED' } as any);

    const result = await WithdrawalService.createWithdrawalRequest(baseInput);

    expect(result).toEqual({
      withdrawalId: 'wd-existing',
      status: 'REQUESTED',
      message: 'Returning existing withdrawal request',
    });
    expect(prismaMock.withdrawal.create).not.toHaveBeenCalled();
  });

  it('creates a REQUESTED withdrawal plus a linked PENDING BURN transaction', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.withdrawal.findUnique.mockResolvedValue(null);
    prismaMock.withdrawal.create.mockResolvedValue({ id: 'wd-1', status: 'REQUESTED' } as any);
    prismaMock.transaction.create.mockResolvedValue({ id: 'burn-tx-1' } as any);

    const result = await WithdrawalService.createWithdrawalRequest(baseInput);

    expect(prismaMock.withdrawal.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        idempotencyKey: 'idem-key-12345',
        amount: '25',
        bankDetails: { accountNumber: '123' },
        status: 'REQUESTED',
      },
    });
    expect(prismaMock.transaction.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        type: 'BURN',
        referenceId: 'VG-REF-1',
        withdrawalId: 'wd-1',
        amount: '25',
        fromAddress: '0xfrom',
        status: 'PENDING',
      },
    });
    expect(result).toEqual({
      withdrawalId: 'wd-1',
      status: 'REQUESTED',
      message: 'Withdrawal requested. Awaiting bank verification and approval.',
    });
    // The burn is not queued at request time -- only on admin approval.
    expect(transactionQueue.add).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService.approveWithdrawal', () => {
  it('throws NotFoundError when the withdrawal does not exist', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue(null);

    await expect(WithdrawalService.approveWithdrawal('missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws ConflictError when the withdrawal is not in REQUESTED status', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({ id: 'wd-1', status: 'APPROVED', Transactions: [] } as any);

    await expect(WithdrawalService.approveWithdrawal('wd-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('throws a generic error when no PENDING BURN transaction is linked', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      status: 'REQUESTED',
      Transactions: [{ id: 'tx-1', type: 'MINT', status: 'PENDING' }],
    } as any);

    await expect(WithdrawalService.approveWithdrawal('wd-1')).rejects.toThrow('Burn transaction not found');
  });

  it('marks the withdrawal BURN_PENDING and enqueues the linked burn transaction', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      status: 'REQUESTED',
      Transactions: [
        { id: 'burn-tx-1', type: 'BURN', status: 'PENDING', amount: '25', referenceId: 'VG-REF-1' },
        { id: 'other-tx', type: 'MINT', status: 'PENDING', amount: '1' },
      ],
    } as any);

    const result = await WithdrawalService.approveWithdrawal('wd-1');

    expect(prismaMock.withdrawal.update).toHaveBeenCalledWith({
      where: { id: 'wd-1' },
      data: { status: 'BURN_PENDING' },
    });
    expect(transactionQueue.add).toHaveBeenCalledWith('process-burn', {
      transactionId: 'burn-tx-1',
      amount: '25',
      referenceId: 'VG-REF-1',
    });
    expect(result).toEqual({
      withdrawalId: 'wd-1',
      status: 'BURN_PENDING',
      message: 'Payout confirmed. Settlement closure (burn) initiated on-chain.',
    });
  });
});

describe('WithdrawalService.getWithdrawalStatus', () => {
  it('returns withdrawal + burn transaction status when owned by the client', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      clientId: 'client-1',
      status: 'APPROVED',
      Transactions: [{ type: 'BURN', status: 'CONFIRMED', blockchainTxHash: '0xhash' }],
    } as any);

    const result = await WithdrawalService.getWithdrawalStatus('wd-1', 'client-1');

    expect(result).toEqual({
      withdrawalId: 'wd-1',
      status: 'APPROVED',
      burnTransactionStatus: 'CONFIRMED',
      blockchainTxHash: '0xhash',
    });
  });

  it('throws NotFoundError when missing or owned by a different client', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({ id: 'wd-1', clientId: 'other-client', Transactions: [] } as any);

    await expect(WithdrawalService.getWithdrawalStatus('wd-1', 'client-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
