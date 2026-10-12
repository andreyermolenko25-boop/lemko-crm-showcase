/**
 * Network layer: every call goes to the Next.js BFF (`/api/backend/*`), which
 * turns the httpOnly session cookie into `Authorization: Bearer` for FastAPI.
 * The JWT never reaches browser JavaScript.
 */

import { describeApiError, networkErrorMessage } from "@/lib/i18n/errors"

export class ApiError extends Error {
  status: number
  detail: unknown
  /** Machine reason from the backend ("invalid_credentials"), when it sent one. */
  code?: string

  constructor(status: number, message: string, detail?: unknown, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.detail = detail ?? message
    this.code = code
  }

  /** Error from a failed response body, with the message in the interface language. */
  static fromResponse(status: number, data: unknown): ApiError {
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data
    const { code, message } = describeApiError(status, detail)
    return new ApiError(status, message, detail, code)
  }
}

/** fetch that turns a network failure into an ApiError with a readable message. */
export async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (err) {
    throw new ApiError(0, networkErrorMessage(), err instanceof Error ? err.message : String(err), "network")
  }
}

/** Parses a response body as JSON, falling back to the raw text. */
export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export type QueryParamValue = string | number | boolean | null | undefined

export type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown
  params?: Record<string, QueryParamValue>
}

function withQuery(url: string, params?: Record<string, QueryParamValue>): string {
  if (!params) return url
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    qs.set(key, String(value))
  }
  const q = qs.toString()
  return q ? `${url}${url.includes("?") ? "&" : "?"}${q}` : url
}

/** JSON request to the API (path relative to the backend root, e.g. `/auth/me`). */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { body, params, headers: extraHeaders, ...rest } = options
  const url = withQuery(`/api/backend${path.startsWith("/") ? path : `/${path}`}`, params)
  const headers = new Headers(extraHeaders)
  const isForm = typeof FormData !== "undefined" && body instanceof FormData
  if (body !== undefined && !isForm && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")

  const response = await safeFetch(url, {
    ...rest,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (response.status === 204) return undefined as T

  const data = await readBody(response)
  if (!response.ok) throw ApiError.fromResponse(response.status, data)
  return data as T
}
