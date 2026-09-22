import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { env } from '../../config/env';
import { NotFoundError } from '../../utils/errors';
import { WalletService } from '../wallets/wallet.service';

const prisma = new PrismaClient();

export class ClientService {
  /**
   * Generates a new API Key for a client.
   * Only the raw key is returned once. The DB stores a hash.
   */
  static generateApiKey(prefix = 'vg_live_'): { rawKey: string; keyHash: string } {
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const rawKey = `${prefix}${randomBytes}`;
    const keyHash = crypto
      .createHmac('sha256', env.API_KEY_SECRET)
      .update(rawKey)
      .digest('hex');

    return { rawKey, keyHash };
  }

  static async registerClient(name: string, requestedPermissions: string[], blockchainAddress?: string) {
    // In a real system, this is an internal admin action.
    // Validate the wallet first: registering the client and then failing on the
    // address would leave a client behind with no usable wallet.
    if (blockchainAddress) WalletService.assertValidAddress(blockchainAddress);

    const { rawKey, keyHash } = this.generateApiKey();

    const client = await prisma.client.create({
      data: {
        name,
        ApiKeys: {
          create: {
            name: 'Default Key',
            keyHash,
            Permissions: {
              create: requestedPermissions.map(scope => ({ scope }))
            }
          }
        },
        BlockchainAccounts: blockchainAddress ? {
          create: { address: blockchainAddress }
        } : undefined
      }
    });

    // The wallet is registered but NOT usable yet: the DAO must whitelist it
    // before anything can be minted to or withdrawn from it.
    let wallet = null;
    if (blockchainAddress) {
      wallet = WalletService.serialize(
        await WalletService.request(client.id, blockchainAddress, `${name} settlement wallet`, name),
      );
    }

    return {
      clientId: client.id,
      name: client.name,
      apiKey: rawKey, // IMPORTANT: The user must save this!
      permissions: requestedPermissions,
      blockchainAddress,
      wallet,
    };
  }

  static async getClientDetails(clientId: string) {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: {
        BlockchainAccounts: true,
        ApiKeys: {
          select: {
            id: true,
            name: true,
            isActive: true,
            lastUsedAt: true,
            Permissions: true,
          }
        }
      }
    });

    if (!client) throw new NotFoundError('Client not found');

    return client;
  }
}
