import type { ModuleManifest } from "@/lib/core/types"
import { coreModule } from "@/lib/modules/core"
import {
  bookingsModule,
  inventoryModule,
  invoicingModule,
  projectsModule,
  realEstateModule,
  supportModule,
} from "@/lib/modules/catalog"

/**
 * Module registry. A niche package plugs in with `registerModule(manifest)`
 * (e.g. from its own folder under lib/modules/<niche>) and becomes available
 * in Apps → install. Installed state lives in the workspace store.
 */
const registry = new Map<string, ModuleManifest>()

export function registerModule(manifest: ModuleManifest) {
  registry.set(manifest.id, manifest)
}

export function getModule(id: string): ModuleManifest | undefined {
  return registry.get(id)
}

export function listModules(): ModuleManifest[] {
  return [...registry.values()]
}

;[coreModule, bookingsModule, invoicingModule, projectsModule, inventoryModule, supportModule, realEstateModule].forEach(
  registerModule,
)

/** Modules a new workspace starts with (applied once, on the first sign-in). */
export const DEFAULT_ENABLED_MODULES = ["core", "bookings", "inventory", "invoicing"]
