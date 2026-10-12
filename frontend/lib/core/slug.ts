/**
 * API key from a human name in any interface language: "Автомобили" →
 * "avtomobili", "Właściciel" → "wlasciciel", "Größe" → "grosse". Keys must
 * match ^[a-z][a-z0-9_]{0,47}$ (the backend checks the same rule).
 */

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "yo", є: "ye", ж: "zh", з: "z", и: "i", і: "i", ї: "yi",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
}

const SPECIAL: Record<string, string> = { ł: "l", ß: "ss", æ: "ae", ø: "o", œ: "oe" }

export function slugKey(name: string): string {
  const latin = Array.from(name.trim().toLowerCase())
    .map((ch) => CYRILLIC[ch] ?? SPECIAL[ch] ?? ch)
    .join("")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
  const key = latin.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (!key) return ""
  return (/^[a-z]/.test(key) ? key : `f_${key}`).slice(0, 48).replace(/_+$/, "")
}
