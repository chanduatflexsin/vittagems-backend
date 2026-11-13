import { ethers } from "ethers";
import { logger } from "../utils/logger";

/**
 * Resilient nonce manager that prevents nonce gaps and desyncs:
 * 1. Serializes transaction signing and broadcasting across concurrent calls via an internal mutex.
 * 2. Always resolves the authoritative pending nonce from the network.
 * 3. Automatically catches nonce rejection errors (such as "gapped-nonce tx from delegated accounts",
 *    "nonce too low", "replacement transaction underpriced", "could not coalesce error"), resets state,
 *    and retries with the fresh pending nonce.
 */
export class ResilientNonceSigner extends ethers.NonceManager {
  private sendMutex: Promise<void> = Promise.resolve();

  constructor(signer: ethers.Signer) {
    super(signer);
  }

  override async sendTransaction(
    tx: ethers.TransactionRequest,
  ): Promise<ethers.TransactionResponse> {
    return new Promise((resolve, reject) => {
      this.sendMutex = this.sendMutex
        .catch(() => {}) // never leave mutex in a rejected state
        .then(async () => {
          try {
            const res = await this.executeSendWithRetry(tx);
            resolve(res);
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  private async executeSendWithRetry(
    tx: ethers.TransactionRequest,
    attempt = 1,
  ): Promise<ethers.TransactionResponse> {
    const networkPendingNonce = await this.signer.getNonce("pending");
    const populated = await this.signer.populateTransaction(tx);
    populated.nonce = networkPendingNonce;

    if (populated.gasLimit) {
      // Add a 35% safety buffer over raw estimated gas to prevent out-of-gas reverts,
      // with a 250k floor for multi-step settlement contract operations.
      const buffered = (BigInt(populated.gasLimit) * 135n) / 100n;
      populated.gasLimit = buffered > 250_000n ? buffered : 250_000n;
    } else {
      try {
        const est = await this.signer.estimateGas(populated);
        const buffered = (est * 135n) / 100n;
        populated.gasLimit = buffered > 250_000n ? buffered : 250_000n;
      } catch {
        populated.gasLimit = 350_000n;
      }
    }

    try {
      const response = await this.signer.sendTransaction(populated);
      this.reset();
      return response;
    } catch (error: any) {
      this.reset();
      const errMsg =
        error?.info?.error?.message ||
        error?.error?.message ||
        error?.shortMessage ||
        error?.message ||
        "";

      const isNonceError =
        /gapped-nonce|nonce too low|already known|replacement transaction underpriced|NONCE_EXPIRED|could not coalesce error/i.test(
          errMsg,
        );

      if (isNonceError && attempt <= 3) {
        logger.warn(
          `Nonce sync issue detected on attempt ${attempt} (${errMsg}). Resyncing from chain in 1.5s...`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        return this.executeSendWithRetry(tx, attempt + 1);
      }

      throw error;
    }
  }
}

