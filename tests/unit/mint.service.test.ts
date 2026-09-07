import { MintService } from '../../src/modules/mint/mint.service';
import { transactionQueue } from '../../src/workers/transaction.worker';
import { prismaMock } from '../setup';

describe('MintService.processMintRequest', () => {
  const baseInput = {
    clientId: 'client-1',
    idempotencyKey: 'idem-key-12345',
    amount: '50',
    referenceId: 'ref-001',
    toAddress: '0xdead',
  };

  it('throws NotFoundError when the deposit reference does not exist', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue(null);

    await expect(MintService.processMintRequest(baseInput)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('throws ValidationError when the deposit is not VERIFIED', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-1', status: 'PENDING', amount: '50' } as any);

    await expect(MintService.processMintRequest(baseInput)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('throws ValidationError when a mint already exists for the deposit', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-1', status: 'VERIFIED', amount: '50' } as any);
    prismaMock.transaction.findFirst.mockResolvedValue({ id: 'tx-existing' } as any);

    await expect(MintService.processMintRequest(baseInput)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(prismaMock.transaction.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING transaction tied to the deposit amount and enqueues the blockchain job', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-1', status: 'VERIFIED', amount: '50', referenceId: 'ref-001' } as any);
    prismaMock.transaction.findFirst.mockResolvedValue(null);
    prismaMock.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' } as any);

    const result = await MintService.processMintRequest({ ...baseInput, corridor: 'US-MX' });

    expect(prismaMock.transaction.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        type: 'MINT',
        idempotencyKey: 'idem-key-12345',
        depositId: 'dep-1',
        amount: '50', // tied to the verified deposit amount, not the request body
        toAddress: '0xdead',
        status: 'PENDING',
      },
    });
    expect(transactionQueue.add).toHaveBeenCalledWith('process-mint', {
      transactionId: 'tx-1',
      toAddress: '0xdead',
      amount: '50',
      referenceId: 'ref-001',
      corridor: 'US-MX',
    });
    expect(result).toEqual({
      transactionId: 'tx-1',
      status: 'PENDING',
      message: 'Mint transaction accepted and queued for blockchain processing',
    });
  });
});

describe('MintService.getMintStatus', () => {
  it('returns the transaction status when it belongs to the requesting client', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'client-1',
      status: 'CONFIRMED',
      blockchainTxHash: '0xhash',
      failureReason: null,
    } as any);

    const result = await MintService.getMintStatus('tx-1', 'client-1');

    expect(result).toEqual({
      transactionId: 'tx-1',
      status: 'CONFIRMED',
      blockchainTxHash: '0xhash',
      failureReason: null,
    });
  });

  it('throws NotFoundError when the transaction does not exist', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(null);

    await expect(MintService.getMintStatus('missing', 'client-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws NotFoundError when the transaction belongs to a different client', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue({ id: 'tx-1', clientId: 'other-client' } as any);

    await expect(MintService.getMintStatus('tx-1', 'client-1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
