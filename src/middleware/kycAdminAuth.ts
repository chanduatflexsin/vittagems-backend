import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { AppError, UnauthorizedError } from "../utils/errors";

export const authenticateKycAdmin = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const expectedKey = env.KYC_ADMIN_API_KEY;
  if (!expectedKey) {
    return next(
      new AppError(
        "KYC admin access is not configured",
        503,
        "KYC_ADMIN_NOT_CONFIGURED",
      ),
    );
  }

  const authorization = req.header("Authorization");
  const suppliedKey = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expectedKey)
    .digest();
  const suppliedDigest = crypto
    .createHash("sha256")
    .update(suppliedKey)
    .digest();

  if (!suppliedKey || !crypto.timingSafeEqual(expectedDigest, suppliedDigest)) {
    return next(
      new UnauthorizedError(
        "Invalid or missing KYC admin credentials",
        "KYC_ADMIN_UNAUTHORIZED",
      ),
    );
  }

  next();
};
