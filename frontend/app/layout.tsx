import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { I18nProvider } from '@/components/i18n-provider'
import { PREFS_BOOT_SCRIPT } from '@/lib/core/prefs-boot'
import { getRequestLocale, loadMessages } from '@/lib/i18n/server'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRequestLocale()
  const { messages } = await loadMessages(locale)
  return { ...metadata, description: messages.meta.description }
}

const metadata: Metadata = {
  title: 'Lemko CRM',
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0b0b' },
  ],
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale } = await getRequestLocale()
  const { messages, schema } = await loadMessages(locale)
  // CSP nonce from proxy.ts: inline scripts without it are blocked.
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies saved accent / density / radius before first paint (no flash). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: PREFS_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <I18nProvider locale={locale} messages={messages} schema={schema}>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange nonce={nonce}>
            {children}
            <Toaster position="bottom-right" />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  )
}
