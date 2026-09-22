import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';
import { env } from '../../config/env';
import { DaoService } from '../dao/dao.service';
import { WalletService } from '../wallets/wallet.service';

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

    // 0. The destination must be an approved wallet - value is never minted to
    //    an address the DAO has not whitelisted.
    await WalletService.assertActive(toAddress, 'destination');

    // 1. Verify the underlying deposit/payment
    const deposit = await prisma.deposit.findUnique({
      where: { referenceId },
    });

    if (!deposit) {
      throw new NotFoundError(`Deposit reference ${referenceId} not found`);
    }

    // With DAO verification, a mint may be requested before the vote: it is recorded
    // but held back, and released to the chain only once the deposit is approved.
    const awaitingDao = env.DAO_VERIFICATION_ENABLED && deposit.status === 'PENDING_VERIFICATION';

    if (deposit.status === 'REJECTED') {
      throw new ValidationError(`Cannot mint: deposit ${referenceId} was rejected during DAO verification`);
    }

    if (!awaitingDao && deposit.status !== 'VERIFIED') {
      throw new ValidationError(`Cannot mint: Deposit status is ${deposit.status}`);
    }

    // 2. Prevent double minting for the same deposit
    const existingMint = await prisma.transaction.findFirst({
      where: {
        depositId: deposit.id,
        type: 'MINT',
        status: { in: ['AWAITING_APPROVAL', 'PENDING', 'SUBMITTED', 'CONFIRMED'] },
      },
    });

    if (existingMint) {
      throw new ValidationError(`A mint transaction already exists for deposit ${referenceId}`);
    }

    if (awaitingDao) {
      const proposal = await DaoService.latestForDeposit(deposit.id);
      const pending = await prisma.transaction.create({
        data: {
          clientId,
          type: 'MINT',
          idempotencyKey,
          depositId: deposit.id,
          amount: deposit.amount,
          toAddress,
          corridor: corridor || null,
          referenceId: deposit.referenceId,
          proposalId: proposal?.id,
          status: 'AWAITING_APPROVAL',
        },
      });
      return {
        transactionId: pending.id,
        status: pending.status,
        verification: DaoService.verificationSummary(proposal),
        message: 'Mint request recorded. It will execute on-chain once the DAO approves the deposit.',
      };
    }

    // Link an already-approved proposal so the worker can record its execution.
    const approvedProposal = env.DAO_VERIFICATION_ENABLED ? await DaoService.latestForDeposit(deposit.id) : null;

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
        ...(approvedProposal ? { proposalId: approvedProposal.id } : {}),
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

    const base = {
      transactionId: tx.id,
      status: tx.status,
      blockchainTxHash: tx.blockchainTxHash,
      failureReason: tx.failureReason,
    };

    if (!env.DAO_VERIFICATION_ENABLED || !tx.depositId) return base;

    const proposal = await DaoService.latestForDeposit(tx.depositId);
    return { ...base, verification: DaoService.verificationSummary(proposal) };
  }
}
