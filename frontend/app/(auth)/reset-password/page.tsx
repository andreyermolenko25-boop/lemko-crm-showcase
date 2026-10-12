import { Suspense } from "react"
import { ResetPasswordCard } from "@/components/auth-flows"

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordCard />
    </Suspense>
  )
}
