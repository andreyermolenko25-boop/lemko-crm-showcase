/** Keys shared between the inline boot script and the prefs store. */
export const PREFS_STORAGE_KEY = "lemko:prefs:v1"

/**
 * Font stacks of the "Text font" / "Heading font" choices. Only Geist ships
 * with the app; the others use the best match installed on the device, so
 * nothing is downloaded.
 */
export const FONT_STACKS: Record<string, string> = {
  geist: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  humanist: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  geometric: "Avenir, 'Avenir Next LT Pro', Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  serif: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
  rounded: "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', 'Arial Rounded MT Bold', Calibri, source-sans-pro, sans-serif",
  mono: "var(--font-geist-mono), ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
}

/**
 * Saved appearance → attributes and CSS variables on <html>. The same function
 * runs in the <head> boot script (before the first paint) and from the store
 * after hydration, so the two can never disagree.
 *
 * It is inlined with toString(): keep it self-contained — no imports, no outer
 * variables (the font stacks come in as an argument), plain syntax only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function paintAppearance(p: any, root: HTMLElement, fonts: Record<string, string>) {
  var d = root.dataset
  var s = root.style
  d.accent = p.accent || "emerald"
  d.shade = p.accentShade || "base"
  d.density = p.density || "comfortable"
  d.contrast = p.contrast || "normal"
  d.motion = p.reduceMotion ? "reduced" : "full"
  d.weight = p.weight || "regular"
  d.leading = p.lineHeight || "normal"
  d.tracking = p.letterSpacing || "normal"
  d.numerals = p.tabularNumbers ? "tabular" : "proportional"
  d.shadows = p.shadows || "soft"
  d.borders = p.borders || "normal"
  d.canvas = p.canvas || "soft"
  d.stroke = p.iconStroke || "regular"
  // A colour picked in the accent picker overrides the [data-accent] preset.
  var custom = p.accent === "custom" && typeof p.accentHue === "number"
  if (custom) {
    s.setProperty("--accent-h", String(p.accentHue))
    s.setProperty("--accent-c", String(typeof p.accentChroma === "number" ? p.accentChroma : 0.15))
  } else {
    s.removeProperty("--accent-h")
    s.removeProperty("--accent-c")
  }
  // Its exact lightness overrides the [data-shade] step; the rest of the ramp
  // (dark theme, text on white, soft fill) keeps the steps' spacing.
  var shadeVars = ["--shade-l", "--shade-l-dark", "--shade-fg-l", "--shade-text-l", "--shade-text-l-dark", "--shade-soft-l"]
  if (custom && typeof p.accentLight === "number") {
    var L = p.accentLight
    var k = (L - 0.56) / 0.07
    var clamp = function (v: number, lo: number, hi: number) {
      return Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000
    }
    var ramp = [L, clamp(0.74 + 0.055 * k, 0.55, 0.9), L >= 0.6 ? 0.2 : 0.99, clamp(0.42 + 0.04 * k, 0.3, 0.5), clamp(0.82 + 0.04 * k, 0.72, 0.92), clamp(0.95 + 0.0075 * k, 0.92, 0.965)]
    for (var i = 0; i < shadeVars.length; i++) s.setProperty(shadeVars[i], String(ramp[i]))
  } else {
    for (var j = 0; j < shadeVars.length; j++) s.removeProperty(shadeVars[j])
  }
  var body = fonts[p.fontBody] || fonts.geist
  s.setProperty("--font-body", body)
  s.setProperty("--font-heading", (p.fontHeading && fonts[p.fontHeading]) || body)
  s.setProperty("--radius", (p.radius != null ? p.radius : 0.75) + "rem")
  s.setProperty("--font-size", (p.textSize || 16) + "px")
}

/**
 * Inline <head> script: applies saved appearance before React hydrates,
 * so there is no flash of the default accent / fonts / density / radius.
 */
export const PREFS_BOOT_SCRIPT = `(function(){try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(
  PREFS_STORAGE_KEY,
)})||"{}");(${paintAppearance.toString()})(p,document.documentElement,${JSON.stringify(FONT_STACKS)})}catch(e){}})();`
