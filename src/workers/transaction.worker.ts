import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { blockchainService } from '../blockchain/BlockchainService';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { WebhookService } from '../modules/webhooks/webhook.service';
import { WalletService } from '../modules/wallets/wallet.service';

const prisma = new PrismaClient();

const connection = {
  url: env.REDIS_URL,
};

// 1. Queue Definition
export const transactionQueue = new Queue('blockchain-transactions', { connection });

type WorkerTx = NonNullable<Awaited<ReturnType<typeof prisma.transaction.findUnique>>>;

/**
 * Reflect the backend whitelist on-chain. Only ever called for an address that
 * has already passed WalletService.assertActive, so the contract's approved
 * partners stay a subset of the whitelist.
 */
async function registerPartnerOnce(address: string, partnerName?: string) {
  if (await blockchainService.isPartnerApproved(address)) return;
  await blockchainService.registerPartner(address, partnerName || `partner-${address.slice(0, 10)}`);
  await WalletService.markRegisteredOnChain(address);
}

const proposalEvent = (proposalId: string, type: string, message: string) =>
  prisma.proposalEvent.create({ data: { proposalId, type, message, actor: 'chain' } });

/** Mirror a confirmed on-chain step of a DAO-verified flow back onto its proposal. */
async function recordDaoOutcome(tx: WorkerTx, txHash: string | null) {
  const proposalId = tx.proposalId!;
  if (tx.type === 'MINT') {
    await prisma.proposal.update({ where: { id: proposalId }, data: { state: 'EXECUTED', executeTxHash: txHash } });
    await proposalEvent(proposalId, 'EXECUTED', `Minted ${tx.amount} on-chain after DAO approval (tx ${txHash}).`);
  } else if (tx.type === 'BURN') {
    await prisma.proposal.update({
      where: { id: proposalId },
      data: {
        state: 'EXECUTED',
        executeTxHash: txHash,
        resolutionMessage: 'Withdrawal complete: the payout was verified and the locked funds were burned on-chain.',
      },
    });
    await proposalEvent(proposalId, 'EXECUTED', `Burned ${tx.amount} on-chain after DAO approval (tx ${txHash}).`);
  } else if (tx.type === 'LOCK') {
    await prisma.proposal.update({ where: { id: proposalId }, data: { lockTxHash: txHash } });
    if (tx.withdrawalId) {
      await prisma.withdrawal.updateMany({
        where: { id: tx.withdrawalId, status: 'LOCK_PENDING' },
        data: { status: 'LOCKED' },
      });
    }
    await proposalEvent(proposalId, 'LOCKED', `Funds locked on-chain (tx ${txHash}). Waiting for the payout reference.`);
  } else if (tx.type === 'RELEASE') {
    const current = await prisma.proposal.findUnique({ where: { id: proposalId }, select: { resolutionMessage: true } });
    await prisma.proposal.update({
      where: { id: proposalId },
      data: {
        releaseTxHash: txHash,
        // The message was written when the release was queued; now it has happened.
        resolutionMessage: current?.resolutionMessage?.replace(
          'Your locked funds are being released back to you.',
          'Your locked funds have been released back to you on-chain.',
        ),
      },
    });
    if (tx.withdrawalId) {
      await prisma.withdrawal.update({ where: { id: tx.withdrawalId }, data: { status: 'RELEASED' } });
    }
    await proposalEvent(
      proposalId,
      'RELEASED',
      txHash
        ? `Locked funds released back to the client on-chain (tx ${txHash}).`
        : 'Nothing to release on-chain: the settlement was no longer locked.',
    );
  }
}

/** Surface a failed on-chain step of a DAO-verified flow on its proposal. */
async function recordDaoFailure(tx: WorkerTx, reason: string) {
  const proposalId = tx.proposalId!;
  await prisma.proposal.update({ where: { id: proposalId }, data: { failureReason: reason } });
  await proposalEvent(proposalId, 'FAILED', `${tx.type} failed on-chain: ${reason}`);

  // If the funds could not even be locked, the withdrawal never started: close it out.
  if (tx.type === 'LOCK' && tx.withdrawalId) {
    const message = `Withdrawal could not start: the funds could not be locked on-chain (${reason}).`;
    await prisma.withdrawal.update({ where: { id: tx.withdrawalId }, data: { status: 'FAILED' } });
    await prisma.proposal.updateMany({
      where: { id: proposalId, state: 'PENDING' },
      data: { state: 'REJECTED', resolutionMessage: message, resolvedAt: new Date() },
    });
    await prisma.transaction.updateMany({
      where: { withdrawalId: tx.withdrawalId, type: 'BURN', status: 'AWAITING_APPROVAL' },
      data: { status: 'FAILED', failureReason: message },
    });
  }
  if (tx.type === 'BURN' && tx.withdrawalId) {
    await prisma.withdrawal.update({ where: { id: tx.withdrawalId }, data: { status: 'FAILED' } });
  }
}

// 2. Worker Definition
const processJob = async (job: Job) => {
  const { transactionId, toAddress, amount, referenceId, corridor, partnerName, releaseWithdrawalHold } = job.data;

  logger.info(`Processing blockchain job ${job.name} for tx ${transactionId}`);

  // Fetch the transaction to ensure it's still pending
  const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });

  if (!tx || tx.status !== 'PENDING') {
    logger.warn(`Transaction ${transactionId} is no longer pending (status: ${tx?.status})`);
    return;
  }

  // Mark as submitted
  await prisma.transaction.update({
    where: { id: transactionId },
    data: { status: 'SUBMITTED' },
  });

  try {
    let txHash: string | null;

    // Make sure the operator wallet has the roles it needs before signing.
    await blockchainService.ensureOperatorRoles();

    // Dispatch based on type. The deployed VittaGemsSettlement contract is keyed
    // by referenceId, so every settlement operation must carry one.
    if (tx.type === 'MINT') {
      // Re-check at signing time: a wallet revoked while this job sat in the queue
      // must not be minted to.
      await WalletService.assertActive(toAddress, 'destination');
      await registerPartnerOnce(toAddress, partnerName);
      txHash = await blockchainService.mint(referenceId, toAddress, amount, corridor || 'DEFAULT');
    } else if (tx.type === 'TRANSFER') {
      await WalletService.assertActive(toAddress, 'receiving');
      await registerPartnerOnce(toAddress, partnerName);
      txHash = await blockchainService.transfer(referenceId, toAddress, amount);
    } else if (tx.type === 'BURN') {
      // A withdrawal burn fires only after the off-chain fiat payout is confirmed.
      // The contract can't burn a MINTED settlement directly, so this walks it
      // through transfer -> reconcile -> burn (see closeSettlementForWithdrawal).
      txHash = releaseWithdrawalHold
        ? await blockchainService.closeSettlementForWithdrawal(referenceId, { releaseWithdrawalHold: true })
        : await blockchainService.closeSettlementForWithdrawal(referenceId);
    } else if (tx.type === 'LOCK') {
      // DAO withdrawal: prove the settlement is withdrawable by this wallet, then freeze it
      // so it cannot be moved while the off-chain payout is being verified.
      const settlement = await blockchainService.getSettlement(referenceId);
      if (!settlement.exists) {
        throw new Error(`Settlement ${referenceId} does not exist on-chain`);
      }
      if (!['MINTED', 'TRANSFERRED', 'PAYOUT_CONFIRMED'].includes(settlement.status)) {
        throw new Error(`Settlement ${referenceId} is ${settlement.status} and cannot be withdrawn`);
      }
      if (tx.fromAddress && settlement.partner.toLowerCase() !== tx.fromAddress.toLowerCase()) {
        throw new Error(
          `Settlement ${referenceId} is held by ${settlement.partner}, not by the withdrawing wallet ${tx.fromAddress}`,
        );
      }
      txHash = await blockchainService.hold(referenceId, `withdrawal ${tx.withdrawalId} pending DAO verification`);
    } else if (tx.type === 'RELEASE') {
      // DAO rejected or the window expired: give the funds back.
      txHash = await blockchainService.releaseHold(referenceId);
    } else {
      throw new Error(`Unknown transaction type ${tx.type}`);
    }

    // Wait for confirmation (simplified)
    const status = txHash ? await blockchainService.getTransactionStatus(txHash) : 'CONFIRMED';

    // Update the database
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status,
        blockchainTxHash: txHash,
      },
    });

    // A confirmed withdrawal burn closes the settlement — mark the withdrawal SETTLED.
    if (tx.type === 'BURN' && tx.withdrawalId && status === 'CONFIRMED') {
      await prisma.withdrawal.update({
        where: { id: tx.withdrawalId },
        data: { status: 'SETTLED' },
      });
    }

    if (tx.proposalId && status === 'CONFIRMED') {
      await recordDaoOutcome(tx, txHash);
    }

    // Publish a webhook event
    const eventPrefix = tx.type.toLowerCase();
    await WebhookService.dispatch(tx.clientId, `${eventPrefix}.completed`, {
      transactionId: tx.id,
      amount: tx.amount,
      status,
      blockchainTxHash: txHash
    });

    logger.info(`Transaction ${transactionId} completed with hash ${txHash} and status ${status}`);
  } catch (error: any) {
    logger.error(`Blockchain job failed for tx ${transactionId}`, error);

    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'FAILED',
        failureReason: error.message || 'Blockchain error',
      },
    });

    if (tx.proposalId) {
      await recordDaoFailure(tx, error.message || 'Blockchain error').catch((e) =>
        logger.error(`Could not record DAO failure for tx ${transactionId}: ${e.message}`),
      );
    }

    // Publish a webhook event for failure
    await WebhookService.dispatch(tx.clientId, `${tx.type.toLowerCase()}.failed`, {
      transactionId: tx.id,
      error: error.message || 'Blockchain error'
    });

    throw error; // Let BullMQ handle retries if configured
  }
};

export const transactionWorker = new Worker('blockchain-transactions', processJob, { 
  connection,
  concurrency: 5 // Process 5 transactions concurrently
});

transactionWorker.on('completed', (job) => {
  logger.debug(`Job ${job.id} has completed!`);
});

transactionWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} has failed with ${err.message}`);
});
