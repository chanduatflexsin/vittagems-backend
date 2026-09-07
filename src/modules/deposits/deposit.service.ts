import { PrismaClient } from '@prisma/client';
import { ConflictError } from '../../utils/errors';

const prisma = new PrismaClient();

interface DepositData {
  clientId: string;
  amount: string;
  currency: string;
  referenceId: string;
}

export class DepositService {
  /**
   * Mocks a bank settlement verification.
   * In a real environment, this data would come from a webhook from a bank or payment gateway.
   */
  static async registerMockDeposit(data: DepositData) {
    const { clientId, amount, currency, referenceId } = data;

    const existing = await prisma.deposit.findUnique({
      where: { referenceId }
    });

    if (existing) {
      throw new ConflictError(`Deposit with reference ${referenceId} already exists`);
    }

    const deposit = await prisma.deposit.create({
      data: {
        clientId,
        amount,
        currency: currency || 'INR',
        referenceId,
        status: 'VERIFIED', // Directly verified for testing purposes
      }
    });

    return {
      depositId: deposit.id,
      referenceId: deposit.referenceId,
      status: deposit.status,
      message: 'Deposit verified. Ready for minting.'
    };
  }
}
