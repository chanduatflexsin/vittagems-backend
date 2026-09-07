import { TransferService } from '../../src/modules/transfers/transfer.service';
import { transactionQueue } from '../../src/workers/transaction.worker';
import { prismaMock } from '../setup';

describe('TransferService.processTransferRequest', () => {
  const baseInput = {
    clientId: 'client-1',
    idempotencyKey: 'idem-key-12345',
    amount: '10',
    fromAddress: '0xfrom',
    toAddress: '0xto',
    referenceId: 'VG-REF-1',
  };

  it('throws ForbiddenError when the client does not own an active fromAddress', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue(null);

    await expect(TransferService.processTransferRequest(baseInput)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCESS_DENIED',
    });
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING transfer transaction and enqueues the blockchain job', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1', address: '0xfrom' } as any);
    prismaMock.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' } as any);

    const result = await TransferService.processTransferRequest(baseInput);

    expect(prismaMock.transaction.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        type: 'TRANSFER',
        referenceId: 'VG-REF-1',
        idempotencyKey: 'idem-key-12345',
        amount: '10',
        fromAddress: '0xfrom',
        toAddress: '0xto',
        status: 'PENDING',
      },
    });
    expect(transactionQueue.add).toHaveBeenCalledWith('process-transfer', {
      transactionId: 'tx-1',
      toAddress: '0xto',
      amount: '10',
      referenceId: 'VG-REF-1',
    });
    expect(result.transactionId).toBe('tx-1');
    expect(result.status).toBe('PENDING');
  });

  it('scopes the fromAddress ownership check to the requesting client', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' } as any);

    await TransferService.processTransferRequest(baseInput);

    expect(prismaMock.blockchainAccount.findFirst).toHaveBeenCalledWith({
      where: { address: '0xfrom', clientId: 'client-1', isActive: true },
    });
  });
});

describe('TransferService.getTransferStatus', () => {
  it('returns the status for a matching TRANSFER transaction owned by the client', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'client-1',
      type: 'TRANSFER',
      status: 'SUBMITTED',
      blockchainTxHash: null,
      failureReason: null,
    } as any);

    const result = await TransferService.getTransferStatus('tx-1', 'client-1');
    expect(result.status).toBe('SUBMITTED');
  });

  it('throws NotFoundError when the transaction type is not TRANSFER (e.g. a MINT id)', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'client-1',
      type: 'MINT',
    } as any);

    await expect(TransferService.getTransferStatus('tx-1', 'client-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws NotFoundError when owned by a different client', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'other-client',
      type: 'TRANSFER',
    } as any);

    await expect(TransferService.getTransferStatus('tx-1', 'client-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
