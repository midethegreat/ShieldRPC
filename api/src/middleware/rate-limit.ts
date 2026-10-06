import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { sendError } from "./error-envelope.js";

const override = process.env.TEST_RATE_LIMIT_OVERRIDE;
const globalMax = override ? parseInt(override, 10) : 120;
const analyzeMax = override ? Math.max(1, Math.floor(parseInt(override, 10) / 4)) : 30;

export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    sendError(res, 429, "rate_limited", "Too many requests, please try again later", req.requestId);
  },
});

export const analyzeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: analyzeMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    sendError(res, 429, "rate_limited", "Too many analyze requests, please try again later", req.requestId);
  },
});
