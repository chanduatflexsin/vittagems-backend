import { DepositService } from '../../src/modules/deposits/deposit.service';
import { prismaMock } from '../setup';

describe('DepositService.registerMockDeposit', () => {
  const baseInput = {
    clientId: 'client-1',
    amount: '100.5',
    currency: 'INR',
    referenceId: 'ref-001',
  };

  it('creates a VERIFIED deposit when the reference is unused', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue(null);
    prismaMock.deposit.create.mockResolvedValue({
      id: 'dep-1',
      referenceId: 'ref-001',
      status: 'VERIFIED',
    } as any);

    const result = await DepositService.registerMockDeposit(baseInput);

    expect(result).toEqual({
      depositId: 'dep-1',
      referenceId: 'ref-001',
      status: 'VERIFIED',
      message: 'Deposit verified. Ready for minting.',
    });
    expect(prismaMock.deposit.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        amount: '100.5',
        currency: 'INR',
        referenceId: 'ref-001',
        status: 'VERIFIED',
      },
    });
  });

  it('defaults currency to INR when not provided', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue(null);
    prismaMock.deposit.create.mockResolvedValue({ id: 'dep-2', referenceId: 'ref-002', status: 'VERIFIED' } as any);

    await DepositService.registerMockDeposit({ ...baseInput, currency: undefined as any, referenceId: 'ref-002' });

    const createArgs = prismaMock.deposit.create.mock.calls[0][0] as any;
    expect(createArgs.data.currency).toBe('INR');
  });

  it('throws ConflictError when the referenceId already exists', async () => {
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-existing', referenceId: 'ref-001' } as any);

    await expect(DepositService.registerMockDeposit(baseInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(prismaMock.deposit.create).not.toHaveBeenCalled();
  });
});
