import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';

const prisma = new PrismaClient();

interface WithdrawalRequest {
  clientId: string;
  idempotencyKey: string;
  amount: string;
  bankDetails: any;
  fromAddress: string;
  referenceId: string;
}

export class WithdrawalService {
  static async createWithdrawalRequest(data: WithdrawalRequest) {
    const { clientId, idempotencyKey, amount, bankDetails, fromAddress, referenceId } = data;

    // The on-chain burn closes a specific settlement, identified by its referenceId.
    // (Per the contract, that settlement must already be TRANSFERRED/PAYOUT_CONFIRMED.)
    if (!referenceId) {
      throw new ValidationError('referenceId (the settlement to redeem/burn) is required');
    }

    // 1. Verify client owns the fromAddress
    const account = await prisma.blockchainAccount.findFirst({
      where: {
        address: fromAddress,
        clientId,
        isActive: true,
      }
    });

    if (!account) {
      throw new ForbiddenError(`Client is not authorized to withdraw from address ${fromAddress}`);
    }

    // 2. Prevent duplicate active withdrawals with same idempotencyKey (already partially handled by DB unique constraint, but we check logically)
    const existingWithdrawal = await prisma.withdrawal.findUnique({
      where: { idempotencyKey }
    });

    if (existingWithdrawal) {
      return {
        withdrawalId: existingWithdrawal.id,
        status: existingWithdrawal.status,
        message: 'Returning existing withdrawal request',
      };
    }

    // 3. Create the Withdrawal Record
    // Real-world: Validate bank details via an external provider here
    const withdrawal = await prisma.withdrawal.create({
      data: {
        clientId,
        idempotencyKey,
        amount,
        bankDetails,
        status: 'REQUESTED',
      },
    });

    // We also need a transaction record for the potential burn, initially PENDING linked to this withdrawal
    await prisma.transaction.create({
      data: {
        clientId,
        type: 'BURN',
        referenceId,
        withdrawalId: withdrawal.id,
        amount,
        fromAddress,
        status: 'PENDING',
      }
    });

    // Note: It stays in REQUESTED status until approved.
    return {
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      message: 'Withdrawal requested. Awaiting bank verification and approval.',
    };
  }

  /**
   * Confirm that the off-chain fiat payout has been sent to the user and close the
   * settlement on-chain. Call this ONLY after funds have actually been paid out:
   * it queues the burn, which walks the settlement through transfer -> reconcile
   * -> burn and marks the withdrawal SETTLED once the burn confirms.
   */
  static async approveWithdrawal(withdrawalId: string) {
    // 1. Get the withdrawal
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { Transactions: true }
    });

    if (!withdrawal) {
      throw new NotFoundError('Withdrawal not found');
    }

    if (withdrawal.status !== 'REQUESTED') {
      throw new ConflictError(`Cannot approve withdrawal in status ${withdrawal.status}`);
    }

    // 2. Payout confirmed sent -> move to BURN_PENDING; the worker closes it on-chain
    //    and flips the withdrawal to SETTLED once the burn confirms.
    await prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'BURN_PENDING' },
    });

    // 3. Find the associated BURN transaction
    const burnTx = withdrawal.Transactions.find(tx => tx.type === 'BURN' && tx.status === 'PENDING');
    if (!burnTx) {
      throw new Error('Burn transaction not found for this withdrawal');
    }

    // 4. Enqueue the burn transaction
    await transactionQueue.add('process-burn', {
      transactionId: burnTx.id,
      amount: burnTx.amount.toString(),
      referenceId: burnTx.referenceId,
    });

    // The worker takes the burn tx SUBMITTED -> CONFIRMED and sets the withdrawal to SETTLED.
    return {
      withdrawalId: withdrawal.id,
      status: 'BURN_PENDING',
      message: 'Payout confirmed. Settlement closure (burn) initiated on-chain.',
    };
  }

  static async getWithdrawalStatus(withdrawalId: string, clientId: string) {
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        Transactions: true
      }
    });

    if (!withdrawal || withdrawal.clientId !== clientId) {
      throw new NotFoundError('Withdrawal not found');
    }

    const burnTx = withdrawal.Transactions.find(tx => tx.type === 'BURN');

    return {
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      burnTransactionStatus: burnTx?.status,
      blockchainTxHash: burnTx?.blockchainTxHash,
      failureReason: burnTx?.failureReason,
    };
  }
}
