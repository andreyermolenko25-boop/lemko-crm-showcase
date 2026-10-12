import type { ReactNode } from "react"
import { AuthGate } from "@/components/auth-gate"
import { AppShell } from "@/components/shell/app-shell"

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  )
}
