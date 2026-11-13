# EMBMIS design system

One folder, one import: `import { Button, DataTable, PageHeader } from '../components/ui'`.
See every component in every state, in both themes, at **/system**.

## Rules

- **Colour means something.** Ink for everything. Ultramarine (`brand`) only when the
  system is acting or for the screen's one primary action. `ok`, `warn`, `risk` only
  for state. Never pick a hex in a page. If you need a colour the system lacks, add
  it to `scripts/design/palette.mjs` (the generator checks contrast).
- **Status** always goes through `StatusBadge`. It maps any module's status string
  to one of eleven canonical states, each with a tone and a glyph.
- **Numbers** go through `Money`, `Num`, `Variance`. Missing is `—`, never `0`.
- **Identifiers** (`PO-2026-1004`) use `Code` (mono).
- **One primary action** per screen, passed to `PageHeader primary`.
- **Destructive actions** use `variant="destructive"` and confirm with
  `ConfirmDialog`, which names the consequence and says whether it can be undone.
- **No spinners over blank space.** Use `SkeletonRows`, `SkeletonDetail`, or the
  `loading` prop on `DataTable`.
- **No toasts for things on screen.** Use `InlineNotice`; toast only outcomes that
  left the screen (`notify`).
- **Errors** use `ErrorState` / `describeError`: what failed, what to do, reference id.

## Components

| Component | Use |
|---|---|
| `Button`, `IconButton`, `Kbd` | `variant`: primary, secondary, ghost, destructive, danger. `to` for links. `IconButton` requires `label`. |
| `Field` + `Input`/`Textarea`/`Select`/`Combobox` | Label above, help below, error replaces help. `required` says so in words. |
| `FormSection` | Groups fields; `advanced` collapses rarely-used ones. |
| `ErrorSummary`, `useFieldValidation` | Error list at the top after submit; validate on blur. |
| `useDraft(key, initial)` | Autosaves a form locally; restores after navigation or session expiry. |
| `DataTable` | Lists. Sticky header/first column, resize, reorder, saved views (`viewKey`), column filters, keyboard, selection + `bulkActions`, `rowActions`, inline edit (`onCellEdit`), virtualised, phone cards (`mobile` on columns). |
| `LineItemEditor` | PO/journal/BOM lines. Tab across, Enter down, paste from Excel, live totals. |
| `PageHeader`, `Breadcrumbs` | Title, status, one-line description or meta, secondary + primary actions. |
| `DetailLayout`, `SummaryStrip`, `Tabs`, `Timeline`, `RelatedPanel`, `DescriptionList` | The record pattern: five facts, tabs, history, related records. |
| `Card`, `Stat`, `Segmented`, `Menu`, `Tooltip` | Containers and small controls. `Stat` links to the records behind a number. |
| `Dialog`, `Sheet`, `ConfirmDialog` | Focus-trapped overlays; become bottom sheets on phones. |
| `EmptyState`, `ErrorState`, `InlineNotice`, `Unavailable` | Feedback. |
| `StatusBadge`, `Badge`, `MaturityBadge` | Status; tonal labels; Beta/Preview/Demo data/Unavailable. |
| `AiAnswer`, `Provenance`, `SimeliMark` | Simeli: Read / Concluded / Proposes (approve to act). `Provenance` explains where a figure comes from. |
| `GatewayLine`, `GatewayReason` | EMBMIS Gateway next to Simeli: "Checked by EMBMIS Gateway: N allowed, M sent to you", and the reason on a proposal the gateway sent to the person. Render nothing when the gateway is off. |
| `CommandPalette` | Used by the shell (⌘K). |
| `ToastHost`, `notify` | Mounted once in `App.jsx`. `notify.undo` for optimistic actions. |

Legacy exports (`Table`, `Modal`, `Pagination`, `DocumentLink`, `RelatedDocuments`) and the
default-export shims (`Card.jsx`, `PageHeader.jsx`, `EmptyState.jsx`, `StatusBadge.jsx`,
`Money.jsx`) keep older pages working. Delete each when nothing imports it.
