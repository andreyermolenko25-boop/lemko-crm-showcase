"use client"

import type { ReactNode } from "react"
import { AuthProvider } from "@/components/auth-provider"

/**
 * Клиентский гард приложения: tab_session + silent refresh.
 * (App Router layout остаётся server — проверка в client-обёртке.)
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}
