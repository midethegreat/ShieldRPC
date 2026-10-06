import type { Request, Response, NextFunction } from "express";

export interface ErrorEnvelope {
  error: string;
  message: string;
  request_id?: string;
  issues?: Array<{ path: string; message: string }>;
}

export function sendError(
  res: Response,
  status: number,
  errorCode: string,
  message: string,
  requestId?: string,
  extras?: Omit<Partial<ErrorEnvelope>, "error" | "message" | "request_id">,
): Response {
  const body: ErrorEnvelope = {
    error: errorCode,
    message,
  };
  if (requestId) body.request_id = requestId;
  if (extras?.issues) body.issues = extras.issues;
  return res.status(status).json(body);
}

export function notFoundHandler(
  req: Request,
  res: Response,
): void {
  sendError(res, 404, "not_found", `Route ${req.method} ${req.path} not found`, req.requestId);
}

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("too large") || message.includes("payload too large")) {
    sendError(res, 413, "payload_too_large", message, req.requestId);
    return;
  }
  sendError(res, 500, "internal_error", message, req.requestId);
}
