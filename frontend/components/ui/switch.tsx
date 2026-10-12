"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

function Switch({
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(!!defaultChecked)
  const isControlled = checked !== undefined
  const isOn = isControlled ? !!checked : uncontrolled

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(value) => {
        if (!isControlled) setUncontrolled(value)
        onCheckedChange?.(value)
      }}
      className={cn(
        "peer relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 outline-none transition-colors duration-300",
        "focus-visible:ring-[3px] focus-visible:ring-[color:var(--focus-ring)] focus-visible:border-[color:var(--focus-border)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // On follows the member's accent, so a custom colour reaches every toggle.
        isOn
          ? "bg-brand shadow-[0_0_16px_-4px_var(--brand)]"
          : "bg-foreground/12 dark:bg-white/15",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          data-slot="switch-thumb"
          className="pointer-events-none block size-6 rounded-full bg-white shadow-md ring-0 will-change-transform"
          initial={false}
          animate={{ x: isOn ? 20 : 0 }}
          transition={{
            type: "spring",
            stiffness: 520,
            damping: 34,
            mass: 0.75,
          }}
          whileTap={{ scale: 0.92 }}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
