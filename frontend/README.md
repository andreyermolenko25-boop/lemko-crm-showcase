# Lemko CRM — frontend

Next.js 16 (App Router) · Tailwind v4 · shadcn/ui · Recharts. Light & dark themes.

```bash
pnpm install
cp .env.example .env.local   # API_URL = FastAPI origin (default http://localhost:8000)
pnpm dev                     # http://localhost:3000 — sign in or register a workspace at /register
pnpm typecheck
```

There is no demo mode: everything you see is stored by the backend. A new workspace
starts empty with the default modules, views, dashboards and reports.

## Idea: one core, attachable modules

The UI never hard-codes a niche. Everything is driven by **schema** (`lib/core/types.ts`):

| Concept | What it is | Where |
| --- | --- | --- |
| `EntityDef` / `FieldDef` | An object (Deals, Vehicles, Patients…) and its typed fields | `lib/core/types.ts` |
| `ModuleManifest` | A package of entities + default views | `lib/modules/*` |
| `ViewDef` | Saved table / board / gallery / list / calendar view with filters, sort, grouping, columns | workspace store |
| `DashboardDef` / `WidgetInstance` | Customizable dashboards made of widgets | `components/dashboard/*` |

Any object, from the core, a module or created by the user in **Settings → Objects & fields**,
gets these automatically: navigation, list views, record page, peek drawer, create form, ⌘K search,
calendar, reports and dashboard widgets.

### Adding a niche module

```ts
// lib/modules/clinic.ts
import type { ModuleManifest } from "@/lib/core/types"

export const clinicModule: ModuleManifest = {
  id: "clinic",
  name: "Clinic",
  tagline: "Patients, visits, treatments",
  description: "…",
  icon: "stethoscope",
  color: "teal",
  category: "Industry",
  version: "1.0.0",
  entities: [
    {
      key: "visits", label: "Visits", labelSingular: "Visit", icon: "calendar", color: "teal",
      module: "clinic", primaryField: "title", stageField: "status", dateField: "startsAt",
      fields: [
        { key: "title", label: "Title", type: "text", required: true, system: true },
        { key: "patient", label: "Patient", type: "relation", relation: "contacts" },
        { key: "startsAt", label: "Starts", type: "datetime" },
        { key: "status", label: "Status", type: "status", options: [/* … */] },
      ],
    },
  ],
  views: [{ entity: "visits", name: "Schedule", type: "calendar", columns: ["patient"], filters: [] }],
}
```

Then register it in `lib/modules/index.ts` (`registerModule(clinicModule)`). It shows up in **Apps**,
and installing it adds its objects to the workspace.

### Packages (manifest)

**Apps → Add module** installs a JSON manifest from a file or a URL. Its objects become custom
objects of the workspace (stored in the workspace config), its views are created on the server.
Turning a package off hides its objects; uninstalling removes them (records stay in the database).

```json
{
  "name": "Clinic",
  "version": "1.0.0",
  "entities": [
    {
      "key": "patients", "label": "Patients", "labelSingular": "Patient", "icon": "users", "color": "teal",
      "primaryField": "name",
      "fields": [
        { "key": "name", "label": "Name", "type": "text", "required": true },
        { "key": "phone", "label": "Phone", "type": "phone" }
      ]
    }
  ],
  "views": [{ "entity": "patients", "name": "All patients", "type": "table", "columns": ["name", "phone"] }]
}
```

### Integrations store

`/integrations` lists 24 integrations (`lib/core/integrations.ts`): Gmail, Google Calendar, Outlook,
Slack, Telegram, WhatsApp, Stripe and others. Connecting one stores the connection (account, sync
settings, last sync) on the server (`/integrations/{app}`). Provider OAuth and the actual data sync
are not implemented yet. For anything else use **Settings → API & webhooks**: API keys for the
external REST API and signed webhooks.

## Customization (per workspace, exportable as JSON)

- **Appearance**: light/dark/system theme, accent colour, corner radius, density, text size, sidebar style, contrast, reduced motion
- **Language & region** (per member): interface language, currency, number & date format, first day of the week
- **Navigation**: reorder or hide items, pin views and records to Favorites
- **Data model**: rename objects and fields, change icons and colours, add custom fields (17 types), create custom objects
- **Views**: any number of saved views per object, plus inline editing, column resize and reordering, bulk actions and CSV export
- **Dashboards**: multiple dashboards, drag to reorder, resize, configure and add widgets
- **Reports**: a builder that works for every object
- **Security & login**: email and phone linking with OTP codes, password change, social sign-in, 2FA (authenticator app, SMS, passkeys, backup codes), active sessions, login history and workspace security policy

Charts use a validated categorical palette (`--series-1…8` in `globals.css`). It has separate light and dark steps and is safe for colour-blind readers in adjacent pairs. Funnels use an ordinal blue ramp (`--ramp-1…6`).

## Languages

The interface is available in English, Polish, German, Ukrainian and Russian (`lib/i18n`).

- **Which language**: the member's choice (cookie `lemko_locale`, also saved in their preferences so a new
  device starts in the same language) or, with *Automatic*, the best match of the browser's
  `Accept-Language` — the OS / browser languages, which Chrome syncs from the Google account.
  English is the fallback. The server picks it before rendering, so there is no flash of another
  language, `<html lang>` is right, and only that one dictionary is sent to the browser.
- **Switching**: Settings → Language & region, the user menu, ⌘K, or the switcher on the sign-in page.
  The layout is re-rendered with `router.refresh()`; client state is kept.
- **Strings**: `lib/i18n/messages/en.ts` is the source. Components call `const t = useT()` →
  `t("auth.signIn")`; code outside React imports `t` from `lib/i18n/translate`. Keys are type-checked
  and every language must have every key (`pnpm typecheck` fails otherwise). `{name}` is a placeholder;
  `{ one, few, many, other }` are plural forms picked by `count` (Intl.PluralRules).
- **Built-in objects and catalogues**: module, object, field and option labels, default view names and
  the integrations store are translated through each dictionary's `schema` export. Workspace renames
  always win, and the server keeps the English schema. Built-in default names stored in the workspace
  (dashboards, widgets, reports, views) stay English in the database and are shown in each member's
  language until someone renames them.
- **Activity feed**: besides a ready English `title`, the server stores what happened in each event
  (`event`, e.g. `record.stage`, and `params`: object, field and option keys, record title).
  `lib/core/activity-text.ts` builds the sentence with `t("activity.*")` and the localized schema, so
  the inbox, notifications, record timeline and activity widget read in the member's language and
  follow workspace renames. Events written before that have no `event` and show their stored title.
- **API errors**: the backend answers errors people can hit with a code (`{"detail": {"code", "message"}}`);
  `lib/i18n/errors.ts` shows `errors.codes.<code>` in the interface language (and names the field for
  `required` / `invalid_value` when `errors.fields` knows it), and never shows the backend's Russian
  messages to people using another language. A new code needs a text in all five dictionaries.
- **Adding a language**: add it to `LOCALES` in `lib/i18n/config.ts`, copy `messages/en.ts` and register
  the file in `lib/i18n/server.ts`.

## Structure

```
app/(app)/            pages: dashboard, /o/[entity], /o/[entity]/[id], inbox, calendar, reports, integrations, apps, settings
components/shell/     sidebar, top bar, command palette, app shell
components/views/     table, board, gallery, list, calendar + toolbar (filters, sort, group, fields)
components/crm/       field renderers/editors, record detail, peek drawer, create dialog, primitives
components/dashboard/ widget registry + editable dashboard grid
components/settings/  settings sections (appearance, objects, members, integrations…)
lib/core/             types, stores (prefs, workspace, data, ui), formatting, icons, navigation
lib/i18n/             languages: detection, dictionaries, translator, API error texts
lib/modules/          core CRM module + attachable niche modules
```

## Backend wiring

Sign-in uses an httpOnly session cookie set by the Next.js BFF routes in `app/api/*`; every API call
goes through `/api/backend/*` (`lib/api.ts`), which forwards it to `API_URL` with the token.

| Module | What it does |
| --- | --- |
| `lib/core/session.ts` | Boot after sign-in: profile, workspace (bootstrapped from the module defaults on the first sign-in), members, activity feed, records of every object. Reloads when the tab becomes visible; polls the feed every minute. |
| `lib/core/backend.ts` | Typed client for every API resource used by the UI. |
| `lib/core/data.ts` | Records, feed and members. Edits apply instantly and roll back with an error toast if the API rejects them; creations wait for the server (real ids, validation, side effects). |
| `lib/core/workspace.ts` | Workspace configuration (modules, objects, overrides, navigation), views, dashboards, reports, connected apps. Rapid edits are debounced into one request. The resolved object definitions are pushed to `PUT /workspace/schema` so the server can title the feed and compute widgets. |
| `lib/core/analytics.ts` | Dashboard widgets and reports. All numbers are computed by the server (`stats.py`); the widgets of a dashboard are fetched in one batch. |
| `lib/core/prefs.ts` | Appearance preferences — cached locally for the first paint, stored in the member's preferences on the server. |

Records of every object use one API (`/companies/{id}/records/{entity}`). Contacts, services,
products, appointments and shifts are stored in their own tables (clients, services, inventory, the
booking engine with overlap checks and stock write-off); every other object — deals, companies,
tasks, invoices, custom objects — is stored as a generic record. Fields marked `readOnly` (lifetime
value, paid amount, stock status) are computed by the server.

State lives in small stores (`lib/core/store.ts`); only the appearance preferences are kept in
`localStorage`.
