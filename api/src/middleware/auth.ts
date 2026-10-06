import type { Request, Response, NextFunction } from "express";
import { sendError } from "./error-envelope.js";

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = process.env.API_SHARED_TOKEN;
  if (!token) {
    next();
    return;
  }
  if (req.path.startsWith("/v1/health")) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendError(res, 401, "unauthorized", "Authorization header required", req.requestId);
    return;
  }
  const provided = authHeader.slice(7);
  if (provided !== token) {
    sendError(res, 401, "unauthorized", "Invalid token", req.requestId);
    return;
  }
  next();
}
