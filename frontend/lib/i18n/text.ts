import { getLocale } from "@/lib/i18n/translate"

/**
 * An object name inside a sentence ("All deals", "Wszystkie transakcje").
 * German capitalises every noun, so the name keeps its case there.
 */
export function nounInSentence(label: string): string {
  return getLocale() === "de" ? label : label.toLocaleLowerCase()
}
