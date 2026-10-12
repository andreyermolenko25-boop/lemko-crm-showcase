import { Suspense } from "react"
import { MagicLinkCard } from "@/components/auth-flows"

export default function MagicLinkPage() {
  return (
    <Suspense>
      <MagicLinkCard />
    </Suspense>
  )
}
