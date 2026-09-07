import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';

const prisma = new PrismaClient();

interface MintRequest {
  clientId: string;
  idempotencyKey: string;
  amount: string;
  referenceId: string;
  toAddress: string;
  corridor?: string;
}

export class MintService {
  static async processMintRequest(data: MintRequest) {
    const { clientId, idempotencyKey, amount, referenceId, toAddress, corridor } = data;

    // 1. Verify the underlying deposit/payment
    const deposit = await prisma.deposit.findUnique({
      where: { referenceId },
    });

    if (!deposit) {
      throw new NotFoundError(`Deposit reference ${referenceId} not found`);
    }

    if (deposit.status !== 'VERIFIED') {
      throw new ValidationError(`Cannot mint: Deposit status is ${deposit.status}`);
    }

    // 2. Prevent double minting for the same deposit
    const existingMint = await prisma.transaction.findFirst({
      where: {
        depositId: deposit.id,
        type: 'MINT',
        status: { in: ['PENDING', 'SUBMITTED', 'CONFIRMED'] },
      },
    });

    if (existingMint) {
      throw new ValidationError(`A mint transaction already exists for deposit ${referenceId}`);
    }

    // 3. Create the Transaction Record
    const transaction = await prisma.transaction.create({
      data: {
        clientId,
        type: 'MINT',
        idempotencyKey,
        depositId: deposit.id,
        amount: deposit.amount, // strict tie to verified deposit amount
        toAddress,
        status: 'PENDING',
      },
    });

    // 4. Enqueue the blockchain job. The on-chain settlement is keyed by the
    //    deposit's referenceId, so the fiat deposit and the chain record stay linked.
    await transactionQueue.add('process-mint', {
      transactionId: transaction.id,
      toAddress,
      amount: deposit.amount.toString(),
      referenceId: deposit.referenceId,
      corridor: corridor || undefined,
    });

    return {
      transactionId: transaction.id,
      status: transaction.status,
      message: 'Mint transaction accepted and queued for blockchain processing',
    };
  }

  static async getMintStatus(transactionId: string, clientId: string) {
    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx || tx.clientId !== clientId) {
      throw new NotFoundError('Mint transaction not found');
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      blockchainTxHash: tx.blockchainTxHash,
      failureReason: tx.failureReason,
    };
  }
}
