"use client"

import { createStore } from "@/lib/core/store"
import type { RecordValue } from "@/lib/core/types"

/** Ephemeral UI state shared across the shell (not persisted). */
type UiState = {
  commandOpen: boolean
  mobileNavOpen: boolean
  create: { entity: string; defaults?: Record<string, RecordValue> } | null
  peek: { entity: string; id: string } | null
  period: { year: number; month: number }
}

export const uiStore = createStore<UiState>(
  "ui",
  () => {
    const now = new Date()
    return {
      commandOpen: false,
      mobileNavOpen: false,
      create: null,
      peek: null,
      period: { year: now.getFullYear(), month: now.getMonth() },
    }
  },
  { persist: false },
)

export const useUi = <S,>(selector: (s: UiState) => S) => uiStore.use(selector)

export const ui = {
  openCommand: (open = true) => uiStore.set({ commandOpen: open }),
  openMobileNav: (open = true) => uiStore.set({ mobileNavOpen: open }),
  openCreate: (entity: string, defaults?: Record<string, RecordValue>) => uiStore.set({ create: { entity, defaults } }),
  closeCreate: () => uiStore.set({ create: null }),
  peek: (entity: string, id: string) => uiStore.set({ peek: { entity, id } }),
  closePeek: () => uiStore.set({ peek: null }),
  setPeriod: (year: number, month: number) => uiStore.set({ period: { year, month } }),
}
