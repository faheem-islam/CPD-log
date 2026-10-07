/** Shapes shared by the API routes and the browser. Kept free of server-only imports. */
export type ApiErrorCode =
  | "unauthorised"
  | "same_origin"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "ai_off"
  | "ai_cap"
  | "ai_failed"
  | "import_error"
  | "store_error"
  | "config"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; retryAfterSeconds?: number };
}
