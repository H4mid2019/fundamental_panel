import { NextResponse } from "next/server";
import { z } from "zod";

import type { AppError } from "./types";

/** Validation schema for a route `symbol` parameter. */
export const SymbolSchema = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[\^A-Za-z0-9.\-]+$/, "Invalid symbol");

const STATUS_BY_CODE: Record<AppError["code"], number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  UPSTREAM_TIMEOUT: 504,
  PROVIDER_ERROR: 502,
  UNKNOWN: 500,
};

/**
 * Build a JSON error response from an {@link AppError}.
 *
 * @param error - The application error to surface.
 * @param headers - Optional extra response headers.
 * @returns A `NextResponse` with the mapped HTTP status.
 */
export function errorResponse(
  error: AppError,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: STATUS_BY_CODE[error.code], headers },
  );
}

/**
 * Extract a best-effort client IP from request headers.
 *
 * @param request - The incoming request.
 * @returns The first forwarded IP, or `"unknown"`.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
