import { Suspense } from "react"
import { ForgotPasswordCard } from "@/components/auth-flows"

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordCard />
    </Suspense>
  )
}
