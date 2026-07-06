# UX Interaction Patterns for Claude Code

A reference for behaviors and interaction patterns the user expects in a well-built web app. Not about colors, fonts, or layout. About what an interface should *do*.

Use this as a checklist when building or reviewing any feature. If a feature touches one of these patterns and doesn't implement it correctly, fix it.

---

## 1. Feedback for every action

**Core rule:** Every user action must produce visible feedback within 100ms. If the action takes longer than 100ms to complete, show progress.

### Loading indicators

Pick the right type based on duration:

- **Under 1 second:** No indicator needed. A spinner that flashes for 200ms looks broken.
- **1 to 4 seconds:** Inline spinner next to the button, or a subtle pulse on the affected area.
- **4 to 10 seconds:** Spinner with a label ("Loading...", "Saving your changes...").
- **Over 10 seconds:** Progress bar with a percentage or step count ("Step 2 of 5"). If the duration is unpredictable, show what's happening ("Uploading file 3 of 12").
- **Over 30 seconds:** Let the user keep working on other things, and notify when complete.

**Skeleton screens beat spinners for content loads.** When loading a list, table, or card grid, show gray placeholder shapes matching the final layout. It feels faster and tells the user what's coming.

### Saving indicators

Three states, always visible:

1. **Idle:** "Saved" or no indicator at all.
2. **Saving:** "Saving..." with a subtle spinner.
3. **Saved:** "Saved" with a checkmark or timestamp ("Saved 2s ago"). Auto-dismiss the checkmark after 2 to 3 seconds.

**Autosave:** Save on blur (when the user clicks away from a field) or after 1 to 2 seconds of inactivity. Never save on every keystroke (it floods the server).

**Manual save:** Show a clearly different state for unsaved changes (a dot on the save button, "Unsaved changes" text, or a colored border).

### Button states during actions

When a button triggers an async action:

- Disable it immediately to prevent double-clicks
- Replace the label with a spinner, or add a spinner before the label
- Keep the button width fixed so the layout doesn't jump
- Re-enable when the action completes (success or failure)

Example pattern for a "Save" button:
- Default: "Save"
- Clicked: Disabled, shows spinner + "Saving..."
- Success: Brief "Saved ✓" state for 1.5 seconds, then back to "Save"
- Failure: "Save" with error message below

### Empty states

A blank screen is a bug. Every list, table, or content area needs an empty state:

- Explain what should be there
- Tell the user how to add the first item
- Provide a button to do it (the primary call to action)

Bad: An empty page that just says "No items."
Good: "You haven't added any flashcards yet. Create your first deck to start studying." (with a "Create deck" button)

### Error states

- Show errors near the thing that failed, not in a global banner if you can avoid it
- Explain what went wrong in plain language
- Tell the user what to do next ("Check your connection and try again")
- Provide a retry action when possible
- Never blame the user ("Invalid input" is bad, "Email needs an @ sign" is good)

### Success confirmations

- Inline confirmations for small actions (checkmark next to a saved field)
- Toast notifications for completed actions that move the user elsewhere ("Deck created" toast after redirecting to the deck list)
- Modals only for destructive or irreversible actions
- Auto-dismiss toasts after 4 to 5 seconds, but let the user dismiss them sooner

---

## 2. Buttons and controls

### Disabled vs hidden

- **Disable** a control when the action exists but isn't currently available (form incomplete, no items selected). Show a tooltip explaining why on hover.
- **Hide** a control when the action doesn't apply at all (admin actions for non-admins).

Never disable without explaining why. A grayed-out button with no explanation is hostile.

### Click targets

- Minimum 44x44 pixels for touch, 32x32 for mouse-only desktop interfaces
- Pad the clickable area beyond the visible button when possible (the whole row is clickable, not just the icon)

### Confirmation for destructive actions

- **Reversible delete:** No confirmation. Show an "Undo" toast for 5 to 10 seconds.
- **Irreversible delete:** Modal confirmation. Require typing the item name for high-stakes deletions (deleting a whole project, account, etc.).
- **Bulk destructive actions:** Always confirm. Show the count ("Delete 47 items?").

### Multi-step actions

Show progress. "Step 2 of 4" or a stepper bar. Let the user go back to previous steps without losing data.

---

## 3. Forms

### Validation timing

- **On submit:** For simple forms, only validate when the user clicks submit
- **On blur:** Validate a field after the user leaves it (best default for most forms)
- **As you type:** Only for things like password strength meters or username availability. Never show "this is invalid" while the user is still typing it.

### Inline errors

- Show the error directly below the field
- Use a red icon or border on the field itself
- Keep the error message specific ("Password must be 8+ characters" not "Invalid password")
- Clear the error as soon as the user starts fixing it

### Required vs optional

- Mark required fields explicitly (asterisk or "Required" label)
- Or mark optional fields ("Optional" label) if most fields are required
- Pick one approach and stick with it

### Smart defaults

- Pre-fill anything you reasonably can (today's date, the user's name, the last-used option)
- Use the right input type (email keyboard for email, number pad for numbers, date picker for dates)
- Auto-focus the first field when a form opens
- Submit on Enter from any field

### Keep data on errors

If a form fails to submit, never clear the fields. The user shouldn't have to re-enter anything.

---

## 4. Navigation and menus

### Menu organization

- **Top nav:** 5 to 7 items max. More than that, group them or move to a side nav.
- **Side nav:** Acceptable to have 10 to 15 items if grouped into sections.
- **Hamburger menus on desktop:** Avoid. Discoverability drops sharply.
- **Hamburger on mobile:** Fine, but include a label ("Menu") next to the icon.

### Menu hierarchy

- Group related items with section headers
- Put the most-used items at the top
- Put settings, profile, and logout at the bottom or in a separate user menu
- Limit nesting to 2 levels max. Three-level menus are unusable.

### Active states

The user should always know where they are:

- Current page highlighted in the nav (bold, colored, or with a marker bar)
- Breadcrumbs for any page more than 2 levels deep
- Page title in the browser tab matches the page

### Keyboard navigation

- Tab through every interactive element in logical order
- Visible focus indicators (do not remove the focus ring without replacing it)
- Escape closes modals, dropdowns, and menus
- Enter activates the focused button
- Arrow keys navigate within menus and lists

---

## 5. Drag and drop

### Make it discoverable

Drag handles should be visible. A subtle grip icon (`⋮⋮` or similar) on hover tells users "this is draggable." Don't make the whole row draggable without a handle, it conflicts with selection and clicking.

### During the drag

- The dragged item should follow the cursor with slight offset
- Show a placeholder where the item will land (a dashed outline or highlighted gap)
- Dim the original location slightly so the user sees it left there
- Auto-scroll when the user drags near the top or bottom edge of a scrollable area

### Drop zones

- Highlight valid drop zones when a drag starts
- Show a clear visual change when hovering over a valid drop zone
- Show an explicit "cannot drop here" state for invalid zones (red border, cursor change)

### After the drop

- Animate the item into its new position (200 to 300ms)
- Show a brief confirmation if the action saved (subtle flash, "Saved" indicator)
- Always provide an undo path. Drag-and-drop reorders are easy to do by accident.

### Alternatives

Never make drag-and-drop the only way to do something. Always provide:

- Keyboard shortcuts (arrow keys to move items)
- A right-click menu or a "..." menu with "Move up / Move down"
- Touch-friendly equivalents for mobile

---

## 6. Modals and dialogs

### When to use modals

- Confirming destructive actions
- Quick forms that don't deserve their own page
- Critical alerts the user must address before continuing

### When NOT to use modals

- Long forms (use a dedicated page)
- Information the user might want to reference while working (use a panel or drawer)
- Anything that interrupts a flow without good reason

### Modal behavior

- Trap focus inside the modal while open (Tab cycles within the modal, doesn't escape)
- Escape key closes (unless the modal is critical and requires explicit action)
- Click outside to dismiss (for non-critical modals only)
- Return focus to the triggering element when closed
- Don't stack modals. One at a time.

---

## 7. Tables and lists

### Sorting

- Click column header to sort
- Show the sort direction (up/down arrow on the active column)
- Remember the sort order across page reloads (URL params or local storage)

### Filtering

- Filters should preview the filtered count before applying ("Show 47 of 312")
- Show active filters as removable chips above the results
- Provide a "Clear all filters" button when filters are active

### Pagination vs infinite scroll

- **Pagination:** Better for data the user needs to find or reference. Show total count and page numbers.
- **Infinite scroll:** Better for feeds and discovery. Always show a footer or "load more" button as well, so users can reach footer content.
- **Hybrid:** Load more on scroll, but show "Showing 50 of 1,247" so users know the scope.

### Selection

- Checkbox in the leftmost column for multi-select
- "Select all" checkbox in the header
- Show selected count when items are selected ("3 items selected")
- Bulk action bar appears when items are selected, disappears when none are
- Shift-click to select a range

### Row actions

- Primary action on click (open, view)
- Secondary actions in a "..." menu at the end of the row
- Don't have more than 4 to 5 inline action buttons per row, it's visually noisy

---

## 8. Search

### Search behavior

- Search as you type (debounced 200 to 300ms) for instant feel
- Show a clear button (X) inside the search input when there's text
- Press Escape to clear and exit the search
- Show "Searching..." for slow searches
- Show clear "No results" state with suggestions

### Search results

- Highlight the matching text in results
- Show the most relevant results first, not alphabetical
- Group results by type if you have multiple types ("Decks", "Cards", "Notes")
- Show a count ("12 results")

---

## 9. Undo and recovery

**The single most important UX principle for confident users:** make actions reversible.

- Provide undo for any destructive action via a toast for 5 to 10 seconds
- Ctrl+Z / Cmd+Z should undo the most recent action
- Soft-delete by default. Items go to a trash/archive that's recoverable for 30 days.
- Autosave version history for documents and long-form content

---

## 10. Performance perception

These don't make the app faster, they make it *feel* faster:

- **Optimistic UI:** Show the result immediately, then reconcile with the server. If the server rejects, roll back with a clear error.
- **Skeleton screens:** Better than spinners for content loads.
- **Lazy loading:** Load images and heavy content only as they come into view.
- **Instant feedback:** Even if the action takes 2 seconds, the click should produce visible feedback in under 100ms.
- **Preload likely next actions:** When the user hovers a link for 100ms, start fetching the page.

---

## 11. Mobile and responsive

### Touch targets
- Minimum 44x44 pixels
- 8 pixels of space between adjacent tappable elements

### Mobile-specific patterns
- Bottom nav for primary navigation (thumbs reach the bottom easier)
- Pull-to-refresh on scrollable lists
- Swipe actions on list items (swipe left to delete, etc.) with visible alternatives
- Avoid hover-dependent UX (no information that only appears on hover)

### Responsive breakpoints
- Mobile: under 640px
- Tablet: 640 to 1024px
- Desktop: over 1024px

Test every feature at every breakpoint. Things that work great on desktop break on mobile constantly.

---

## 12. Accessibility basics

Not optional. Affects usability for everyone.

- Every interactive element reachable by keyboard
- Visible focus indicators (never `outline: none` without replacement)
- Color is never the only way to convey meaning (use icons or text alongside red/green)
- All images have alt text (decorative images get `alt=""`)
- Form fields have associated labels (not just placeholders)
- Sufficient contrast for text (WCAG AA: 4.5:1 for normal text, 3:1 for large)
- ARIA labels for icon-only buttons ("Close", "Menu", "Delete")
- Live regions announce dynamic updates to screen readers

---

## 13. App-specific patterns

### Study app for children

- **Large, friendly controls.** 60x60 pixel minimum touch targets.
- **Immediate feedback.** Correct answer plays a sound, shows a checkmark, slight animation. Wrong answer is gentle, never punishing.
- **No dead ends.** Always show a way forward, never a blank screen.
- **Progress visible.** Show how far along they are ("5 of 12 cards"). Show streaks and milestones.
- **No accidental destructive actions.** Hide or strongly confirm deletes, account changes, and settings.
- **Forgiving inputs.** Accept lowercase for proper nouns, ignore trailing spaces, allow close-enough spelling on free-text answers.
- **Minimal text.** Use icons, illustrations, and short labels.

### Work app for daily use

- **Keyboard shortcuts for everything.** Power users live on the keyboard. Show shortcuts in tooltips and a help menu.
- **Command palette (Cmd+K).** Search and trigger any action from anywhere.
- **Bulk actions.** Select multiple items, act on them all.
- **Saved views and filters.** Don't make users re-configure the same view every day.
- **Quick-add from anywhere.** A global "+" or "N" shortcut to create a new item without leaving the current page.
- **Notifications without interruption.** A badge or unread count, not modal alerts.
- **Multi-tab friendly.** State syncs across tabs, or at least doesn't conflict.
- **Density toggle.** Some users want spacious, some want compact. Let them choose.

---

## Next actions for Claude Code

When building or reviewing a feature, work through this checklist:

1. Does every action under 1 second feel instant?
2. Does every action over 1 second show progress?
3. Is every button's loading and disabled state explicit?
4. Is every destructive action reversible or confirmed?
5. Is every empty state helpful, not blank?
6. Does every error explain what to do next?
7. Can a keyboard user reach and use everything?
8. Does it work on a 375px-wide phone?
9. Are forms forgiving of mistakes and easy to recover from?
10. Is there always an undo, or a way back?

If any answer is "no," fix it before considering the feature done.
