import { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { settlementV2 } from '../../blockchain/SettlementV2Service';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

const prisma = new PrismaClient();

const requireV2 = () => {
  if (env.SETTLEMENT_VERSION !== 'v2') {
    throw new ValidationError(
      'DAO proposals are only available when SETTLEMENT_VERSION=v2. The current deployment runs the v1 settlement contract.',
    );
  }
};

export class ProposalService {
  /**
   * Refresh a stored proposal from the chain. The DAO votes on-chain, so the
   * database copy is only ever a cache - the governor is the source of truth.
   */
  static async syncFromChain(proposalId: string) {
    requireV2();
    const row = await prisma.proposal.findUnique({ where: { id: proposalId } });
    if (!row) throw new NotFoundError('Proposal not found');

    // Off-chain (DAO API) proposals have no governor id and nothing to sync.
    if (!row.onChainId) return row;

    try {
      const chain = await settlementV2().getProposal(row.onChainId);
      if (chain.exists) {
        return prisma.proposal.update({
          where: { id: row.id },
          data: {
            state: chain.state,
            votesFor: chain.votesFor,
            votesAgainst: chain.votesAgainst,
            expiresAt: chain.expiry,
          },
        });
      }
    } catch (error: any) {
      logger.warn(`Could not sync proposal ${row.onChainId} from chain: ${error.message}`);
    }
    return row;
  }

  static async getProposal(proposalId: string, clientId: string) {
    const row = await this.syncFromChain(proposalId);
    if (row.clientId !== clientId) throw new NotFoundError('Proposal not found');

    const quorum = await settlementV2()
      .getQuorumThreshold()
      .catch(() => null);

    return {
      proposalId: row.id,
      onChainId: row.onChainId,
      type: row.type,
      state: row.state,
      amount: row.amount.toString(),
      providerAddress: row.providerAddress,
      toAddress: row.toAddress,
      referenceId: row.referenceId,
      votes: { for: row.votesFor, against: row.votesAgainst, quorumRequired: quorum },
      expiresAt: row.expiresAt,
      proofTxHash: row.proofTxHash,
      requestTxHash: row.requestTxHash,
      executeTxHash: row.executeTxHash,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
    };
  }

  static async listProposals(clientId: string, state?: string) {
    requireV2();
    const rows = await prisma.proposal.findMany({
      where: { clientId, ...(state ? { state } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      proposalId: r.id,
      onChainId: r.onChainId,
      type: r.type,
      state: r.state,
      amount: r.amount.toString(),
      providerAddress: r.providerAddress,
      referenceId: r.referenceId,
      votes: { for: r.votesFor, against: r.votesAgainst },
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Execute an approved proposal on-chain. Voting itself is never done here:
   * DAOGovernor.castVote checks msg.sender for DAO_MEMBER_ROLE, so members must
   * sign their own votes with their own keys.
   */
  static async execute(proposalId: string, clientId: string) {
    requireV2();
    const row = await this.syncFromChain(proposalId);
    if (row.clientId !== clientId) throw new NotFoundError('Proposal not found');

    if (row.state !== 'APPROVED') {
      throw new ValidationError(
        `Proposal is ${row.state}; it must be APPROVED by the DAO before it can be executed ` +
          `(${row.votesFor} for / ${row.votesAgainst} against).`,
      );
    }

    if (!row.onChainId) {
      throw new ValidationError('This proposal is resolved by DAO vote through /dao endpoints, not executed on-chain here.');
    }
    const onChainId = row.onChainId;

    const svc = settlementV2();
    let txHash: string;
    if (row.type === 'DEPOSIT') {
      txHash = await svc.executeMint(onChainId);
    } else if (row.type === 'WITHDRAWAL') {
      txHash = await svc.executeBurn(onChainId);
    } else {
      if (!row.toAddress) throw new ValidationError('Internal transfer proposal is missing its destination address');
      txHash = await svc.executeInternalTransfer(onChainId, row.toAddress);
    }

    const updated = await prisma.proposal.update({
      where: { id: row.id },
      data: { state: 'EXECUTED', executeTxHash: txHash },
    });

    return {
      proposalId: updated.id,
      onChainId: updated.onChainId,
      state: updated.state,
      executeTxHash: txHash,
      message: 'Proposal executed on-chain',
    };
  }
}
