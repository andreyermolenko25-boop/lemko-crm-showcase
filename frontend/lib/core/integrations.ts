import type { SchemaMessages } from "@/lib/i18n/translate"

/** Integration store catalogue (UI only — OAuth & sync are wired to the backend later). */

export type IntegrationCategory =
  | "Email"
  | "Calendar"
  | "Messaging"
  | "Calls & video"
  | "Payments"
  | "Accounting"
  | "Files"
  | "Marketing"
  | "Forms"
  | "Automation"
  | "Analytics"
  | "Documents"

export type IntegrationDef = {
  id: string
  name: string
  category: IntegrationCategory
  tagline: string
  description: string
  /** Monogram tile colours (generic, not brand assets). */
  bg: string
  fg: string
  mark: string
  auth: "oauth" | "apikey" | "phone"
  provider?: string
  popular?: boolean
  permissions: string[]
  settings: { key: string; label: string; hint?: string; default?: boolean }[]
}

const syncContacts = { key: "contacts", label: "Match & create contacts", hint: "Unknown senders become contacts", default: true }

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "gmail", name: "Gmail", category: "Email", tagline: "Two-way email sync on every record", provider: "Google",
    description: "Send and receive email from Lemko, log conversations to the timeline automatically and track opens.",
    bg: "#fde8e7", fg: "#c5221f", mark: "G", auth: "oauth", popular: true,
    permissions: ["Read, send and organise email", "See your primary email address", "Access email metadata for matching"],
    settings: [{ key: "sync", label: "Sync inbox", default: true }, { key: "log", label: "Log emails to timeline", default: true }, { key: "track", label: "Track opens & clicks" }, syncContacts],
  },
  {
    id: "google-calendar", name: "Google Calendar", category: "Calendar", tagline: "Meetings & bookings in both directions", provider: "Google",
    description: "Show events in the Lemko calendar, create meetings from deals and push appointments to staff calendars.",
    bg: "#e3edfd", fg: "#1a73e8", mark: "31", auth: "oauth", popular: true,
    permissions: ["See and edit events on your calendars", "View free/busy information"],
    settings: [{ key: "sync", label: "Two-way event sync", default: true }, { key: "meet", label: "Add video link to new meetings", default: true }, { key: "busy", label: "Block booking slots when busy", default: true }],
  },
  {
    id: "outlook", name: "Outlook Mail", category: "Email", tagline: "Microsoft 365 email sync", provider: "Microsoft",
    description: "Connect Microsoft 365 or Outlook.com mailboxes to send, receive and log email.",
    bg: "#e1effa", fg: "#0f6cbd", mark: "O", auth: "oauth",
    permissions: ["Read and send mail", "Read your profile"],
    settings: [{ key: "sync", label: "Sync inbox", default: true }, { key: "log", label: "Log emails to timeline", default: true }, syncContacts],
  },
  {
    id: "outlook-calendar", name: "Outlook Calendar", category: "Calendar", tagline: "Microsoft 365 calendars", provider: "Microsoft",
    description: "Two-way calendar sync with Microsoft 365, Teams meeting links for new events.",
    bg: "#e1effa", fg: "#0f6cbd", mark: "OC", auth: "oauth",
    permissions: ["Read and write calendars"],
    settings: [{ key: "sync", label: "Two-way event sync", default: true }, { key: "teams", label: "Add Teams link to meetings" }],
  },
  {
    id: "google-drive", name: "Google Drive", category: "Files", tagline: "Attach files from Drive", provider: "Google",
    description: "Attach Drive files to any record and keep a folder per company or deal.",
    bg: "#e6f4ea", fg: "#188038", mark: "D", auth: "oauth",
    permissions: ["See and download files you open with Lemko", "Create folders"],
    settings: [{ key: "folders", label: "Auto-create a folder per company" }],
  },
  {
    id: "google-sheets", name: "Google Sheets", category: "Analytics", tagline: "Export & import tables", provider: "Google",
    description: "Push views to Sheets on a schedule or import rows as records.",
    bg: "#e6f4ea", fg: "#188038", mark: "S", auth: "oauth",
    permissions: ["Create and edit spreadsheets you choose"],
    settings: [{ key: "schedule", label: "Nightly export of saved views" }],
  },
  {
    id: "slack", name: "Slack", category: "Messaging", tagline: "Deal alerts & daily digest",
    description: "Post notifications to channels, create records from messages and get a morning digest.",
    bg: "#f3e8f7", fg: "#611f69", mark: "#", auth: "oauth", popular: true,
    permissions: ["Post messages to selected channels", "Read basic workspace info"],
    settings: [{ key: "sync", label: "Deal stage alerts", default: true }, { key: "digest", label: "Daily digest at 9:00", default: true }],
  },
  {
    id: "telegram", name: "Telegram", category: "Messaging", tagline: "Chat with clients from the record page",
    description: "Connect a bot or business account; conversations land on the contact timeline.",
    bg: "#e2f3fb", fg: "#229ed9", mark: "T", auth: "apikey", popular: true,
    permissions: ["Receive messages sent to your bot", "Send messages on your behalf"],
    settings: [{ key: "sync", label: "Log chats to timeline", default: true }, syncContacts, { key: "notify", label: "Notify owner on new message", default: true }],
  },
  {
    id: "whatsapp", name: "WhatsApp Business", category: "Messaging", tagline: "Templates, reminders, two-way chat",
    description: "Send booking reminders and templates, reply to customers from Lemko.",
    bg: "#e5f7ec", fg: "#1da851", mark: "W", auth: "phone",
    permissions: ["Send template messages", "Receive incoming messages"],
    settings: [{ key: "reminders", label: "Appointment reminders", default: true }, { key: "sync", label: "Log chats to timeline", default: true }],
  },
  {
    id: "twilio", name: "Twilio", category: "Calls & video", tagline: "Click-to-call, SMS, call recording",
    description: "Call and text from the record page; recordings and SMS are logged automatically.",
    bg: "#fde7ea", fg: "#e01e48", mark: "Tw", auth: "apikey",
    permissions: ["Place and receive calls", "Send SMS"],
    settings: [{ key: "record", label: "Record calls", default: false }, { key: "sms", label: "Log SMS", default: true }],
  },
  {
    id: "zoom", name: "Zoom", category: "Calls & video", tagline: "Video links for meetings",
    description: "Generate Zoom links for meetings and attach recordings to records.",
    bg: "#e5effe", fg: "#0b5cff", mark: "Z", auth: "oauth",
    permissions: ["Create meetings", "Read meeting recordings"],
    settings: [{ key: "auto", label: "Add link to every meeting", default: true }],
  },
  {
    id: "stripe", name: "Stripe", category: "Payments", tagline: "Payments & invoice status", popular: true,
    description: "Collect payments for invoices, sync payment status and customer LTV.",
    bg: "#eeedfd", fg: "#635bff", mark: "S", auth: "oauth",
    permissions: ["Read charges and customers", "Create payment links"],
    settings: [{ key: "status", label: "Sync invoice status", default: true }, { key: "ltv", label: "Update customer LTV", default: true }],
  },
  {
    id: "paypal", name: "PayPal", category: "Payments", tagline: "Payment links & status",
    description: "Send PayPal payment links and track settlement.",
    bg: "#e6f0fa", fg: "#003087", mark: "P", auth: "oauth",
    permissions: ["Create invoices", "Read transactions"],
    settings: [{ key: "status", label: "Sync payment status", default: true }],
  },
  {
    id: "quickbooks", name: "QuickBooks", category: "Accounting", tagline: "Invoices & customers to accounting",
    description: "Push invoices and customers to QuickBooks and pull payment status.",
    bg: "#e7f6e9", fg: "#2ca01c", mark: "qb", auth: "oauth",
    permissions: ["Read and write invoices and customers"],
    settings: [{ key: "push", label: "Push new invoices", default: true }],
  },
  {
    id: "xero", name: "Xero", category: "Accounting", tagline: "Accounting sync",
    description: "Keep invoices, contacts and payments in sync with Xero.",
    bg: "#e2f5fb", fg: "#13b5ea", mark: "X", auth: "oauth",
    permissions: ["Read and write invoices and contacts"],
    settings: [{ key: "push", label: "Push new invoices", default: true }],
  },
  {
    id: "dropbox", name: "Dropbox", category: "Files", tagline: "Attach Dropbox files",
    description: "Link Dropbox files and folders to records.",
    bg: "#e5effe", fg: "#0061fe", mark: "Db", auth: "oauth",
    permissions: ["View files you select"],
    settings: [],
  },
  {
    id: "mailchimp", name: "Mailchimp", category: "Marketing", tagline: "Sync audiences & campaign activity",
    description: "Sync segments to audiences and log campaign opens on contacts.",
    bg: "#fff6d6", fg: "#7a5b00", mark: "M", auth: "oauth",
    permissions: ["Manage audiences", "Read campaign reports"],
    settings: [{ key: "segments", label: "Sync saved views as segments", default: true }],
  },
  {
    id: "meta-leads", name: "Meta Lead Ads", category: "Marketing", tagline: "Facebook & Instagram leads → contacts",
    description: "Leads from ad forms arrive instantly as contacts with source attribution.",
    bg: "#e7f0fd", fg: "#0866ff", mark: "f", auth: "oauth",
    permissions: ["Read lead form submissions", "Read ad account basics"],
    settings: [{ key: "assign", label: "Round-robin assign new leads", default: true }],
  },
  {
    id: "typeform", name: "Typeform", category: "Forms", tagline: "Form answers as records",
    description: "Map form questions to fields and create or update records.",
    bg: "#efefef", fg: "#262627", mark: "Tf", auth: "oauth",
    permissions: ["Read form responses"],
    settings: [{ key: "update", label: "Update existing contacts by email", default: true }],
  },
  {
    id: "calendly", name: "Calendly", category: "Calendar", tagline: "Booked meetings create deals",
    description: "New bookings create contacts, deals or appointments automatically.",
    bg: "#e5f0ff", fg: "#006bff", mark: "C", auth: "oauth",
    permissions: ["Read scheduled events"],
    settings: [{ key: "deal", label: "Create a deal for each booking" }],
  },
  {
    id: "docusign", name: "DocuSign", category: "Documents", tagline: "Send contracts for signature",
    description: "Send contracts from a deal and move it forward when signed.",
    bg: "#fff3d6", fg: "#6b4e00", mark: "Ds", auth: "oauth",
    permissions: ["Send envelopes", "Read envelope status"],
    settings: [{ key: "advance", label: "Move deal to Won when signed" }],
  },
  {
    id: "zapier", name: "Zapier", category: "Automation", tagline: "6,000+ apps via Zaps",
    description: "Trigger Zaps on record events and create records from any app.",
    bg: "#ffece4", fg: "#ff4f00", mark: "Z", auth: "apikey",
    permissions: ["Use your Lemko API key"],
    settings: [],
  },
  {
    id: "make", name: "Make", category: "Automation", tagline: "Visual scenarios",
    description: "Build multi-step scenarios using Lemko modules.",
    bg: "#f1e8fd", fg: "#6d00cc", mark: "Mk", auth: "apikey",
    permissions: ["Use your Lemko API key"],
    settings: [],
  },
  {
    id: "google-analytics", name: "Google Analytics", category: "Analytics", tagline: "Attribute deals to campaigns", provider: "Google",
    description: "Pull UTM and session data to attribute contacts and revenue to channels.",
    bg: "#fff1e0", fg: "#e37400", mark: "GA", auth: "oauth",
    permissions: ["Read analytics data"],
    settings: [{ key: "utm", label: "Store UTM on new contacts", default: true }],
  },
]

export const INTEGRATION_CATEGORIES = [...new Set(INTEGRATIONS.map((i) => i.category))]

/** The catalogue entry with texts in the interface language (English is the source). */
export function localizeIntegration(app: IntegrationDef, schema: SchemaMessages): IntegrationDef {
  const own = schema.integrations?.[app.id]
  const settings = own?.settings ?? {}
  return {
    ...app,
    tagline: own?.tagline ?? app.tagline,
    description: own?.description ?? app.description,
    permissions: app.permissions.map((p, i) => own?.permissions?.[i] ?? p),
    settings: app.settings.map((s) => ({ ...s, label: settings[s.key]?.label ?? s.label, hint: settings[s.key]?.hint ?? s.hint })),
  }
}
