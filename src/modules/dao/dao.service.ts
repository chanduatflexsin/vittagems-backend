import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../utils/errors';
import { transactionQueue } from '../../workers/transaction.worker';
import { WebhookService } from '../webhooks/webhook.service';
import { DocumentService } from '../documents/document.service';

const prisma = new PrismaClient();

/**
 * DAO verification of fiat movements.
 *
 * Deposit:    client records fiat + bank proof -> proposal PENDING -> members vote
 *             -> APPROVED: deposit VERIFIED, any waiting mint is released to the chain
 *             -> REJECTED / EXPIRED: deposit REJECTED, nothing is minted
 *
 * Withdrawal: client requests -> settlement locked on-chain (hold) -> client pays fiat
 *             and submits the payout reference -> members vote
 *             -> APPROVED: hold lifted and the settlement burned
 *             -> REJECTED / EXPIRED: hold lifted, funds returned to the client
 *
 * Members authenticate with their own tokens, never a client API key, so the
 * party moving money can never also be the party approving it.
 */

const PROPOSAL_INCLUDE = {
  client: { select: { id: true, name: true } },
  deposit: true,
  withdrawal: true,
  Votes: { include: { member: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
  Events: { orderBy: { createdAt: 'asc' as const } },
  Documents: { orderBy: { createdAt: 'asc' as const } },
};

type FullProposal = Prisma.ProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>;
type ProposalRow = Prisma.ProposalGetPayload<Record<string, never>>;

const hashToken = (token: string) => crypto.createHmac('sha256', env.API_KEY_SECRET).update(token).digest('hex');

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

const secondsRemaining = (expiresAt: Date | null) =>
  expiresAt ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)) : null;

export interface DepositProof {
  bankReference: string;
  payerName?: string;
  notes?: string;
  documentHash?: string;
}

let sweeping = false;

export class DaoService {
  // ── Members ────────────────────────────────────────────────────

  static async registerMember(name: string) {
    if (!name || !name.trim()) throw new ValidationError('name is required');
    const token = `vg_dao_${crypto.randomBytes(24).toString('hex')}`;
    const member = await prisma.daoMember.create({ data: { name: name.trim(), tokenHash: hashToken(token) } });
    logger.info(`DAO member registered: ${member.name} (${member.id})`);
    return { memberId: member.id, name: member.name, token, message: 'Save this token; it is shown only once.' };
  }

  static async deactivateMember(memberId: string) {
    await prisma.daoMember.update({ where: { id: memberId }, data: { isActive: false } });
    logger.info(`DAO member deactivated: ${memberId}`);
    return { memberId, isActive: false };
  }

  static async authenticate(token?: string) {
    if (!token) throw new UnauthorizedError('Missing X-DAO-Token header. DAO endpoints require a member token.');
    const member = await prisma.daoMember.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!member || !member.isActive) throw new UnauthorizedError('Invalid or deactivated DAO member token');
    return member;
  }

  static async config() {
    const activeMembers = await prisma.daoMember.count({ where: { isActive: true } });
    return {
      enabled: env.DAO_VERIFICATION_ENABLED,
      quorum: env.DAO_QUORUM,
      activeMembers,
      quorumReachable: activeMembers >= env.DAO_QUORUM,
      depositWindowMinutes: env.DAO_DEPOSIT_WINDOW_MINUTES,
      withdrawalWindowMinutes: env.DAO_WITHDRAWAL_WINDOW_MINUTES,
      extensionMinutes: env.DAO_WITHDRAWAL_EXTENSION_MINUTES,
      maxExtensions: env.DAO_MAX_EXTENSIONS,
    };
  }

  // ── Proposal creation ──────────────────────────────────────────

  static async addEvent(proposalId: string, type: string, message: string, actor = 'system') {
    await prisma.proposalEvent.create({ data: { proposalId, type, message, actor } });
  }

  private static async warnIfQuorumUnreachable(proposalId: string) {
    const active = await prisma.daoMember.count({ where: { isActive: true } });
    if (active < env.DAO_QUORUM) {
      await this.addEvent(
        proposalId,
        'WARNING',
        `Only ${active} active DAO member(s) registered but ${env.DAO_QUORUM} approvals are required - this cannot pass until more members are added.`,
      );
    }
  }

  static async createDepositProposal(args: {
    clientId: string;
    depositId: string;
    referenceId: string;
    amount: Prisma.Decimal | string;
    currency: string;
    proof: DepositProof;
  }) {
    const account = await prisma.blockchainAccount.findFirst({ where: { clientId: args.clientId, isActive: true } });
    const documentHash =
      args.proof.documentHash ||
      '0x' + crypto.createHash('sha256').update(JSON.stringify({ ...args.proof, referenceId: args.referenceId })).digest('hex');

    const proposal = await prisma.proposal.create({
      data: {
        mode: 'OFFCHAIN',
        clientId: args.clientId,
        type: 'DEPOSIT',
        state: 'PENDING',
        amount: args.amount,
        providerAddress: account?.address ?? 'unassigned',
        referenceId: args.referenceId,
        depositId: args.depositId,
        proofReference: args.proof.bankReference,
        payerName: args.proof.payerName,
        proofNotes: args.proof.notes,
        documentHash,
        quorumRequired: env.DAO_QUORUM,
        expiresAt: minutesFromNow(env.DAO_DEPOSIT_WINDOW_MINUTES),
      },
    });

    await this.addEvent(
      proposal.id,
      'CREATED',
      `Deposit of ${args.amount} ${args.currency} recorded with bank reference ${args.proof.bankReference}. ` +
        `Awaiting ${env.DAO_QUORUM} DAO approval(s) within ${env.DAO_DEPOSIT_WINDOW_MINUTES} minutes.`,
      'client',
    );
    await this.warnIfQuorumUnreachable(proposal.id);
    await WebhookService.dispatch(args.clientId, 'deposit.verification_requested', {
      proposalId: proposal.id,
      referenceId: args.referenceId,
      expiresAt: proposal.expiresAt,
    });
    logger.info(`DAO: deposit proposal ${proposal.id} opened for ${args.referenceId}`);
    return proposal;
  }

  static async createWithdrawalProposal(args: {
    clientId: string;
    withdrawalId: string;
    referenceId: string;
    amount: Prisma.Decimal | string;
    providerAddress: string;
    windowMinutes?: number;
  }) {
    // A caller may shorten or lengthen the window (useful for demos), but never beyond a day.
    const window = args.windowMinutes
      ? Math.min(Math.max(Math.round(args.windowMinutes), 1), 24 * 60)
      : env.DAO_WITHDRAWAL_WINDOW_MINUTES;

    const proposal = await prisma.proposal.create({
      data: {
        mode: 'OFFCHAIN',
        clientId: args.clientId,
        type: 'WITHDRAWAL',
        state: 'PENDING',
        amount: args.amount,
        providerAddress: args.providerAddress,
        referenceId: args.referenceId,
        withdrawalId: args.withdrawalId,
        quorumRequired: env.DAO_QUORUM,
        expiresAt: minutesFromNow(window),
      },
    });

    await this.addEvent(
      proposal.id,
      'CREATED',
      `Withdrawal of ${args.amount} requested for settlement ${args.referenceId}. Funds will be locked on-chain; ` +
        `the payout must be made and verified within ${window} minutes or the funds are released back.`,
      'client',
    );
    await this.warnIfQuorumUnreachable(proposal.id);
    logger.info(`DAO: withdrawal proposal ${proposal.id} opened for ${args.referenceId}`);
    return proposal;
  }

  // ── Reads ──────────────────────────────────────────────────────

  static async latestForDeposit(depositId: string) {
    return prisma.proposal.findFirst({ where: { depositId, type: 'DEPOSIT' }, orderBy: { createdAt: 'desc' } });
  }

  static async latestForWithdrawal(withdrawalId: string) {
    return prisma.proposal.findFirst({ where: { withdrawalId, type: 'WITHDRAWAL' }, orderBy: { createdAt: 'desc' } });
  }

  /** The slice of a proposal a client is shown (no member identities). */
  static verificationSummary(p: ProposalRow | null) {
    if (!p) return null;
    return {
      proposalId: p.id,
      state: p.state,
      votesFor: p.votesFor,
      votesAgainst: p.votesAgainst,
      quorumRequired: p.quorumRequired,
      expiresAt: p.expiresAt,
      secondsRemaining: p.state === 'PENDING' ? secondsRemaining(p.expiresAt) : null,
      extensionCount: p.extensionCount,
      maxExtensions: env.DAO_MAX_EXTENSIONS,
      bankDelayFlagged: p.bankDelayFlagged,
      awaitingPayoutProof: p.type === 'WITHDRAWAL' && p.state === 'PENDING' && !p.payoutReference,
      payoutReference: p.payoutReference,
      resolutionMessage: p.resolutionMessage,
      lockTxHash: p.lockTxHash,
      releaseTxHash: p.releaseTxHash,
      executeTxHash: p.executeTxHash,
      failureReason: p.failureReason,
    };
  }

  /** The full proposal a DAO member reviews. */
  static serialize(p: FullProposal, memberId?: string, activeMembers?: number) {
    const myVote = memberId ? p.Votes.find((v) => v.memberId === memberId) : undefined;
    return {
      proposalId: p.id,
      type: p.type,
      state: p.state,
      mode: p.mode,
      client: p.client,
      amount: p.amount.toString(),
      currency: p.deposit?.currency ?? null,
      referenceId: p.referenceId,
      providerAddress: p.providerAddress,
      deposit: p.deposit ? { id: p.deposit.id, status: p.deposit.status } : null,
      withdrawal: p.withdrawal
        ? { id: p.withdrawal.id, status: p.withdrawal.status, bankDetails: p.withdrawal.bankDetails }
        : null,
      evidence: {
        bankReference: p.proofReference,
        payerName: p.payerName,
        notes: p.proofNotes,
        documentHash: p.documentHash,
        payoutReference: p.payoutReference,
        payoutSubmittedAt: p.payoutSubmittedAt,
      },
      awaitingPayoutProof: p.type === 'WITHDRAWAL' && !p.payoutReference,
      documents: p.Documents.map((d) => DocumentService.serialize(d)),
      votes: {
        for: p.votesFor,
        against: p.votesAgainst,
        quorumRequired: p.quorumRequired,
        activeMembers: activeMembers ?? null,
        list: p.Votes.map((v) => ({
          memberId: v.memberId,
          memberName: v.member.name,
          decision: v.decision,
          comment: v.comment,
          createdAt: v.createdAt,
        })),
      },
      myVote: myVote?.decision ?? null,
      canVote:
        !!memberId &&
        !myVote &&
        p.state === 'PENDING' &&
        !(p.type === 'WITHDRAWAL' && !p.payoutReference),
      window: {
        expiresAt: p.expiresAt,
        secondsRemaining: p.state === 'PENDING' ? secondsRemaining(p.expiresAt) : null,
        extensionCount: p.extensionCount,
        maxExtensions: env.DAO_MAX_EXTENSIONS,
        extensionMinutes: env.DAO_WITHDRAWAL_EXTENSION_MINUTES,
        bankDelayFlagged: p.bankDelayFlagged,
      },
      outcome: {
        resolutionMessage: p.resolutionMessage,
        resolvedAt: p.resolvedAt,
        failureReason: p.failureReason,
        lockTxHash: p.lockTxHash,
        releaseTxHash: p.releaseTxHash,
        executeTxHash: p.executeTxHash,
      },
      timeline: p.Events.map((e) => ({ type: e.type, actor: e.actor, message: e.message, createdAt: e.createdAt })),
      createdAt: p.createdAt,
    };
  }

  static async listProposals(memberId: string, filter: { state?: string; type?: string } = {}) {
    const [rows, activeMembers] = await Promise.all([
      prisma.proposal.findMany({
        where: {
          mode: 'OFFCHAIN',
          ...(filter.state ? { state: filter.state } : {}),
          ...(filter.type ? { type: filter.type } : {}),
        },
        include: PROPOSAL_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.daoMember.count({ where: { isActive: true } }),
    ]);
    const items = rows.map((r) => this.serialize(r, memberId, activeMembers));
    return {
      items,
      needsMyVote: items.filter((i) => i.canVote).length,
      awaitingPayoutProof: items.filter((i) => i.state === 'PENDING' && i.awaitingPayoutProof).length,
    };
  }

  static async getProposal(proposalId: string, memberId?: string) {
    const p = await prisma.proposal.findUnique({ where: { id: proposalId }, include: PROPOSAL_INCLUDE });
    if (!p) throw new NotFoundError('Proposal not found');
    const activeMembers = await prisma.daoMember.count({ where: { isActive: true } });
    return this.serialize(p, memberId, activeMembers);
  }

  // ── Voting ─────────────────────────────────────────────────────

  static async castVote(
    proposalId: string,
    member: { id: string; name: string },
    decision: string,
    comment?: string,
  ) {
    const normalized = String(decision || '').toUpperCase();
    if (normalized !== 'APPROVE' && normalized !== 'REJECT') {
      throw new ValidationError('decision must be APPROVE or REJECT');
    }

    const p = await prisma.proposal.findUnique({ where: { id: proposalId } });
    if (!p) throw new NotFoundError('Proposal not found');
    if (p.state !== 'PENDING') throw new ConflictError(`Voting is closed: this proposal is ${p.state}`);
    if (p.expiresAt && p.expiresAt.getTime() <= Date.now()) {
      await this.resolveNegative(p, 'the verification window closed', 'system', 'EXPIRED');
      throw new ConflictError('Voting is closed: the verification window has expired');
    }
    if (p.type === 'WITHDRAWAL' && !p.payoutReference) {
      throw new ConflictError(
        'This withdrawal cannot be voted on yet: the client has not submitted the payout reference, so there is nothing to verify.',
      );
    }
    if (normalized === 'REJECT' && !comment?.trim()) {
      throw new ValidationError('A comment explaining the rejection is required');
    }

    try {
      await prisma.proposalVote.create({
        data: { proposalId, memberId: member.id, decision: normalized, comment: comment?.trim() || null },
      });
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictError('You have already voted on this proposal');
      throw error;
    }

    // Recount from the vote table - it is the source of truth.
    const [votesFor, votesAgainst, activeMembers] = await Promise.all([
      prisma.proposalVote.count({ where: { proposalId, decision: 'APPROVE' } }),
      prisma.proposalVote.count({ where: { proposalId, decision: 'REJECT' } }),
      prisma.daoMember.count({ where: { isActive: true } }),
    ]);
    const updated = await prisma.proposal.update({ where: { id: proposalId }, data: { votesFor, votesAgainst } });

    await this.addEvent(
      proposalId,
      'VOTE',
      `${member.name} voted ${normalized}${comment?.trim() ? `: "${comment.trim()}"` : ''} (${votesFor} for / ${votesAgainst} against, ${updated.quorumRequired} needed)`,
      member.name,
    );

    const quorum = updated.quorumRequired || env.DAO_QUORUM;
    if (votesFor >= quorum) {
      await this.resolveApproved(updated, member.name);
    } else if (votesAgainst >= quorum || votesAgainst > activeMembers - quorum) {
      // Rejected by the same threshold (as DAOGovernor does on-chain), or earlier if
      // not enough members remain who could still approve.
      const reasons = await prisma.proposalVote.findMany({
        where: { proposalId, decision: 'REJECT' },
        select: { comment: true },
      });
      const reason = reasons.map((r) => r.comment).filter(Boolean).join('; ') || 'rejected by DAO vote';
      await this.resolveNegative(updated, reason, member.name, 'REJECTED');
    }

    return this.getProposal(proposalId, member.id);
  }

  /** Atomically move a proposal out of PENDING. Returns false if something else already resolved it. */
  private static async transition(proposalId: string, state: string, resolutionMessage: string) {
    const { count } = await prisma.proposal.updateMany({
      where: { id: proposalId, state: 'PENDING' },
      data: { state, resolutionMessage, resolvedAt: new Date() },
    });
    return count === 1;
  }

  private static async resolveApproved(p: ProposalRow, actor: string) {
    if (p.type === 'DEPOSIT') {
      const waiting = await prisma.transaction.findMany({
        where: { depositId: p.depositId ?? undefined, type: 'MINT', status: 'AWAITING_APPROVAL' },
      });
      const message = waiting.length
        ? 'Deposit verified by the DAO. The mint has been released for on-chain execution.'
        : 'Deposit verified by the DAO. It can now be minted.';
      if (!(await this.transition(p.id, 'APPROVED', message))) return;

      if (p.depositId) await prisma.deposit.update({ where: { id: p.depositId }, data: { status: 'VERIFIED' } });
      for (const tx of waiting) {
        await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'PENDING', proposalId: p.id } });
        await transactionQueue.add('process-mint', {
          transactionId: tx.id,
          toAddress: tx.toAddress,
          amount: tx.amount.toString(),
          referenceId: p.referenceId,
          corridor: tx.corridor || undefined,
        });
      }
      await this.addEvent(p.id, 'APPROVED', message, actor);
      await WebhookService.dispatch(p.clientId, 'deposit.verified', { proposalId: p.id, referenceId: p.referenceId });
      return;
    }

    if (p.type === 'WITHDRAWAL') {
      const message = 'Payout verified by the DAO. The locked funds are being burned to complete the withdrawal.';
      if (!(await this.transition(p.id, 'APPROVED', message))) return;

      if (p.withdrawalId) {
        await prisma.withdrawal.update({ where: { id: p.withdrawalId }, data: { status: 'BURN_PENDING' } });
        const burnTx = await prisma.transaction.findFirst({
          where: { withdrawalId: p.withdrawalId, type: 'BURN', status: 'AWAITING_APPROVAL' },
        });
        if (burnTx) {
          await prisma.transaction.update({ where: { id: burnTx.id }, data: { status: 'PENDING', proposalId: p.id } });
          await transactionQueue.add('process-burn', {
            transactionId: burnTx.id,
            amount: burnTx.amount.toString(),
            referenceId: p.referenceId,
            releaseWithdrawalHold: true,
          });
        }
      }
      await this.addEvent(p.id, 'APPROVED', message, actor);
      await WebhookService.dispatch(p.clientId, 'withdrawal.verified', { proposalId: p.id, withdrawalId: p.withdrawalId });
    }
  }

  private static async resolveNegative(
    p: ProposalRow,
    reason: string,
    actor: string,
    state: 'REJECTED' | 'EXPIRED',
  ) {
    if (p.type === 'DEPOSIT') {
      const message =
        state === 'EXPIRED'
          ? 'Deposit was not verified before the window closed. No tokens were minted.'
          : `Deposit rejected by the DAO (${reason}). No tokens were minted.`;
      if (!(await this.transition(p.id, state, message))) return;

      if (p.depositId) {
        await prisma.deposit.update({ where: { id: p.depositId }, data: { status: 'REJECTED' } });
        await prisma.transaction.updateMany({
          where: { depositId: p.depositId, type: 'MINT', status: 'AWAITING_APPROVAL' },
          data: { status: 'FAILED', failureReason: message },
        });
      }
      await this.addEvent(p.id, state, message, actor);
      await WebhookService.dispatch(p.clientId, `deposit.${state.toLowerCase()}`, {
        proposalId: p.id,
        referenceId: p.referenceId,
        reason: message,
      });
      return;
    }

    if (p.type === 'WITHDRAWAL') {
      const message =
        state === 'EXPIRED'
          ? 'Withdrawal not yet finished: the payout was not verified before the window closed. Your locked funds are being released back to you.'
          : `Withdrawal not yet finished: the DAO could not verify the payout (${reason}). Your locked funds are being released back to you.`;
      if (!(await this.transition(p.id, state, message))) return;

      if (p.withdrawalId) {
        await prisma.withdrawal.update({ where: { id: p.withdrawalId }, data: { status: 'RELEASE_PENDING' } });
        await prisma.transaction.updateMany({
          where: { withdrawalId: p.withdrawalId, type: 'BURN', status: 'AWAITING_APPROVAL' },
          data: { status: 'FAILED', failureReason: message },
        });
        const releaseTx = await prisma.transaction.create({
          data: {
            clientId: p.clientId,
            type: 'RELEASE',
            referenceId: p.referenceId,
            withdrawalId: p.withdrawalId,
            proposalId: p.id,
            amount: p.amount,
            fromAddress: p.providerAddress,
            status: 'PENDING',
          },
        });
        await transactionQueue.add('process-release', {
          transactionId: releaseTx.id,
          referenceId: p.referenceId,
          amount: p.amount.toString(),
        });
      }
      await this.addEvent(p.id, state, message, actor);
      await WebhookService.dispatch(p.clientId, 'withdrawal.released', {
        proposalId: p.id,
        withdrawalId: p.withdrawalId,
        reason: message,
      });
    }
  }

  // ── Time window ────────────────────────────────────────────────

  /**
   * Buy more time, typically because the bank has not yet confirmed a payout.
   * Clients may extend only their own withdrawals; DAO members may extend any
   * pending proposal. Limited to DAO_MAX_EXTENSIONS per proposal.
   */
  static async extend(
    proposalId: string,
    args: { actor: string; reason: string; clientId?: string },
  ) {
    if (!args.reason?.trim()) throw new ValidationError('reason is required (for example: "bank payout still processing")');

    const p = await prisma.proposal.findUnique({ where: { id: proposalId } });
    if (!p) throw new NotFoundError('Proposal not found');
    if (args.clientId && p.clientId !== args.clientId) throw new NotFoundError('Proposal not found');
    if (args.clientId && p.type !== 'WITHDRAWAL') {
      throw new ValidationError('Clients can only extend withdrawal payout windows');
    }
    if (p.state !== 'PENDING') throw new ConflictError(`Cannot extend: this proposal is already ${p.state}`);
    if (p.expiresAt && p.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError('Cannot extend: the window has already closed');
    }
    if (p.extensionCount >= env.DAO_MAX_EXTENSIONS) {
      throw new ConflictError(`Cannot extend: all ${env.DAO_MAX_EXTENSIONS} extensions have already been used`);
    }

    const minutes = env.DAO_WITHDRAWAL_EXTENSION_MINUTES;
    const base = p.expiresAt && p.expiresAt.getTime() > Date.now() ? p.expiresAt.getTime() : Date.now();
    const updated = await prisma.proposal.update({
      where: { id: proposalId },
      data: {
        expiresAt: new Date(base + minutes * 60_000),
        extensionCount: { increment: 1 },
        bankDelayFlagged: true,
      },
    });

    await this.addEvent(
      proposalId,
      'EXTENDED',
      `${args.actor} extended the window by ${minutes} min (${updated.extensionCount}/${env.DAO_MAX_EXTENSIONS}): ${args.reason.trim()}`,
      args.actor,
    );
    return updated;
  }

  /** Close every pending proposal whose window has passed. Safe to call repeatedly. */
  static async sweepExpired() {
    if (sweeping) return 0;
    sweeping = true;
    let closed = 0;
    try {
      const expired = await prisma.proposal.findMany({
        where: { mode: 'OFFCHAIN', state: 'PENDING', expiresAt: { lte: new Date() } },
        include: { withdrawal: true },
      });
      for (const p of expired) {
        // Do not release a lock that is still being placed; the next sweep will pick it up.
        if (p.type === 'WITHDRAWAL' && p.withdrawal && p.withdrawal.status === 'LOCK_PENDING') continue;
        try {
          await this.resolveNegative(p, 'the verification window closed', 'system', 'EXPIRED');
          closed++;
        } catch (error: any) {
          logger.error(`DAO sweep: failed to expire proposal ${p.id}: ${error.message}`);
        }
      }
      if (closed) logger.info(`DAO sweep: expired ${closed} proposal(s)`);
    } finally {
      sweeping = false;
    }
    return closed;
  }

  static startSweeper() {
    const intervalMs = Math.max(env.DAO_SWEEP_INTERVAL_SECONDS, 1) * 1000;
    const timer = setInterval(() => {
      this.sweepExpired().catch((error) => logger.error(`DAO sweep crashed: ${error.message}`));
    }, intervalMs);
    timer.unref();
    logger.info(
      `DAO verification enabled - quorum ${env.DAO_QUORUM}, deposit window ${env.DAO_DEPOSIT_WINDOW_MINUTES} min, ` +
        `withdrawal window ${env.DAO_WITHDRAWAL_WINDOW_MINUTES} min, sweeping every ${intervalMs / 1000}s`,
    );
    return timer;
  }
}
