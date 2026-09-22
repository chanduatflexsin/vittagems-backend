import { PrismaClient } from '@prisma/client';
import { ValidationError, NotFoundError, ForbiddenError, ConflictError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';
import { env } from '../../config/env';
import { DaoService } from '../dao/dao.service';
import { WalletService } from '../wallets/wallet.service';

// Withdrawal states during which the settlement is committed and must not be withdrawn again.
const ACTIVE_DAO_STATES = ['LOCK_PENDING', 'LOCKED', 'PAYOUT_SUBMITTED', 'BURN_PENDING', 'RELEASE_PENDING'];

const prisma = new PrismaClient();

interface WithdrawalRequest {
  clientId: string;
  idempotencyKey: string;
  amount: string;
  bankDetails: any;
  fromAddress: string;
  referenceId: string;
  windowMinutes?: number;
}

export class WithdrawalService {
  static async createWithdrawalRequest(data: WithdrawalRequest) {
    const { clientId, idempotencyKey, amount, bankDetails, fromAddress, referenceId } = data;

    // The on-chain burn closes a specific settlement, identified by its referenceId.
    // (Per the contract, that settlement must already be TRANSFERRED/PAYOUT_CONFIRMED.)
    if (!referenceId) {
      throw new ValidationError('referenceId (the settlement to redeem/burn) is required');
    }

    // Only a whitelisted wallet can hold - and therefore redeem - settlement value.
    await WalletService.assertActive(fromAddress, 'source');

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

    if (env.DAO_VERIFICATION_ENABLED) {
      return this.createVerifiedWithdrawal(data);
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
    if (env.DAO_VERIFICATION_ENABLED) {
      throw new ConflictError(
        'DAO verification is enabled: withdrawals are approved by DAO vote, not by this endpoint. ' +
          'Pay the customer, then submit the payout reference with POST /withdrawals/{id}/payout-proof.',
      );
    }

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

    const base = {
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      burnTransactionStatus: burnTx?.status,
      blockchainTxHash: burnTx?.blockchainTxHash,
      failureReason: burnTx?.failureReason,
    };

    if (!env.DAO_VERIFICATION_ENABLED) return base;

    const lockTx = withdrawal.Transactions.find((tx) => tx.type === 'LOCK');
    const releaseTx = withdrawal.Transactions.find((tx) => tx.type === 'RELEASE');
    const proposal = await DaoService.latestForWithdrawal(withdrawal.id);
    return {
      ...base,
      failureReason:
        (lockTx?.status === 'FAILED' && lockTx.failureReason) ||
        (releaseTx?.status === 'FAILED' && releaseTx.failureReason) ||
        (burnTx?.status === 'FAILED' && withdrawal.status === 'FAILED' && burnTx.failureReason) ||
        null,
      lockTxHash: lockTx?.blockchainTxHash ?? null,
      releaseTxHash: releaseTx?.blockchainTxHash ?? null,
      verification: DaoService.verificationSummary(proposal),
      message: proposal?.resolutionMessage ?? null,
    };
  }

  /**
   * DAO-verified withdrawal: lock the settlement on-chain now, burn it only after the
   * DAO has verified the off-chain payout, or release it if that never happens.
   */
  private static async createVerifiedWithdrawal(data: WithdrawalRequest) {
    const { clientId, idempotencyKey, amount, bankDetails, fromAddress, referenceId, windowMinutes } = data;

    const inFlight = await prisma.transaction.findFirst({
      where: { referenceId, type: 'LOCK', withdrawal: { status: { in: ACTIVE_DAO_STATES } } },
    });
    if (inFlight) {
      throw new ConflictError(`A withdrawal for settlement ${referenceId} is already in progress`);
    }

    const withdrawal = await prisma.withdrawal.create({
      data: { clientId, idempotencyKey, amount, bankDetails, status: 'LOCK_PENDING' },
    });

    const proposal = await DaoService.createWithdrawalProposal({
      clientId,
      withdrawalId: withdrawal.id,
      referenceId,
      amount,
      providerAddress: fromAddress,
      windowMinutes,
    });

    // The burn is prepared now but held until the DAO approves.
    await prisma.transaction.create({
      data: {
        clientId,
        type: 'BURN',
        referenceId,
        withdrawalId: withdrawal.id,
        proposalId: proposal.id,
        amount,
        fromAddress,
        status: 'AWAITING_APPROVAL',
      },
    });

    const lockTx = await prisma.transaction.create({
      data: {
        clientId,
        type: 'LOCK',
        referenceId,
        withdrawalId: withdrawal.id,
        proposalId: proposal.id,
        amount,
        fromAddress,
        status: 'PENDING',
      },
    });
    await transactionQueue.add('process-lock', { transactionId: lockTx.id, referenceId, amount });

    return {
      withdrawalId: withdrawal.id,
      status: withdrawal.status,
      verification: DaoService.verificationSummary(proposal),
      message:
        'Withdrawal requested. Funds are being locked on-chain. Pay the customer, then submit the payout reference for DAO verification.',
    };
  }

  /** The client reports the bank reference of the fiat payout it made, for the DAO to verify. */
  static async submitPayoutProof(
    withdrawalId: string,
    clientId: string,
    proof: { payoutReference?: string; notes?: string },
  ) {
    if (!env.DAO_VERIFICATION_ENABLED) {
      throw new ConflictError('Payout proofs are only used when DAO verification is enabled');
    }
    const payoutReference = proof.payoutReference?.trim();
    if (!payoutReference) {
      throw new ValidationError('payoutReference (the bank reference / UTR of the payout) is required');
    }

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal || withdrawal.clientId !== clientId) throw new NotFoundError('Withdrawal not found');
    if (withdrawal.status === 'LOCK_PENDING') {
      throw new ConflictError('Funds are still being locked on-chain. Submit the payout reference once the lock confirms.');
    }
    if (withdrawal.status !== 'LOCKED') {
      throw new ConflictError(`Cannot submit a payout reference while the withdrawal is ${withdrawal.status}`);
    }

    const proposal = await DaoService.latestForWithdrawal(withdrawal.id);
    if (!proposal || proposal.state !== 'PENDING') {
      throw new ConflictError('This withdrawal is no longer awaiting verification');
    }

    const notes = proof.notes?.trim();
    await prisma.proposal.update({
      where: { id: proposal.id },
      data: { payoutReference, proofNotes: notes || null, payoutSubmittedAt: new Date() },
    });
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'PAYOUT_SUBMITTED' } });
    await DaoService.addEvent(
      proposal.id,
      'PAYOUT_PROOF',
      `Client reports the payout was sent with bank reference ${payoutReference}${notes ? ` (${notes})` : ''}. Ready for DAO verification.`,
      'client',
    );

    return this.getWithdrawalStatus(withdrawal.id, clientId);
  }

  /** The client flags a bank delay to get more time before the locked funds are released. */
  static async requestExtension(withdrawalId: string, clientId: string, reason?: string) {
    if (!env.DAO_VERIFICATION_ENABLED) {
      throw new ConflictError('Extensions are only used when DAO verification is enabled');
    }
    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal || withdrawal.clientId !== clientId) throw new NotFoundError('Withdrawal not found');

    const proposal = await DaoService.latestForWithdrawal(withdrawal.id);
    if (!proposal) throw new NotFoundError('No verification is open for this withdrawal');

    await DaoService.extend(proposal.id, { actor: 'client', reason: reason ?? '', clientId });
    return this.getWithdrawalStatus(withdrawal.id, clientId);
  }
}
