import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';

const prisma = new PrismaClient();

/**
 * Wallet whitelist.
 *
 * No settlement value is minted to, transferred to, or withdrawn from an address
 * that is not ACTIVE here. A client registers the wallet it intends to use; DAO
 * members approve it against whatever KYC the network requires. Approving is what
 * later allows the operator to register the wallet as a partner on-chain - an
 * address that was never approved is never registered, so the chain and this list
 * stay in step.
 *
 * Enforced in the API (request time) and again in the worker (just before signing),
 * so a wallet revoked mid-flight cannot slip a queued job through.
 */

const norm = (address: string) => address.trim().toLowerCase();
const isAddress = (address: string) => /^0x[a-fA-F0-9]{40}$/.test((address || '').trim());

export class WalletService {
  /** Reject a malformed address early, before anything is written. */
  static assertValidAddress(address: string) {
    if (!isAddress(address)) throw new ValidationError('address must be a 0x-prefixed 40-character hex address');
  }

  static get enforced() {
    return env.WALLET_WHITELIST_ENABLED;
  }

  /** A client asks for a wallet to be whitelisted. Idempotent per address. */
  static async request(clientId: string, address: string, label: string, requestedBy = 'client') {
    this.assertValidAddress(address);
    if (!label?.trim()) throw new ValidationError('label is required (what this wallet is used for)');

    const existing = await prisma.whitelistedWallet.findUnique({ where: { address: norm(address) } });
    if (existing) {
      if (existing.clientId && existing.clientId !== clientId) {
        throw new ConflictError('That address is already registered by another client');
      }
      if (existing.status === 'REJECTED' || existing.status === 'REVOKED') {
        // Let a client re-apply after a rejection with a fresh review.
        return prisma.whitelistedWallet.update({
          where: { id: existing.id },
          data: { status: 'PENDING', label: label.trim(), reason: null, decidedBy: null, decidedAt: null },
        });
      }
      return existing;
    }

    const wallet = await prisma.whitelistedWallet.create({
      data: { address: norm(address), label: label.trim(), clientId, requestedBy, status: 'PENDING' },
    });
    logger.info(`Wallet ${wallet.address} submitted for whitelisting by client ${clientId}`);
    return wallet;
  }

  static async listForClient(clientId: string) {
    const rows = await prisma.whitelistedWallet.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(this.serialize);
  }

  static async listForDao(status?: string) {
    const rows = await prisma.whitelistedWallet.findMany({
      where: status ? { status } : {},
      include: { client: { select: { id: true, name: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return {
      items: rows.map((r) => ({ ...this.serialize(r), client: r.client })),
      pending: rows.filter((r) => r.status === 'PENDING').length,
    };
  }

  static serialize(w: {
    id: string; address: string; label: string; status: string; reason: string | null;
    decidedBy: string | null; decidedAt: Date | null; onChainRegisteredAt: Date | null; createdAt: Date;
  }) {
    return {
      walletId: w.id,
      address: w.address,
      label: w.label,
      status: w.status,
      reason: w.reason,
      decidedBy: w.decidedBy,
      decidedAt: w.decidedAt,
      registeredOnChainAt: w.onChainRegisteredAt,
      createdAt: w.createdAt,
    };
  }

  static async decide(walletId: string, decision: 'ACTIVE' | 'REJECTED' | 'REVOKED', memberName: string, reason?: string) {
    const wallet = await prisma.whitelistedWallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundError('Wallet not found');

    if (decision === 'ACTIVE' && wallet.status === 'ACTIVE') return this.serialize(wallet);
    if (decision !== 'ACTIVE' && !reason?.trim()) {
      throw new ValidationError(`A reason is required to ${decision === 'REVOKED' ? 'revoke' : 'reject'} a wallet`);
    }
    if (decision === 'REVOKED' && wallet.status !== 'ACTIVE') {
      throw new ConflictError(`Only an ACTIVE wallet can be revoked (this one is ${wallet.status})`);
    }
    if (decision === 'REJECTED' && wallet.status !== 'PENDING') {
      throw new ConflictError(`Only a PENDING wallet can be rejected (this one is ${wallet.status})`);
    }

    const updated = await prisma.whitelistedWallet.update({
      where: { id: walletId },
      data: { status: decision, reason: reason?.trim() || null, decidedBy: memberName, decidedAt: new Date() },
    });
    logger.info(`Wallet ${updated.address} set to ${decision} by ${memberName}`);
    return this.serialize(updated);
  }

  static async find(address: string) {
    if (!address) return null;
    return prisma.whitelistedWallet.findUnique({ where: { address: norm(address) } });
  }

  static async isActive(address: string) {
    if (!this.enforced) return true;
    return (await this.find(address))?.status === 'ACTIVE';
  }

  /**
   * Throw unless the address may hold settlement value. `role` is used only to
   * word the error, so the caller knows which side of the operation is blocked.
   */
  static async assertActive(address: string, role: string) {
    if (!this.enforced) return;
    const wallet = await this.find(address);

    if (!wallet) {
      throw new ForbiddenError(
        `The ${role} wallet ${address} is not whitelisted. Register it with POST /wallets and have the DAO approve it before settling to this address.`,
        'WALLET_NOT_WHITELISTED',
      );
    }
    if (wallet.status !== 'ACTIVE') {
      const detail = wallet.reason ? ` (${wallet.reason})` : '';
      throw new ForbiddenError(
        wallet.status === 'PENDING'
          ? `The ${role} wallet ${address} is still awaiting DAO whitelist approval.`
          : `The ${role} wallet ${address} is ${wallet.status}${detail} and cannot hold settlement value.`,
        'WALLET_NOT_WHITELISTED',
      );
    }
  }

  /** Record that an approved wallet has been registered as a partner on-chain. */
  static async markRegisteredOnChain(address: string) {
    await prisma.whitelistedWallet.updateMany({
      where: { address: norm(address) },
      data: { onChainRegisteredAt: new Date() },
    });
  }
}
