import { PrismaClient } from '@prisma/client';
import { ConflictError, ValidationError } from '../../utils/errors';
import { env } from '../../config/env';
import { DaoService, DepositProof } from '../dao/dao.service';

const prisma = new PrismaClient();

interface DepositData {
  clientId: string;
  amount: string;
  currency: string;
  referenceId: string;
  proof?: Partial<DepositProof>;
}

export class DepositService {
  /**
   * Records an incoming fiat deposit.
   *
   * Without DAO verification the deposit is trusted immediately (mock bank webhook).
   * With DAO verification it waits for member approval, and the client must supply
   * the bank reference the DAO will check against the bank statement.
   */
  static async registerMockDeposit(data: DepositData) {
    const { clientId, amount, currency, referenceId } = data;

    const existing = await prisma.deposit.findUnique({
      where: { referenceId }
    });

    if (existing) {
      throw new ConflictError(`Deposit with reference ${referenceId} already exists`);
    }

    if (env.DAO_VERIFICATION_ENABLED) {
      return this.registerForVerification(data);
    }

    const deposit = await prisma.deposit.create({
      data: {
        clientId,
        amount,
        currency: currency || 'USD',
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

  private static async registerForVerification(data: DepositData) {
    const bankReference = data.proof?.bankReference?.trim();
    if (!bankReference) {
      throw new ValidationError(
        'proof.bankReference is required: DAO members verify the deposit against this bank transfer reference (UTR).',
      );
    }

    const deposit = await prisma.deposit.create({
      data: {
        clientId: data.clientId,
        amount: data.amount,
        currency: data.currency || 'USD',
        referenceId: data.referenceId,
        status: 'PENDING_VERIFICATION',
      },
    });

    const proposal = await DaoService.createDepositProposal({
      clientId: data.clientId,
      depositId: deposit.id,
      referenceId: deposit.referenceId,
      amount: deposit.amount,
      currency: deposit.currency,
      proof: {
        bankReference,
        payerName: data.proof?.payerName,
        notes: data.proof?.notes,
        documentHash: data.proof?.documentHash,
      },
    });

    return {
      depositId: deposit.id,
      referenceId: deposit.referenceId,
      status: deposit.status,
      verification: DaoService.verificationSummary(proposal),
      message: 'Deposit recorded. It must be verified by the DAO before it can be minted.',
    };
  }
}
