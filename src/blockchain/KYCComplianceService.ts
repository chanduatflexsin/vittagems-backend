import { ethers } from "ethers";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { logger } from "../utils/logger";
import { ResilientNonceSigner } from "./ResilientNonceSigner";

export interface KycIdentity {
  validUntil: string;
  claimsHash: string;
  isVerified: boolean;
}

export class KYCComplianceService {
  private static readonly ABI = [
    "function CLAIM_ISSUER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function identities(address account) view returns (uint64 validUntil, bytes32 claimsHash)",
    "function isVerified(address account) view returns (bool)",
    "function setIdentity(address account, uint64 validUntil, bytes32 claimsHash)",
    "function revokeIdentity(address account)",
  ];

  private readonly mock = env.BLOCKCHAIN_MODE === "mock";
  private readonly mockIdentities = new Map<
    string,
    { validUntil: string; claimsHash: string }
  >();
  private contractPromise: Promise<ethers.Contract> | null = null;
  private issuerAddress = "";

  async setIdentity(
    account: string,
    validUntil: number,
    claimsHash: string,
  ): Promise<string> {
    if (this.mock) {
      this.mockIdentities.set(account.toLowerCase(), {
        validUntil: String(validUntil),
        claimsHash,
      });
      return `0xmock_kyc_set_${Date.now()}`;
    }

    try {
      const contract = await this.getContract();
      await this.assertIssuerRole(contract);
      const overrides = contract.runner?.provider
        ? await this.txOverrides(contract.runner.provider)
        : {};
      const tx = await contract.setIdentity(
        account,
        BigInt(validUntil),
        claimsHash,
        overrides,
      );
      const receipt = await tx.wait();
      if (receipt?.status !== 1) throw new Error("transaction reverted");
      logger.info(
        `KYC identity set for ${account} in block ${receipt.blockNumber}`,
      );
      return tx.hash;
    } catch (error) {
      throw this.operationError("set identity", error);
    }
  }

  async revokeIdentity(account: string): Promise<string> {
    if (this.mock) {
      this.mockIdentities.delete(account.toLowerCase());
      return `0xmock_kyc_revoke_${Date.now()}`;
    }

    try {
      const contract = await this.getContract();
      await this.assertIssuerRole(contract);
      const overrides = contract.runner?.provider
        ? await this.txOverrides(contract.runner.provider)
        : {};
      const tx = await contract.revokeIdentity(account, overrides);
      const receipt = await tx.wait();
      if (receipt?.status !== 1) throw new Error("transaction reverted");
      logger.info(
        `KYC identity revoked for ${account} in block ${receipt.blockNumber}`,
      );
      return tx.hash;
    } catch (error) {
      throw this.operationError("revoke identity", error);
    }
  }

  private async txOverrides(
    provider: ethers.Provider,
  ): Promise<ethers.Overrides> {
    if (this.mock || env.BLOCKCHAIN_MODE === "mock") return {};

    if (env.QUORUM_CHAIN_ID === 7001) {
      return { gasPrice: 0n, type: 0 };
    }

    try {
      const feeData = await provider.getFeeData();
      if (
        feeData.maxFeePerGas !== null &&
        feeData.maxPriorityFeePerGas !== null
      ) {
        return {
          type: 2,
          maxFeePerGas: (feeData.maxFeePerGas * 130n) / 100n,
          maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 130n) / 100n,
        };
      }
      const gasPrice =
        feeData.gasPrice ??
        BigInt(await (provider as any).send("eth_gasPrice", []));
      return {
        type: 0,
        gasPrice: (gasPrice * 130n) / 100n,
      };
    } catch {
      return {};
    }
  }

  async getIdentity(account: string): Promise<KycIdentity> {
    if (this.mock) {
      const identity = this.mockIdentities.get(account.toLowerCase());
      const validUntil = identity?.validUntil ?? "0";
      return {
        validUntil,
        claimsHash: identity?.claimsHash ?? ethers.ZeroHash,
        isVerified: Boolean(
          identity &&
          BigInt(validUntil) > BigInt(Math.floor(Date.now() / 1000)),
        ),
      };
    }

    try {
      const contract = await this.getContract();
      const [identity, isVerified] = await Promise.all([
        contract.identities(account),
        contract.isVerified(account),
      ]);
      return {
        validUntil: BigInt(identity.validUntil).toString(),
        claimsHash: identity.claimsHash,
        isVerified,
      };
    } catch (error) {
      throw this.operationError("read identity", error);
    }
  }

  private async getContract(): Promise<ethers.Contract> {
    if (!env.QUORUM_RPC_URL) {
      throw new AppError(
        "QUORUM_RPC_URL is required for live KYC operations",
        503,
        "KYC_RPC_NOT_CONFIGURED",
      );
    }

    if (!this.contractPromise) {
      this.contractPromise = this.createContract();
    }

    try {
      return await this.contractPromise;
    } catch (error) {
      this.contractPromise = null;
      throw error;
    }
  }

  private async createContract(): Promise<ethers.Contract> {
    const provider = new ethers.JsonRpcProvider(env.QUORUM_RPC_URL);
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(env.KYC_CHAIN_ID)) {
        throw new AppError(
          `KYC RPC chain ID ${network.chainId} does not match configured KYC_CHAIN_ID ${env.KYC_CHAIN_ID}`,
          503,
          "KYC_CHAIN_MISMATCH",
        );
      }

      const code = await provider.getCode(env.KYC_COMPLIANCE_REGISTRY_ADDRESS);
      if (code === "0x") {
        throw new AppError(
          `No KYC registry contract found at ${env.KYC_COMPLIANCE_REGISTRY_ADDRESS} on chain ${env.KYC_CHAIN_ID}`,
          503,
          "KYC_REGISTRY_NOT_FOUND",
        );
      }

      const signer = new ethers.Wallet(
        env.KYC_ISSUER_PRIVATE_KEY || env.BLOCKCHAIN_PRIVATE_KEY,
        provider,
      );
      this.issuerAddress = signer.address;
      return new ethers.Contract(
        env.KYC_COMPLIANCE_REGISTRY_ADDRESS,
        KYCComplianceService.ABI,
        new ResilientNonceSigner(signer),
      );
    } catch (error) {
      await provider.destroy();
      throw error;
    }
  }

  private async assertIssuerRole(contract: ethers.Contract): Promise<void> {
    const role = await contract.CLAIM_ISSUER_ROLE();
    const signerAddress = this.issuerAddress;
    if (!signerAddress || !(await contract.hasRole(role, signerAddress))) {
      throw new AppError(
        `KYC issuer ${signerAddress ?? "wallet"} does not hold CLAIM_ISSUER_ROLE; grant the role on the registry contract`,
        403,
        "KYC_ISSUER_ROLE_REQUIRED",
      );
    }
  }

  private operationError(operation: string, error: unknown): AppError {
    if (error instanceof AppError) return error;
    const rpcError = error as {
      reason?: unknown;
      info?: { error?: { message?: unknown } };
      shortMessage?: unknown;
      message?: unknown;
    } | null;
    const detail =
      [
        rpcError?.reason,
        rpcError?.info?.error?.message,
        rpcError?.shortMessage,
        rpcError?.message,
      ].find((value): value is string => typeof value === "string") ??
      "unknown blockchain error";
    logger.error(`KYC ${operation} failed`, error);
    return new AppError(
      `KYC ${operation} failed: ${detail}`,
      502,
      "KYC_TRANSACTION_FAILED",
    );
  }
}

export const kycComplianceService = new KYCComplianceService();
