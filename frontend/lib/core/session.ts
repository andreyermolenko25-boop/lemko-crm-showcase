"use client"

import { fetchMe } from "@/lib/auth"
import { membersApi, setCompany, workspaceApi } from "@/lib/core/backend"
import { dataStore, loadActivities, loadMembers, loadRecords, setMe, withColor } from "@/lib/core/data"
import { applyServerPrefs, startPrefsSync } from "@/lib/core/prefs"
import { createStore } from "@/lib/core/store"
import type { Member } from "@/lib/core/types"
import { applySnapshot, bootstrapPayload, resolveEntities, syncSchema, workspaceStore } from "@/lib/core/workspace"

/**
 * Sign-in bootstrap: who am I, the workspace configuration (created from the
 * module defaults on the very first sign-in), my preferences, members, the
 * activity feed and the records of every enabled object. Afterwards keeps the
 * server's object definitions in sync and reloads data when the tab regains
 * focus (other people work in the same workspace).
 */

type SessionState = {
  status: "loading" | "ready" | "error"
  error: string | null
  role: Member["role"] | null
  /** Member preferences as loaded (theme is applied by the shell). */
  preferences: Record<string, unknown>
}

export const sessionStore = createStore<SessionState>("session", () => ({ status: "loading", error: null, role: null, preferences: {} }))
export const useSession = <S,>(selector: (s: SessionState) => S) => sessionStore.use(selector)

const entityKeys = () => resolveEntities(workspaceStore.get()).map((e) => e.key)

let booted: Promise<void> | null = null
let stopWatching: (() => void) | null = null

export function bootWorkspace(): Promise<void> {
  booted ??= (async () => {
    try {
      const me = await fetchMe()
      setCompany(me.company_id)
      const [profile, snapshot] = await Promise.all([membersApi.me(), workspaceApi.load()])
      const workspace = snapshot.initialized ? snapshot : await workspaceApi.bootstrap(bootstrapPayload())
      applySnapshot(workspace, profile.preferences)
      applyServerPrefs(profile.preferences.prefs as never)
      setMe(profile.member)
      await Promise.all([loadMembers(), loadActivities(), syncSchema(), loadRecords(entityKeys())])
      sessionStore.set({ status: "ready", error: null, role: profile.member.role, preferences: profile.preferences })
      watch()
    } catch (err) {
      booted = null
      sessionStore.set({ status: "error", error: err instanceof Error ? err.message : String(err) })
    }
  })()
  return booted
}

/** Reload everything other people may have changed. */
export async function refreshWorkspace() {
  if (sessionStore.get().status !== "ready") return
  const [snapshot, profile] = await Promise.all([workspaceApi.load(), membersApi.me()])
  applySnapshot(snapshot, profile.preferences)
  dataStore.set((s) => ({ ...s, members: s.members.map((m) => (m.id === profile.member.id ? withColor(profile.member) : m)) }))
  await Promise.all([loadMembers(), loadActivities(), syncSchema(), loadRecords(entityKeys())])
}

function watch() {
  stopWatching?.()
  let known = new Set(entityKeys())
  const unsubscribeWorkspace = workspaceStore.subscribe(() => {
    const keys = entityKeys()
    void syncSchema()
    const fresh = keys.filter((k) => !known.has(k))
    known = new Set(keys)
    if (fresh.length) void loadRecords(fresh).catch(() => undefined)
  })
  const unsubscribePrefs = startPrefsSync()
  const onFocus = () => {
    if (document.visibilityState === "visible") void refreshWorkspace().catch(() => undefined)
  }
  document.addEventListener("visibilitychange", onFocus)
  // New notifications arrive without a reload.
  const poll = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadActivities().catch(() => undefined)
  }, 60_000)
  stopWatching = () => {
    unsubscribeWorkspace()
    unsubscribePrefs()
    document.removeEventListener("visibilitychange", onFocus)
    window.clearInterval(poll)
  }
}

/** Saves top-level keys of the member's preferences (notifications, theme, …). */
export async function savePreferences(patch: Record<string, unknown>) {
  sessionStore.set((s) => ({ ...s, preferences: { ...s.preferences, ...patch } }))
  const profile = await membersApi.updateMe({ preferences: patch })
  sessionStore.set((s) => ({ ...s, preferences: profile.preferences }))
}

/** Back to the module defaults: the server drops the configuration, we create it again. */
export async function resetWorkspace() {
  await workspaceApi.reset()
  const profile = await membersApi.me()
  const snapshot = await workspaceApi.bootstrap(bootstrapPayload())
  applySnapshot(snapshot, profile.preferences)
  await Promise.all([syncSchema(), loadRecords(entityKeys())])
}

/** Replaces the configuration with an exported template (records stay). */
export async function importWorkspace(template: unknown) {
  await workspaceApi.importConfig(template)
  await refreshWorkspace()
}

/** Sign-out: forget everything loaded for this account. */
export function resetSession() {
  stopWatching?.()
  stopWatching = null
  booted = null
  sessionStore.reset()
  workspaceStore.reset()
  dataStore.reset()
}
