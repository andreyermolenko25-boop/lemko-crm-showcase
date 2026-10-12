"use client"

import { useSyncExternalStore } from "react"

/**
 * Tiny store built on useSyncExternalStore.
 *
 * Selectors must return stable references (a slice of state or a primitive);
 * derive new objects with useMemo in the component instead.
 * The server is the source of truth for workspace data; `persist` only keeps a
 * local copy for things needed before sign-in (appearance, applied pre-paint).
 */
export type Store<T> = {
  get: () => T
  set: (updater: Partial<T> | ((state: T) => T)) => void
  reset: () => void
  subscribe: (listener: () => void) => () => void
  use: <S>(selector: (state: T) => S) => S
}

export function createStore<T extends object>(
  key: string,
  init: () => T,
  options: { version?: number; persist?: boolean } = {},
): Store<T> {
  const { version = 1, persist = false } = options
  const storageKey = `lemko:${key}:v${version}`
  const listeners = new Set<() => void>()
  let state: T | null = null
  let serverState: T | null = null
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  function load(): T {
    if (state) return state
    let loaded: T | null = null
    if (persist && typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(storageKey)
        if (raw) loaded = { ...init(), ...(JSON.parse(raw) as Partial<T>) }
      } catch {
        loaded = null
      }
    }
    state = loaded ?? init()
    return state
  }

  function save() {
    if (!persist || typeof window === "undefined") return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(state))
      } catch {
        // Quota or privacy mode — keep working in memory.
      }
    }, 150)
  }

  function emit() {
    listeners.forEach((l) => l())
  }

  const store: Store<T> = {
    get: load,
    set(updater) {
      const prev = load()
      const next = typeof updater === "function" ? updater(prev) : { ...prev, ...updater }
      if (Object.is(next, prev)) return
      state = next
      save()
      emit()
    },
    reset() {
      state = init()
      if (persist && typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(storageKey)
        } catch {
          // ignore
        }
      }
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    use(selector) {
      return useSyncExternalStore(
        store.subscribe,
        () => selector(load()),
        () => selector((serverState ??= init())),
      )
    },
  }

  if (typeof window !== "undefined" && persist) {
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) return
      state = null
      emit()
    })
  }

  return store
}

export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`
}
