import { Suspense } from "react"
import { AuthCard } from "@/components/auth-card"

export default function RegisterPage() {
  return (
    <Suspense>
      <AuthCard mode="register" />
    </Suspense>
  )
}
