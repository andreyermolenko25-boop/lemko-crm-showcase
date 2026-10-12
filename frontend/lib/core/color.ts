/**
 * sRGB hex ⇄ OKLCH and HSV, for the accent picker (plane, hue strip, HEX field, eyedropper).
 * Math from Björn Ottosson's OKLab (https://bottosson.github.io/posts/oklab/).
 */

export type Oklch = { l: number; c: number; h: number }

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** "#1e9a63", "1e9a63" or "#19a" → OKLCH; null when it is not a hex colour. */
export function hexToOklch(input: string): Oklch | null {
  let hex = input.trim().replace(/^#/, "")
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/./g, (d) => d + d)
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255))
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: (h + 360) % 360 }
}

/** OKLCH → "#rrggbb", clipped into sRGB. */
export function oklchToHex({ l, c, h }: Oklch): string {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l3 = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m3 = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s3 = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  const rgb = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ]
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255).toString(16).padStart(2, "0"))
    .join("")}`
}

export type Hsv = { h: number; s: number; v: number }

/** HSV (h 0–360, s and v 0–1) → "#rrggbb": the classic picker square and hue strip. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`
}

/** "#rrggbb" → HSV; null when it is not a hex colour. Greys keep `fallbackHue`. */
export function hexToHsv(input: string, fallbackHue = 0): Hsv | null {
  let hex = input.trim().replace(/^#/, "")
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/./g, (d) => d + d)
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = fallbackHue
  if (d > 0) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}
