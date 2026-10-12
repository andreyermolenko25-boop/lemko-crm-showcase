import { getTranslator } from "@/lib/i18n/translate"

/**
 * Text for an API error in the interface language. The backend answers with a
 * machine code ({"code", "message"}) for the errors people actually hit; its
 * own messages are written in Russian, so they are shown as-is only to people
 * who use the Russian interface, everyone else gets a translated text.
 */

const CYRILLIC = /[Ѐ-ӿ]/

type ValidationItem = { type?: unknown; loc?: unknown; msg?: unknown }

function codeOf(detail: unknown): string | undefined {
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "code" in detail) {
    const code = (detail as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

function rawMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail
  if (detail && typeof detail === "object" && "message" in detail) {
    const msg = (detail as { message?: unknown }).message
    if (typeof msg === "string") return msg
  }
  return undefined
}

function validationMessage(items: ValidationItem[]): string | undefined {
  const { maybe, t } = getTranslator()
  const first = items[0]
  if (!first) return undefined
  const loc = Array.isArray(first.loc) ? first.loc.filter((p) => p !== "body" && typeof p === "string") : []
  const fieldKey = String(loc[loc.length - 1] ?? "")
  const field = (fieldKey && maybe(`errors.fields.${fieldKey}`)) || fieldKey
  const type = typeof first.type === "string" ? first.type : ""
  const known = maybe(`errors.validation.${type}`, { field })
  if (known) return known
  const msg = typeof first.msg === "string" ? first.msg : ""
  if (msg && !CYRILLIC.test(msg)) return field ? `${field}: ${msg}` : msg
  return field ? t("errors.validation.invalid", { field }) : undefined
}

function statusMessage(status: number): string {
  const { maybe, t } = getTranslator()
  if (status >= 500) return t("errors.status.server")
  return maybe(`errors.status.${status}`) ?? t("errors.status.default")
}

/**
 * Codes that stand for several more precise server messages ("Укажите
 * телефон", "Цена не может быть отрицательной" are both `required` /
 * `invalid_value`). The Russian interface keeps the server's own sentence for them.
 */
const BROAD_CODES = new Set([
  "required",
  "invalid_value",
  "invalid_step",
  "forbidden",
  "parent_not_found",
  "cannot_provide_service",
  "insufficient_stock",
  "duplicate_name",
])

function fieldOf(detail: unknown): string | undefined {
  if (detail && typeof detail === "object" && !Array.isArray(detail) && "field" in detail) {
    const field = (detail as { field?: unknown }).field
    if (typeof field === "string") return field
  }
  return undefined
}

/** Extra fields of the error ({"min_length": 10}, {"retry_after": 540}) for the text's placeholders. */
function detailVars(detail: unknown): Record<string, string | number> | undefined {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined
  const vars: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "number" || typeof value === "string") vars[key] = value
  }
  if (typeof vars.retry_after === "number") vars.minutes = Math.max(1, Math.ceil(vars.retry_after / 60))
  return vars
}

export function describeApiError(status: number, detail: unknown): { code?: string; message: string } {
  const { locale, maybe, t } = getTranslator()
  const code = codeOf(detail)
  const raw = rawMessage(detail)
  if (code && BROAD_CODES.has(code) && locale === "ru" && raw && CYRILLIC.test(raw)) return { code, message: raw }
  // "Phone is required" when the field is one the dictionaries know.
  const fieldKey = fieldOf(detail)
  const field = fieldKey ? maybe(`errors.fields.${fieldKey}`) : undefined
  if (field && code === "required") return { code, message: t("errors.validation.missing", { field }) }
  if (field && code === "invalid_value") return { code, message: t("errors.validation.invalid", { field }) }
  const byCode = code ? maybe(`errors.codes.${code}`, detailVars(detail)) : undefined
  if (byCode) return { code, message: byCode }
  if (Array.isArray(detail)) {
    const msg = validationMessage(detail as ValidationItem[])
    if (msg) return { code, message: msg }
  }
  if (raw && (locale === "ru" || !CYRILLIC.test(raw))) return { code, message: raw }
  return { code, message: statusMessage(status) }
}

/** Network failure (offline, DNS) — fetch itself threw. */
export function networkErrorMessage(): string {
  return getTranslator().t("errors.network")
}
