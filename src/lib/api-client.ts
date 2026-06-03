import type { AppError } from "./types";

/** Error thrown by the client fetch helpers, carrying the API error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: AppError["code"],
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toError(response: Response): Promise<ApiError> {
  let code: AppError["code"] = "UNKNOWN";
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: AppError };
    if (body.error) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    // Non-JSON error body; keep defaults.
  }
  return new ApiError(message, code, response.status);
}

/**
 * Perform a GET request expecting JSON, throwing {@link ApiError} on failure.
 *
 * @param url - The request URL.
 * @returns The parsed JSON body.
 */
export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

/**
 * Perform a POST request with a JSON body, throwing {@link ApiError} on failure.
 *
 * @param url - The request URL.
 * @param body - The request payload (JSON-serialized).
 * @returns The parsed JSON body.
 */
export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}
