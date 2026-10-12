import { Suspense } from "react"
import { CompleteSignIn } from "@/components/auth-flows"

export default function CompleteSignInPage() {
  return (
    <Suspense>
      <CompleteSignIn />
    </Suspense>
  )
}
