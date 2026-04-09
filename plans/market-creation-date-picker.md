# Market Creation — Replace Native datetime-local with Popup Date + Time Picker

## Problem

`BasicInfo` step of the `/creator/new` wizard uses a raw `<input type="datetime-local">`
for the **End Time** field (`bitCaster-app/src/components/market-creation/BasicInfo.tsx:127-136`).

Issues:

- Native rendering differs per browser — Chrome shows tiny inline spinners, Firefox shows
  a different widget, Safari yet another. Desktop UX is awkward.
- The widget ignores the app's dark slate theme, looking out-of-place next to the other
  Tailwind-styled inputs in the wizard.
- No month-grid view — users pick dates field-by-field, which is slow for dates several
  months out (markets typically close weeks/months in the future).

The user wants a "more common date picker UI": a clickable field that opens a popup
calendar with a month grid plus a time selector.

## Goals

1. Replace the native input with a styled popup picker that matches the wizard's
   dark theme (slate-900 background, blue-500 accents).
2. Keep the wired data format untouched — the wizard state continues to store
   `closingDate` as a `YYYY-MM-DDTHH:mm` local-time string so that persisted drafts,
   `ReviewAndCreate`, and all downstream code keep working without migration.
3. Preserve validation: reject dates in the past, keep the Next button disabled until
   a valid future datetime is chosen.
4. Maintain keyboard accessibility (tab focus, Enter/Space to open, arrow keys to
   navigate the month, Escape to close).

## Non-goals

- No change to the wizard data model, state hook, or any other step.
- No change to the backend contract or the `closingDate` field in `WizardStepBasicInfo`.
- No timezone handling beyond what exists today — the value remains a naive local
  datetime string. Timezone awareness can be a separate follow-up.
- No reusable design-system rollout beyond this one field (the picker is built to be
  reusable, but only wired into `BasicInfo` in this change).

## Library choice — `react-day-picker`

**Pick:** `react-day-picker` (~`/gpbl/react-day-picker`)

Reasons:

- Headless calendar component, styleable with Tailwind via `classNames` prop plus
  `getDefaultClassNames()` helper — integrates cleanly with the existing dark theme
  with no global CSS wrestling.
- Accessible out of the box (keyboard nav, ARIA roles).
- Built-in `disabled={{ before: new Date() }}` matcher cleanly enforces the
  "no past dates" rule we already enforce.
- Single popular dependency with React 19 support, ~35 KB gzipped. Used widely
  (shadcn/ui's Calendar wraps it).
- Calendar-only — we pair it with a small `<input type="time">` (or a lightweight
  custom hour/minute section) for the time portion, which keeps the scope narrow.

Alternatives considered and rejected:

- **`react-datepicker`** — larger bundle, harder to style with Tailwind, legacy API.
- **`rc-picker`** — powerful but heavier and targeted at antd-style systems.
- **Hand-rolled calendar** — correctness and a11y work would dwarf the rest of this task.
- **Keep `datetime-local`, only restyle** — can't meaningfully restyle the popover
  portion of native datetime pickers; the core UX issue is unsolvable without a
  custom widget.

Install:

```bash
cd bitCaster-app && npm install react-day-picker
```

(No peer-dep issues expected with React 19 — current `react-day-picker` supports it.)

## Component design — `DateTimePicker`

Location: `bitCaster-app/src/components/ui/DateTimePicker.tsx` (new; creates `ui/` dir).

Reusable, uncontrolled-from-parent / controlled-by-prop component, dark-theme only
(matches the rest of the app).

```tsx
interface DateTimePickerProps {
  /** Current value as YYYY-MM-DDTHH:mm local string, or '' when unset. */
  value: string
  /** Called with a new YYYY-MM-DDTHH:mm local string when user picks. */
  onChange: (value: string) => void
  /** Lower bound (inclusive). Defaults to now. */
  min?: Date
  /** Placeholder text when no value is selected. */
  placeholder?: string
  /** Optional id for the trigger button (labelling). */
  id?: string
  /** Optional aria-label if no visible label is associated. */
  'aria-label'?: string
}
```

Visual structure:

1. **Trigger button** — styled to match other inputs (`rounded-lg bg-slate-900
   border border-slate-700 text-white text-sm px-4 py-3`), displays the currently
   selected date formatted with `toLocaleString(undefined, { dateStyle: 'medium',
   timeStyle: 'short' })`, or the placeholder. Calendar icon (from `lucide-react`)
   on the right.
2. **Popover** — absolutely positioned below the trigger, appears on click / Enter /
   Space. Closes on outside click, Escape, or after the user confirms.
   - On narrow viewports (`sm:` breakpoint), render as a bottom sheet / centered
     modal instead, for thumb-friendly mobile UX.
3. **Calendar** — `<DayPicker mode="single" selected={date} onSelect={...}
   disabled={{ before: min }} classNames={...}>`.
   Tailwind `classNames` override the defaults for: `root`, `day_button`, `selected`,
   `today`, `chevron`, `caption_label`, `month_grid` to match slate/blue theme.
4. **Time section** — below the calendar, a `<input type="time">` bound to the
   hour/minute portion of the value. Native time input is much less visually broken
   than `datetime-local`, and gives native mobile wheel pickers for free. If that
   proves insufficient, fall back to two number inputs (00-23 / 00-59).
5. **Footer** — "Cancel" (discards) and "Apply" (commits and closes) buttons.
   Committing writes back to `onChange` as a single `YYYY-MM-DDTHH:mm` string
   assembled from selected date + time.

String <-> Date conversion:

- Parse: `value` is parsed as local time via `new Date(value)` when non-empty;
  otherwise internal date state is `undefined`.
- Format: assemble `YYYY-MM-DD` from the `Date` via
  `date.getFullYear()/getMonth()+1/getDate()` (zero-padded) and append the `HH:mm`
  from the time input. Do **not** use `toISOString()` — that converts to UTC and
  would shift the day on non-UTC clients.

Accessibility:

- Trigger button has `aria-haspopup="dialog"`, `aria-expanded={open}`.
- Popover has `role="dialog"`, `aria-modal="false"` (non-modal), `aria-label="Pick
  end date and time"`.
- Focus trap within the popover while open; return focus to the trigger on close.
- Escape closes; Tab cycles through calendar → time → Cancel → Apply.
- DayPicker handles arrow-key grid navigation on its own.

## Files to change

### New

- `bitCaster-app/src/components/ui/DateTimePicker.tsx` — the component described above.
- `bitCaster-app/src/components/ui/__tests__/DateTimePicker.test.tsx` — unit tests
  (see Testing section).

### Modified

- `bitCaster-app/package.json` — add `react-day-picker` dependency.
- `bitCaster-app/src/components/market-creation/BasicInfo.tsx`
  - Remove the `minDateTime` string and the `<input type="datetime-local">`.
  - Import and render `<DateTimePicker value={data.closingDate}
    onChange={onClosingDateChange} min={new Date()} placeholder="Select date & time"
    aria-label="End Time" />`.
  - Keep the surrounding label + helper text unchanged.
  - `canProceed` logic (`data.closingDate.length > 0 && new Date(data.closingDate) >
    new Date()`) stays identical, since the data format is unchanged.
- `bitCaster-app/src/components/market-creation/__tests__/BasicInfo.test.tsx`
  - The test at line 61-66 (`renders datetime input with min attribute`) currently
    asserts presence of the native `input[type="datetime-local"]`. Replace with a
    test that finds the trigger by its accessible name ("End Time") via
    `screen.getByRole('button', { name: /end time/i })` and verifies it's rendered.
    The min enforcement is now covered in the `DateTimePicker` unit tests.
  - Other tests in this file operate on title / Next button and don't need changes.
- `tests/E2E/MarketCreationTests.cs`
  - Lines 91 and 168 use `page.Locator("input[type='datetime-local']")`. Update to
    drive the popup picker via accessibility locators instead:
    - Open: `page.GetByRole(AriaRole.Button, new() { Name = "End Time" }).ClickAsync()`.
    - Navigate the calendar with DayPicker's a11y — e.g. click the month's
      next-chevron `GetByRole(AriaRole.Button, new() { Name = "Go to next month" })`
      N times until reaching the target month (1 year out in the existing test).
    - Click the day cell: `page.GetByRole(AriaRole.Gridcell, new() { Name = "15" })`
      or similar based on the rendered accessible name (DayPicker labels cells with
      the full date like "April 9th, 2026").
    - Fill the time input: `page.Locator("input[type='time']").FillAsync("12:00")`.
    - Click Apply to commit.
  - The "past date" test (`WizardStep3_FutureDateRequired_NextDisabledForPastDate`,
    line 157) needs restructuring: past-day cells will be disabled so clicking them
    is a no-op. Instead, assert that (a) the trigger shows placeholder after
    opening and navigating to a past month and (b) clicking yesterday's disabled cell
    does not enable Next. Alternatively, split into two tests: one for the disabled
    past state (asserts disabled cell) and one for the happy-path future date.

## Build order

1. **Install** `react-day-picker` and confirm `npm run typecheck` still passes on
   `main` with the unchanged `BasicInfo`.
2. **Author** `DateTimePicker.tsx` with its unit tests. Land as an unused component
   first so the picker is verifiable in isolation before touching the wizard.
3. **Swap** the input inside `BasicInfo.tsx`. Update `BasicInfo.test.tsx`. Run
   `npm run test` until green.
4. **Manual check** — `npm run dev`, walk to step 3 of the wizard, open/close the
   picker, pick a date, verify Next enables and the Review step shows the same
   value as before.
5. **Update E2E** — rewrite the two `MarketCreationTests.cs` sites. Run the full
   E2E suite per the Branch Completion Workflow in `bitCaster/AGENTS.md`.
6. **`/simplify`** pass, then draft PR per the workflow.

## Testing plan

### Unit tests — `DateTimePicker.test.tsx` (new)

Cover at minimum:

1. Renders trigger button with placeholder when `value=''`.
2. Renders trigger button showing formatted datetime when `value` is set.
3. Click opens popover; Escape closes popover; click outside closes popover.
4. Selecting a future date + time + clicking Apply calls `onChange` with the
   expected `YYYY-MM-DDTHH:mm` string (string-equality assertion, no Date parsing).
5. `min` defaults to now — dates before today are rendered with the DayPicker
   disabled attribute and clicking them does not fire `onChange`.
6. Explicit `min={someDate}` disables days before that date.
7. String <-> Date round-trip: pass `value="2026-12-31T23:45"`, assert the calendar
   highlights Dec 31 2026 and the time input reads `23:45`.
8. Cancel button closes the popover **without** firing `onChange`.

### Unit tests — `BasicInfo.test.tsx` (modified)

- Update the `renders datetime input with min attribute` test as noted above.
- Add: when the user clicks the trigger and picks a future date, `onClosingDateChange`
  is called with a string. Can be a light smoke test — the depth-of-coverage lives
  in `DateTimePicker.test.tsx`.

### E2E — `MarketCreationTests.cs` (modified)

- `NavigateToStep` helper (line 80+) must use the new picker flow to advance past
  step 3. Extract a small `FillClosingDate(IPage page, DateTime target)` helper to
  avoid duplicating the popup open/navigate/apply sequence.
- `WizardStep3_FutureDateRequired_NextDisabledForPastDate` — rework to verify both
  the disabled-past state and the future-enables-Next transition via the new picker.

### Manual checks

- Dark theme fidelity — verify the popup inherits slate-900/border-slate-700 and
  blue accents. No white flashes.
- Mobile — use DevTools device emulation; verify the popover doesn't overflow the
  viewport and the time input invokes the native wheel picker on touch.
- Keyboard-only — tab into the trigger, Enter opens, arrow keys move the day grid,
  Enter selects, Escape closes.

## Risks & open questions

1. **Time input styling** — `<input type="time">` is slightly less ugly than
   `datetime-local` but still has minor cross-browser differences. If the result
   still looks out of place, fall back to two zero-padded number inputs inside
   the popover footer. Decision can be deferred to the implementation PR.
2. **Popover positioning** — no existing app-wide popover primitive. For a single
   usage we can get away with a simple absolutely-positioned `<div>`. If a second
   consumer appears we should promote to Radix Popover or similar; flag this in the
   PR description but don't preemptively introduce the dependency.
3. **`date-fns` vs. plain `Date`** — `react-day-picker` internally uses `date-fns`,
   which will be installed transitively. We don't need to use it ourselves;
   plain `Date` arithmetic is enough for the tiny parse/format helpers this picker
   needs.
4. **Bundle size** — react-day-picker + transitive date-fns adds ~40 KB gzipped.
   Acceptable for a feature that the user specifically asked for and that lives
   inside the creator flow (lazy-loadable later if needed).
5. **Locale/first-day-of-week** — leave at DayPicker default (locale-driven) unless
   the user wants a specific locale pinned. Note in PR body.
