'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      // Sonner hard-codes 13px toasts and 12px action buttons; follow the type scale
      // (and the member's text-size preference) instead.
      toastOptions={{
        style: { fontSize: 'var(--text-sm)' },
        actionButtonStyle: { height: '1.75rem', fontSize: 'var(--text-xs)' },
        cancelButtonStyle: { height: '1.75rem', fontSize: 'var(--text-xs)' },
        classNames: { description: 'text-xs' },
      }}
      {...props}
    />
  )
}

export { Toaster }
