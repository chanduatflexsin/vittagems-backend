import app from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { blockchainService } from './blockchain/BlockchainService';
import { settlementV2 } from './blockchain/SettlementV2Service';
import { DaoService } from './modules/dao/dao.service';

const startServer = async () => {
  try {
    // Fail fast if the chain/contract config is wrong (e.g. the Quorum network was
    // rebuilt and the settlement contract no longer exists at the configured address)
    // rather than accepting requests that would all fail at the worker.
    if (env.SETTLEMENT_VERSION === 'v2') {
      await settlementV2().preflight();
    } else {
      await blockchainService.preflight();
    }

    // Close verification windows that run out (deposits expire unminted, withdrawals release their lock).
    if (env.DAO_VERIFICATION_ENABLED) {
      DaoService.startSweeper();
    }

    app.listen(env.PORT, () => {
      logger.info(`🚀 Server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    });
  } catch (error: any) {
    // Log the message explicitly: Error.message is non-enumerable, so passing the
    // error object alone serialises to metadata only and hides why startup failed.
    logger.error(`Failed to start server: ${error?.message ?? error}`, error);
    process.exit(1);
  }
};

startServer();
