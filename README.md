# R Hidden Preview

R Hidden Preview is a VS Code extension MVP that automatically runs selected R code in a hidden background process and shows immediate preview results.

When you select code in an `.R` file, the extension can:
- execute in background with `Rscript --vanilla`
- show a one-line inline summary at end-of-line
- show detailed result in a dedicated preview panel
- render plot output image in preview panel when plotting occurs

This project is designed as a stable, maintainable first version suitable for Marketplace publishing and future iteration.

## Core Features

- Only active on R files.
- Automatic trigger on selection change (no manual Run click required).
- Hidden asynchronous execution using `child_process.spawn()`.
- Long-lived R session runtime (single persistent R process for repeated previews).
- Two-layer result UI:
  - Inline summary (`TextEditorDecorationType`)
  - Detailed panel (`WebviewPanel`)
- Plot preview support:
  - Captures generated plot output as PNG
  - Renders image in Webview detail panel
- data.frame preview support:
  - Renders data.frame result as HTML table in the detail panel
  - Scrollable table container for larger result sets
  - Client-side pagination and per-column sorting
  - Tibble-friendly headers with column type info
- Missing package assistance:
  - Detects common "package not installed" errors
  - Prompts one-click `install.packages(...)`
- Result cache:
  - Reuses preview result for identical `hash(code + context)`
  - Avoids duplicate execution for same expression/context
- Execution de-duplication:
  - During drag-selection bursts, repeated identical requests are skipped
  - Only the final distinct request is executed
- Optional hover preview mode:
  - Show quick preview on mouse hover (IntelliSense-like)
  - Uses the same safe rule and cache pipeline
- Safety rule engine for auto execution:
  - Auto-run only for simple safe expressions
  - Skip dangerous IO/system/package-management calls
- Handles failure states with explicit feedback:
  - Rscript launch failure
  - execution error
  - timeout (`预览超时`)
- Debounce to avoid excessive execution while adjusting selection.
- Cancels previous unfinished preview task when new selection arrives.
- Output truncation to keep UI responsive.
- Configurable behavior via settings.

## How It Works

1. Listen to editor selection changes.
2. Verify active editor language is R.
3. Run lightweight selection completeness checks before execution.
4. Build execution code based on context mode:
   - `selectionOnly`
   - `documentBeforeSelection` (default)
5. Create temporary files:
   - payload R code
   - runner R script wrapper
6. Spawn hidden process:
   - `Rscript --vanilla <runner.R> <payload.R> <maxOutputLength>`
7. Parse structured stdout markers into `PreviewResult`.
8. Update inline summary and panel detail.
9. Clean up temporary files and process resources.

## Execution Context Modes

### `selectionOnly`
Only executes currently selected code.

### `documentBeforeSelection` (default)
Executes code from start of document to selection start, then selected code.

Important:
- This mode may execute additional code and can cause side effects.
- Side effects depend on your selected script content.

## Safety and Side Effects

This extension executes R code in the background.

Please read carefully:
- Selected code is executed automatically when selection changes.
- In `documentBeforeSelection` mode, code before selection is also executed.
- Any executed code may have side effects (file operations, network calls, state mutation, etc.).

Recommended practices:
- Use trusted workspaces.
- Keep `requireWorkspaceTrust` enabled for safer default behavior.
- Use `selectionOnly` for stricter execution boundaries.

## Requirements

- VS Code 1.90.0 or newer
- R installed on your machine
- `Rscript` available in PATH or configured with full path in `rHiddenPreview.rscriptPath`

## Usage

1. Open an `.R` file.
2. Select code with mouse or keyboard.
3. Wait for debounce delay (default 350ms).
4. See inline summary at selected line end.
5. Open detailed panel via command:
   - `R Hidden Preview: Open Preview Panel`

## Safe Auto-Execution Rules

Auto preview now runs only when selected code passes `isSafeExpression(code)`.

Default blocked function calls:

- `read.csv(...)`
- `read.table(...)`
- `read.delim(...)`
- `write.csv(...)`
- `write.table(...)`
- `install.packages(...)`
- `system(...)`
- `system2(...)`
- `shell(...)`
- `source(...)`
- `download.file(...)`
- `unlink(...)`
- `file.remove(...)`
- `file.copy(...)`
- `save(...)`
- `saveRDS(...)`
- `load(...)`
- `setwd(...)`

Rule configuration:

- blacklist: `rHiddenPreview.safeFunctionBlacklist`
- whitelist: `rHiddenPreview.safeFunctionWhitelist`

Whitelist behavior:

- empty whitelist (default): allow all function calls except blacklist
- non-empty whitelist: only allow listed function calls (blacklist still takes precedence)

Examples that are auto-executed:

```r
1 + 2
mean(x)
sum(c(1,2,3))
```

Examples that are skipped:

```r
read.csv("data.csv")
write.csv(df, "out.csv")
install.packages("ggplot2")
system("dir")
```

If an expression is skipped, the extension writes a `SKIP Unsafe expression` entry to the output channel.

## Screenshots

Add screenshots before Marketplace publishing to improve trust and clarity:

- `docs/screenshots/inline-summary.png` (inline end-of-line summary)
- `docs/screenshots/panel-text-result.png` (detail panel text output)
- `docs/screenshots/panel-plot-result.png` (detail panel plot image preview)

Suggested capture size:
- width >= 1280px
- clear light/dark theme contrast
- avoid personal paths or sensitive data in editor tabs

## Settings

All settings are under `rHiddenPreview`:

- `rscriptPath` (string, default: `Rscript`)
  - Path to Rscript executable.
- `timeoutMs` (number, default: 3000)
  - Timeout for each preview execution.
- `debounceMs` (number, default: 350)
  - Debounce delay before triggering preview.
- `autoPreview` (boolean, default: true)
  - Enable automatic preview on selection changes.
- `enableHoverPreview` (boolean, default: false)
  - Enable optional hover-based quick preview.
- `safeAutoExecutionOnly` (boolean, default: true)
  - If enabled, only auto-run code passing `isSafeExpression(code)`. Disable this to allow auto-preview for all complete selections.
- `safeFunctionBlacklist` (string[], default: built-in dangerous function list)
  - Function names blocked by safety rule engine (case-insensitive).
- `safeFunctionWhitelist` (string[], default: `[]`)
  - Optional allowed function names. If non-empty, only listed functions are auto-executed.
- `contextMode` (enum, default: `documentBeforeSelection`)
  - `selectionOnly` or `documentBeforeSelection`.
- `maxOutputLength` (number, default: 2000)
  - Maximum output length before truncation.
- `showInlinePreview` (boolean, default: true)
  - Show inline end-of-line summary.
- `showPanelPreview` (boolean, default: true)
  - Show detailed panel preview.
- `requireWorkspaceTrust` (boolean, default: true)
  - Only auto-preview in trusted workspace.
- `ignoreIncompleteSelection` (boolean, default: true)
  - Skip incomplete-looking selection instead of showing immediate error.

## Input Completeness Checks (MVP)

Before execution, this MVP checks:
- empty selection
- blank selection
- comment-only selection
- basic bracket balance
- obvious unclosed quotes
- simple incomplete-expression heuristics

Note:
- This is not a full R parser.
- Heuristics may occasionally be conservative.

## Result Model

Current result model:

```ts
type PreviewResult =
  | { kind: "text"; summary: string; detail?: string; plotPngBase64?: string }
  | { kind: "error"; summary: string; detail?: string; plotPngBase64?: string };
```

Design intent:
- `summary` is used by inline preview.
- `detail` is used by preview panel.
- `plotPngBase64` is used by Webview panel to render plot image previews.

## Project Structure

```text
src/
  extension.ts
  types.ts
  runner/
    rRunner.ts
    scriptBuilder.ts
    resultParser.ts
  ui/
    decorations.ts
    previewPanel.ts
  util/
    config.ts
    debounce.ts
    rscriptResolver.ts
    selectionGuard.ts
    tempFiles.ts
package.json
tsconfig.json
README.md
```

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Compile:

```bash
npm run compile
```

3. Press `F5` in VS Code to launch Extension Development Host.

4. In the host window, open an `.R` file and select R code to test behavior.

## Packaging and Publishing

1. Install VS Code extension packaging tool:

```bash
npm install -g @vscode/vsce
```

2. Package extension:

```bash
vsce package
```

3. Publish to Marketplace (after setting publisher metadata and PAT):

```bash
vsce publish
```

Before publishing:
- set proper icon, repository, and changelog as needed
- test on Windows/macOS/Linux with real R environments
- add screenshots under `docs/screenshots/` and reference them in README

## Known Limitations (MVP)

- No persistent R session yet (each preview runs isolated process).
- No table/grid renderer yet for data frames.
- No cache/reuse for repeated selections.
- Completeness check is heuristic, not a full parser.

## Future Extensions

Planned extension points are already prepared in architecture:
- data.frame/tibble rich table rendering
- long-lived R session mode
- language server or hybrid architecture
- cross-file context execution strategy
- result cache and deduplication

## Missing Package Install Prompt

When execution fails because a package is missing, the extension will:
- detect common missing-package error messages
- prompt you to install detected package(s)
- run `install.packages(...)` through `Rscript --vanilla -e`

Notes:
- package installation requires network access and write permission to your R library paths
- installation logs are printed to `R Hidden Preview` output channel

## Troubleshooting

### Rscript not found

- The extension first tries configured rHiddenPreview.rscriptPath.
- On Windows, if value is default Rscript and PATH lookup fails, it will auto-scan common install locations under Program Files.
- If still not found, set full executable path manually in rHiddenPreview.rscriptPath.
- Example on Windows:
  - `C:\Program Files\R\R-4.4.1\bin\Rscript.exe`

### Frequent timeout

- Increase `rHiddenPreview.timeoutMs`.
- Reduce selected code scope.

### No output shown

- Check `showInlinePreview` and `showPanelPreview` settings.
- Ensure `autoPreview` is enabled.
- If workspace is untrusted and `requireWorkspaceTrust` is true, preview is blocked.

## License

MIT
