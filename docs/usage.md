# Using Enrichable

For installation, see the [README](../README.md#self-host-in-5-minutes).

## How a sheet works

1. **Find rows.** "Every residential solar installer in the United States." Pick companies, people or websites and a target count. An OpenAI agent plans the queries, pages through Context.dev company/people/web search, and streams de-duplicated rows into the sheet. The model only sees counts and cursors, never the records, so a 1,000-row list costs a few thousand tokens of orchestration.
2. **Add an AI column.** Type what you want to know. Enrichable composes the right operation (or configure it by hand). Reference other columns as `{{Website}}`.
3. **Run.** Cells run in parallel with a configurable concurrency, retry on rate limits, and wait for the columns they reference. Every cell keeps its sources, probability or confidence, reasoning, credits and timing. Click a cell to see them, edit the value, or re-run it.
4. **Filter, sort, export.** Filters per column (contains, is true, greater than, is empty, has an error…), sorting, search, row selection, CSV (with or without confidence and sources), Excel and JSON. Filters and sort are yours: they are kept in this browser for your account and never change what teammates see or export. Exports follow your current view.

Opening a shared sheet preserves work running in other tabs. Browser enrichment requests stop after 5½ minutes. While a sheet is open, saved running cells older than 10 minutes by the server's clock with no active task in this tab become retryable errors; recent runs in other tabs are preserved. A cell another tab or an agent is running is never run twice: runs here wait for its result. Reloading a tab lets it restart the cells it left running (a duplicated tab is a new tab); a cell finished elsewhere while queued here is not run again; cells a closed tab left running become retryable after those 10 minutes. Stopping a run saves the canceled cell statuses to the shared sheet.

Completed enrichments show a persistent refresh icon when their inputs or instructions have changed. Click it to rerun the cell; the previous value stays visible until the refresh starts, and stays if the rerun fails. Editing an AI column's instructions keeps its values and makes them outdated. **Run unfinished cells** never reruns a finished cell, outdated or not; the Run menu offers **Re-run outdated cells** with their count, which asks first for large or costly runs like any other. Newly completed results retain an input fingerprint across reloads. Older results use referenced-cell timestamps until their next run.

### Undo and redo

Each sheet keeps its last 50 actions for the current browser session. Use **⌘/Ctrl+Z** to undo and **⌘/Ctrl+Shift+Z** (or **Ctrl+Y**) to redo, or use the toolbar buttons. History covers cell edits, bulk clears, imports, and row and column changes; filters and sort are not undo steps. A new edit clears redo history. History survives navigation between sheets and clears on reload.

While typing in an editor, the shortcuts undo text edits. Background enrichment and streamed row discovery do not create undo steps; undo preserves unrelated results and recalculates formulas.

### Column operations

**Add → AI column** opens one composer: describe what you want and Enrichable picks the operation, or choose one yourself from six groups.

| Group | Operations | Services |
| --- | --- | --- |
| AI answer | **Ask AI** answers a question about each row, researching the web when it needs to. **Deep research** returns a sourced answer from many pages. **Email draft** writes a personalized email, or fills a template from columns. | OpenAI + Context.dev |
| Classify | **True / false** returns a yes/no with a calibrated probability (it can read a page first). **Category** picks one of your options. **Score** rates rows on levels you define. | TypeSafe (or OpenAI) + Context.dev |
| Web page | **Read a page** keeps page text, relevant passages, links or extracted fields. **Web search** keeps the top URL, title or snippet. | Context.dev |
| Company & person | Firmographics, funding, links and socials for a company; title, employer, education and profiles for a person. | Context.dev |
| Find email | **Work email** tries your email providers top to bottom and keeps the first work email found. **Verify email** (Hunter) and **Mobile & profile** (Prospeo) are optional. | Your email providers |
| Formula | **Formula** calculates locally with a 10-row preview. **Text template** combines columns. No API calls. | None |

Runs of more than 50 cells, or roughly 100+ credits, ask for confirmation with a cost estimate first.

## Spreadsheet formulas

Select a cell and type a formula in the formula bar, or enter one directly in a source cell. Examples: `=SUM(A1:A10)`, `=A1*B1`, and `=IF(C1>100,"High","Low")`. Column headers show their letters; the first data row is row 1. The formula bar and cell detail panel preserve the expression while the grid displays its result. Prefix an input with an apostrophe to keep it literal, for example `'=SUM(A1:A10)`.

Calculations use [IronCalc](https://github.com/ironcalc/IronCalc) (`@ironcalc/wasm`, MIT OR Apache-2.0) in a browser worker. Formulas and results are saved in Neon Postgres and cached in IndexedDB and recalculate when inputs or enrichment results change. Sorting and filtering are views: addresses continue to refer to the underlying row order, and hidden columns retain their letters. Inserting, moving, or deleting columns and deleting rows update references. CSV, JSON, and Excel exports contain calculated values. Imported and enriched strings are treated as literal data, including strings beginning with `=`.

This integration supports formulas within one sheet. It does not connect separate Enrichable sheets or provide dynamic array spill output. Excel and Google Sheets function compatibility depends on IronCalc's supported functions. Formula calculation makes no API calls and requires no API keys.

### Formula editor assistance

The formula bar and inline cell editor provide function autocomplete, signatures,
argument descriptions and examples from IronCalc's catalog. Help follows the
cursor through nested functions and highlights the current argument. Functions,
strings, numbers, booleans and references have distinct syntax colors; repeated
references keep the same color.

Type a function prefix after `=` to see suggestions. Use the arrow keys to choose
one, then **Tab** or **Enter** to insert it. **Ctrl+Space** opens suggestions
explicitly. **Enter** saves when no completion is selected. **Escape** dismisses
suggestions or argument help first; press it again to cancel the edit. These
features use the existing browser worker and make no AI or documentation API calls.

For browser checks, see the [development guide](development.md#checks). Formula metadata attribution is in the [catalog README](../src/lib/formula-catalog/README.md).

### Selecting cell ranges

Drag across the grid to select a rectangle. Shift-click or Shift+arrow keys extend
it; an ordinary click or arrow key selects a single cell again. Copy transfers the
selected values as a tab-separated table. Delete clears the editable cells in the
selection. Row checkboxes remain separate from cell selection.

While editing a formula, place the cursor inside an argument (for example,
between the parentheses in `=SUM()`) and drag across cells. The editor inserts a
reference such as `A1:B5`, previews it during the drag, and keeps the draft open.
Clicking one cell inserts its address. Picking again replaces the reference under
the cursor; Undo restores the previous expression. Escape during a drag cancels
that pick without discarding the formula. Dragging near the grid edges scrolls
through rows and columns.

References keep the sheet's stable addresses when the display is sorted or
filtered. If the selected cells have nonconsecutive addresses, they are inserted
as comma-separated references, suitable for functions such as SUM and AVERAGE.

## Logos

For self-hosting, enter your optional Logo Link public client ID in Configuration → Connections → Context.dev. Automatic Logo Link connection through Context.dev sign-in is available only on the official hosted service.

## Hunter and Prospeo (optional)

In Configuration → Connections, connect a Hunter or Prospeo API key. On enrichable.io, keys are encrypted server-side and shared across your team's members, devices, and MCP agents. Self-hosted browser workspaces retain local key storage. Private deployments can instead set `HUNTER_API_KEY` and `PROSPEO_API_KEY`, protected by the [deployment password](../README.md#api-keys).

Add an AI column and choose **Find email → Verify email** (Hunter) or **Find email → Mobile & profile** (Prospeo), or describe the lookup in the composer with the provider connected:

- Hunter finds work email from `{{Name}}` + `{{Company website}}`, or verifies `{{Email}}` and returns a status such as `valid`, `invalid`, or `accept_all`.
- Prospeo accepts a LinkedIn URL, email, or full name + company domain and returns email, mobile, name, title, employer, company domain, LinkedIn, or location. Verified email is required by default; turn it off to permit other matched profiles. Selecting mobile enables mobile enrichment and uses your Prospeo quota.

Key validation uses free account endpoints. Enrichments use your own provider quota. Missing matches become empty cells; invalid credentials, exhausted quota, and transient rate limits produce cell errors. Provider usage is shown separately from Context.dev credits. No provider keys are stored with shared sheets.

API references: [Hunter V2](https://hunter.io/api-documentation/v2), [Prospeo Enrich Person](https://prospeo.io/api-docs/enrich-person), [Prospeo account information](https://prospeo.io/api-docs/account-information).
