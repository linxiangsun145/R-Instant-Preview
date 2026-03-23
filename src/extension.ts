import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { RRunner, RunningPreviewTask } from "./runner/rRunner";
import { getConfig } from "./util/config";
import { createDebouncedExecutor } from "./util/debounce";
import { checkSelectionCompleteness, isSafeExpression } from "./util/selectionGuard";
import { InlinePreviewDecorations } from "./ui/decorations";
import { PreviewPanel } from "./ui/previewPanel";
import { PreviewResult } from "./types";
import { resolveRscriptPath } from "./util/rscriptResolver";
import { hashCodeContext } from "./util/hash";

export function activate(context: vscode.ExtensionContext): void {
  const initialConfig = getConfig();
  console.log("[R Hidden Preview] Extension activated. Rscript path:", initialConfig.rscriptPath);

  const runner = new RRunner();
  const decorations = new InlinePreviewDecorations();
  const panel = new PreviewPanel();
	const outputChannel = vscode.window.createOutputChannel("R Hidden Preview");
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = "R Hidden Preview";
	statusItem.command = "rHiddenPreview.showOutput";
	statusItem.text = "R Hidden Preview: Idle";
	statusItem.tooltip = "Click to open R Hidden Preview output channel";
	statusItem.show();
  const recentlyPromptedPackages = new Map<string, number>();
  const installingPackages = new Set<string>();
  const promptCooldownMs = 60_000;
	const cacheMaxEntries = 200;
	const resultCache = new Map<string, PreviewResult>();
	const inFlightTasks = new Map<string, RunningPreviewTask>();
  const debounced = createDebouncedExecutor(initialConfig.debounceMs);
	let runningTask: RunningPreviewTask | undefined;
	let runningTaskKey: string | undefined;
	let currentRequestId = 0;

	const openPanelCommand = vscode.commands.registerCommand("rHiddenPreview.openPreviewPanel", () => {
		const editor = vscode.window.activeTextEditor;
		const result: PreviewResult = {
			kind: "text",
			summary: "Panel is ready.",
			detail: "Select R code to run hidden preview automatically."
		};
		panel.update(
			{
				fileName: editor?.document.fileName ?? "(no active editor)",
				mode: getConfig().contextMode,
				result,
				timestamp: new Date().toLocaleTimeString()
			},
			true
		);
	});

	const showOutputCommand = vscode.commands.registerCommand("rHiddenPreview.showOutput", () => {
		outputChannel.show(true);
	});

	const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
		const config = getConfig();
		debounced.updateWait(config.debounceMs);

		if (!config.autoPreview) {
			return;
		}

		debounced.run(() => {
			void handleSelectionChange(event.textEditor);
		});
	});

	const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration("rHiddenPreview")) {
			const config = getConfig();
			debounced.updateWait(config.debounceMs);
		}
	});

	context.subscriptions.push(
		openPanelCommand,
		showOutputCommand,
		selectionListener,
		configurationListener,
		decorations,
		panel,
		outputChannel,
		statusItem
	);

	async function handleSelectionChange(editor: vscode.TextEditor): Promise<void> {
		const config = getConfig();
		if (!isREditor(editor)) {
			return;
		}

		if (config.requireWorkspaceTrust && !vscode.workspace.isTrusted) {
			clearInline(editor);
			publishResult(editor, {
				kind: "error",
				summary: "Workspace is not trusted.",
				detail:
					"Auto preview is disabled in untrusted workspace. Disable rHiddenPreview.requireWorkspaceTrust to allow preview."
			});
			cancelRunningTask();
			return;
		}

		const selection = editor.selection;
		if (selection.isEmpty) {
			cancelRunningTask();
			return;
		}

		const selectedText = editor.document.getText(selection);
		const selectionCheck = checkSelectionCompleteness(selectedText);

		if (!selectionCheck.ok) {
			if (selectionCheck.shouldSkip || config.ignoreIncompleteSelection) {
				cancelRunningTask();
				return;
			}

			const reason = selectionCheck.reason ?? "Selection appears incomplete.";
			publishResult(editor, { kind: "error", summary: reason, detail: reason });
			return;
		}

		if (
			config.safeAutoExecutionOnly &&
			!isSafeExpression(selectedText, {
				denyFunctions: config.safeFunctionBlacklist,
				allowFunctions: config.safeFunctionWhitelist
			})
		) {
			cancelRunningTask();
			statusItem.text = "R Hidden Preview: Skipped unsafe expression";
			vscode.window.setStatusBarMessage(
				"[R Hidden Preview] Skipped unsafe expression for auto preview. Disable rHiddenPreview.safeAutoExecutionOnly to allow.",
				3000
			);
			outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] SKIP Unsafe expression`);
			outputChannel.appendLine(selectedText.trim() || "(empty)");
			outputChannel.appendLine("");
			return;
		}

		const fullCode = buildCodeByContextMode(editor, selection, config.contextMode);
		const targetLine = selection.end.line;
		const executionKey = hashCodeContext(fullCode, `${editor.document.fileName}\n${config.contextMode}`);

		const cached = resultCache.get(executionKey);
		if (cached) {
			cancelRunningTask();
			statusItem.text = "R Hidden Preview: Cache hit";
			vscode.window.setStatusBarMessage("[R Hidden Preview] Cache hit. Reused previous result.", 2000);
			publishResult(editor, cached, targetLine);
			return;
		}

		const existingTask = inFlightTasks.get(executionKey);
		if (existingTask) {
			if (runningTaskKey !== executionKey) {
				cancelRunningTask();
			}

			const requestId = ++currentRequestId;
			statusItem.text = "R Hidden Preview: Reusing running task...";
			const result = await existingTask.promise;
			if (requestId !== currentRequestId) {
				return;
			}
			publishResult(editor, result, targetLine);
			return;
		}

		cancelRunningTask();
		const requestId = ++currentRequestId;

		runningTask = runner.run({
			rscriptPath: config.rscriptPath,
			fullCode,
			timeoutMs: config.timeoutMs,
			maxOutputLength: config.maxOutputLength
		});
		runningTaskKey = executionKey;
		inFlightTasks.set(executionKey, runningTask);
		statusItem.text = "R Hidden Preview: Running...";

		const result = await runningTask.promise;
		if (inFlightTasks.get(executionKey) === runningTask) {
			inFlightTasks.delete(executionKey);
		}
		if (requestId !== currentRequestId) {
			return;
		}

		if (result.kind === "text") {
			putCache(executionKey, result);
		}

		publishResult(editor, result, targetLine);
	}

	function publishResult(editor: vscode.TextEditor, result: PreviewResult, line?: number): void {
		const config = getConfig();
		const renderLine = line ?? editor.selection.end.line;
		if (config.showInlinePreview) {
			decorations.show(editor, renderLine, result.summary);
		} else {
			clearInline(editor);
		}

		const detail = result.detail ?? "(no detail)";
		outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${result.kind.toUpperCase()} ${result.summary}`);
		outputChannel.appendLine(detail);
		outputChannel.appendLine("");
		outputChannel.show(true);
		statusItem.text = `R Hidden Preview: ${result.summary}`;
		vscode.window.setStatusBarMessage(`[R Hidden Preview] ${result.summary}`, 3000);
		if (result.kind === "error") {
			outputChannel.show(true);
		}

		if (config.showPanelPreview) {
			panel.update({
				fileName: editor.document.fileName,
				mode: config.contextMode,
				result,
				timestamp: new Date().toLocaleTimeString()
			}, false);
		}

		void maybePromptInstallMissingPackages(result);
	}

	async function maybePromptInstallMissingPackages(result: PreviewResult): Promise<void> {
		if (result.kind !== "error") {
			return;
		}

		const combinedText = `${result.summary}\n${result.detail ?? ""}`;
		const detected = detectMissingPackages(combinedText)
			.filter((pkg) => /^[A-Za-z][A-Za-z0-9._]*$/.test(pkg));

		if (detected.length === 0) {
			return;
		}

		const now = Date.now();
		const pending = detected.filter((pkg) => {
			if (installingPackages.has(pkg)) {
				return false;
			}
			const lastPrompt = recentlyPromptedPackages.get(pkg) ?? 0;
			return now - lastPrompt > promptCooldownMs;
		});

		if (pending.length === 0) {
			return;
		}

		pending.forEach((pkg) => recentlyPromptedPackages.set(pkg, now));

		const installAction = "安装缺失包";
		const selected = await vscode.window.showInformationMessage(
			`检测到缺失 R 包: ${pending.join(", ")}`,
			installAction,
			"忽略"
		);

		if (selected !== installAction) {
			return;
		}

		await installMissingPackages(pending);
	}

	async function installMissingPackages(packages: string[]): Promise<void> {
		const toInstall = packages.filter((pkg) => !installingPackages.has(pkg));
		if (toInstall.length === 0) {
			return;
		}

		toInstall.forEach((pkg) => installingPackages.add(pkg));
		statusItem.text = "R Hidden Preview: Installing packages...";

		try {
			const config = getConfig();
			const resolvedRscriptPath = await resolveRscriptPath(config.rscriptPath);
			const packageList = toInstall.map((pkg) => `'${pkg.replace(/'/g, "")}'`).join(", ");
			const installExpr = `options(repos = c(CRAN = 'https://cloud.r-project.org')); install.packages(c(${packageList}))`;

			const installResult = await runRInstall(resolvedRscriptPath, installExpr);
			outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] PACKAGE INSTALL ${installResult.ok ? "SUCCESS" : "FAILED"}`);
			outputChannel.appendLine(installResult.output || "(no install output)");
			outputChannel.appendLine("");

			if (installResult.ok) {
				statusItem.text = "R Hidden Preview: Package install completed";
				vscode.window.showInformationMessage(`R 包安装完成: ${toInstall.join(", ")}`);
			} else {
				statusItem.text = "R Hidden Preview: Package install failed";
				vscode.window.showErrorMessage("R 包自动安装失败，请查看 R Hidden Preview 输出日志。");
				outputChannel.show(true);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] PACKAGE INSTALL ERROR`);
			outputChannel.appendLine(message);
			outputChannel.appendLine("");
			outputChannel.show(true);
			statusItem.text = "R Hidden Preview: Package install error";
			vscode.window.showErrorMessage("R 包自动安装发生错误，请查看 R Hidden Preview 输出日志。");
		} finally {
			toInstall.forEach((pkg) => installingPackages.delete(pkg));
		}
	}

	function cancelRunningTask(): void {
		if (runningTask) {
			if (runningTaskKey && inFlightTasks.get(runningTaskKey) === runningTask) {
				inFlightTasks.delete(runningTaskKey);
			}
			runningTask.cancel();
			runningTask = undefined;
			runningTaskKey = undefined;
		}
	}

	function putCache(key: string, result: PreviewResult): void {
		if (resultCache.has(key)) {
			resultCache.delete(key);
		}

		resultCache.set(key, result);
		while (resultCache.size > cacheMaxEntries) {
			const first = resultCache.keys().next().value as string | undefined;
			if (!first) {
				break;
			}
			resultCache.delete(first);
		}
	}

	function clearInline(editor: vscode.TextEditor): void {
		decorations.clear(editor);
	}
}

function detectMissingPackages(text: string): string[] {
	const patterns = [
		/there is no package called[\s"'`“”‘’]+([A-Za-z][A-Za-z0-9._]*)/gi,
		/package[\s"'`“”‘’]+([A-Za-z][A-Za-z0-9._]*)[\s"'`“”‘’]+is not installed/gi,
		/找不到程辑包[\s"'`“”‘’]*([A-Za-z][A-Za-z0-9._]*)/gi,
		/没有名为[\s"'`“”‘’]*([A-Za-z][A-Za-z0-9._]*)[\s"'`“”‘’]*的程辑包/gi
	];

	const found = new Set<string>();
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			if (match[1]) {
				found.add(match[1]);
			}
		}
	}

	return [...found];
}

function runRInstall(
	rscriptPath: string,
	expression: string
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		let stdoutBuffer = "";
		let stderrBuffer = "";

		const child = spawn(rscriptPath, ["--vanilla", "-e", expression], {
			windowsHide: true,
			stdio: "pipe"
		});

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");

		child.stdout.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
		});

		child.stderr.on("data", (chunk: string) => {
			stderrBuffer += chunk;
		});

		child.on("error", (error) => {
			resolve({
				ok: false,
				output: error.message
			});
		});

		child.on("close", (code) => {
			const merged = `${stdoutBuffer}\n${stderrBuffer}`.trim();
			resolve({
				ok: code === 0,
				output: merged
			});
		});
	});
}

export function deactivate(): void {
	// Nothing to tear down here. Disposables are managed by VS Code subscriptions.
}

function isREditor(editor: vscode.TextEditor): boolean {
	return editor.document.languageId.toLowerCase() === "r";
}

function buildCodeByContextMode(
	editor: vscode.TextEditor,
	selection: vscode.Selection,
	mode: "selectionOnly" | "documentBeforeSelection"
): string {
	const selected = editor.document.getText(selection);
	if (mode === "selectionOnly") {
		return selected;
	}

	const beforeRange = new vscode.Range(new vscode.Position(0, 0), selection.start);
	const before = editor.document.getText(beforeRange);
	return `${before}\n${selected}`;
}
