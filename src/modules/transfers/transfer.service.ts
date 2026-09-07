import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError, ForbiddenError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';

const prisma = new PrismaClient();

interface TransferRequest {
  clientId: string;
  idempotencyKey: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
  referenceId: string;
}

export class TransferService {
  static async processTransferRequest(data: TransferRequest) {
    const { clientId, idempotencyKey, amount, fromAddress, toAddress, referenceId } = data;

    // On-chain transfers are keyed by the settlement referenceId (the contract moves
    // a whole MINTED settlement to the new partner), so it is required.
    if (!referenceId) {
      throw new ValidationError('referenceId (the settlement to transfer) is required');
    }

    // 1. Validate that the client owns the fromAddress (or has permission to transfer from it)
    const account = await prisma.blockchainAccount.findFirst({
      where: {
        address: fromAddress,
        clientId,
        isActive: true,
      }
    });

    if (!account) {
      throw new ForbiddenError(`Client is not authorized to transfer from address ${fromAddress}`);
    }

    // Note: In a real system, you would check available balance here by calling the blockchain 
    // or querying an internal ledger if you maintain strict off-chain balances.

    // 2. Create the Transaction Record
    const transaction = await prisma.transaction.create({
      data: {
        clientId,
        type: 'TRANSFER',
        referenceId,
        idempotencyKey,
        amount,
        fromAddress,
        toAddress,
        status: 'PENDING',
      },
    });

    // 3. Enqueue the blockchain job
    await transactionQueue.add('process-transfer', {
      transactionId: transaction.id,
      toAddress,
      amount,
      referenceId,
    });

    return {
      transactionId: transaction.id,
      status: transaction.status,
      message: 'Transfer transaction accepted and queued for blockchain processing',
    };
  }

  static async getTransferStatus(transactionId: string, clientId: string) {
    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx || tx.clientId !== clientId || tx.type !== 'TRANSFER') {
      throw new NotFoundError('Transfer transaction not found');
    }

    return {
      transactionId: tx.id,
      status: tx.status,
      blockchainTxHash: tx.blockchainTxHash,
      failureReason: tx.failureReason,
    };
  }
}
