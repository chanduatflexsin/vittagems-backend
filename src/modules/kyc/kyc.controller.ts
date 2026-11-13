import { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { kycComplianceService } from "../../blockchain/KYCComplianceService";
import { sendSuccess } from "../../utils/apiResponse";
import { ValidationError } from "../../utils/errors";

const setIdentitySchema = z.object({
  validUntil: z
    .number()
    .int()
    .safe()
    .refine(
      (value) => value > Math.floor(Date.now() / 1000),
      "validUntil must be a future Unix timestamp in seconds",
    ),
  claimsHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "claimsHash must be a 32-byte hex value")
    .refine((value) => value !== ethers.ZeroHash, "claimsHash cannot be zero"),
});

function normalizeAccount(account: string): string {
  if (!ethers.isAddress(account))
    throw new ValidationError("A valid partner wallet address is required");
  return ethers.getAddress(account);
}

export class KycController {
  static async getIdentity(req: Request, res: Response, next: NextFunction) {
    try {
      const account = normalizeAccount(req.params.address as string);
      sendSuccess(res, {
        account,
        ...(await kycComplianceService.getIdentity(account)),
      });
    } catch (error) {
      next(error);
    }
  }

  static async setIdentity(req: Request, res: Response, next: NextFunction) {
    try {
      const account = normalizeAccount(req.params.address as string);
      const { validUntil, claimsHash } = setIdentitySchema.parse(req.body);
      const txHash = await kycComplianceService.setIdentity(
        account,
        validUntil,
        claimsHash,
      );
      sendSuccess(res, { account, validUntil, claimsHash, txHash });
    } catch (error) {
      next(error);
    }
  }

  static async revokeIdentity(req: Request, res: Response, next: NextFunction) {
    try {
      const account = normalizeAccount(req.params.address as string);
      const txHash = await kycComplianceService.revokeIdentity(account);
      sendSuccess(res, { account, txHash });
    } catch (error) {
      next(error);
    }
  }
}
