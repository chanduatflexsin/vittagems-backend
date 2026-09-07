import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { blockchainService } from '../blockchain/BlockchainService';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { WebhookService } from '../modules/webhooks/webhook.service';

const prisma = new PrismaClient();

const connection = {
  url: env.REDIS_URL,
};

// 1. Queue Definition
export const transactionQueue = new Queue('blockchain-transactions', { connection });

// 2. Worker Definition
const processJob = async (job: Job) => {
  const { transactionId, toAddress, amount, referenceId, corridor, partnerName } = job.data;

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
    let txHash: string;

    // Make sure the operator wallet has the roles it needs before signing.
    await blockchainService.ensureOperatorRoles();

    // Dispatch based on type. The deployed VittaGemsSettlement contract is keyed
    // by referenceId, so every settlement operation must carry one.
    if (tx.type === 'MINT') {
      // The partner must be registered/approved on-chain before it can receive a mint.
      if (!(await blockchainService.isPartnerApproved(toAddress))) {
        await blockchainService.registerPartner(toAddress, partnerName || `partner-${toAddress.slice(0, 10)}`);
      }
      txHash = await blockchainService.mint(referenceId, toAddress, amount, corridor || 'DEFAULT');
    } else if (tx.type === 'TRANSFER') {
      // The receiving partner must be approved on-chain before it can receive a transfer.
      if (!(await blockchainService.isPartnerApproved(toAddress))) {
        await blockchainService.registerPartner(toAddress, partnerName || `partner-${toAddress.slice(0, 10)}`);
      }
      txHash = await blockchainService.transfer(referenceId, toAddress, amount);
    } else if (tx.type === 'BURN') {
      // A withdrawal burn fires only after the off-chain fiat payout is confirmed.
      // The contract can't burn a MINTED settlement directly, so this walks it
      // through transfer -> reconcile -> burn (see closeSettlementForWithdrawal).
      txHash = await blockchainService.closeSettlementForWithdrawal(referenceId);
    } else {
      throw new Error(`Unknown transaction type ${tx.type}`);
    }

    // Wait for confirmation (simplified)
    const status = await blockchainService.getTransactionStatus(txHash);

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
