import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { parsePreviewResult } from "./resultParser";
import { PreviewResult } from "../types";
import { resolveRscriptPath } from "../util/rscriptResolver";
import { createTempDir, safeRemoveDir, writeUtf8File } from "../util/tempFiles";

export interface RunPreviewInput {
  rscriptPath: string;
  fullCode: string;
  timeoutMs: number;
  maxOutputLength: number;
}

export interface RunningPreviewTask {
  promise: Promise<PreviewResult>;
  cancel: () => void;
}

interface PendingRequest {
  id: number;
  input: RunPreviewInput;
  cancelled: boolean;
  resolve: (value: PreviewResult) => void;
}

export class RRunner {
  private sessionProcess: ChildProcessWithoutNullStreams | undefined;
  private sessionDir: string | undefined;
  private sessionScriptPath: string | undefined;
  private resolvedRscriptPath: string | undefined;
  private readonly signal = new EventEmitter();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private startPromise: Promise<void> | undefined;
  private readonly queue: PendingRequest[] = [];
  private activeRequest: PendingRequest | undefined;
  private nextRequestId = 1;

  run(input: RunPreviewInput): RunningPreviewTask {
    let settled = false;

    const promise = new Promise<PreviewResult>((resolve) => {
      const request: PendingRequest = {
        id: this.nextRequestId,
        input,
        cancelled: false,
        resolve: (result) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(result);
        }
      };

      this.nextRequestId += 1;
      this.queue.push(request);
      void this.pumpQueue();
    });

    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }

        const target = this.queue.find((req) => !req.cancelled && req.input === input);
        if (target) {
          target.cancelled = true;
          target.resolve({
            kind: "text",
            summary: "Preview cancelled.",
            detail: "The previous preview task was cancelled because a new selection was made."
          });
          this.removeCancelledFromQueue();
          return;
        }

        if (this.activeRequest && this.activeRequest.input === input) {
          const active = this.activeRequest;
          active.cancelled = true;
          this.disposeSession();
          active.resolve({
            kind: "text",
            summary: "Preview cancelled.",
            detail: "The previous preview task was cancelled because a new selection was made."
          });
        }
      }
    };
  }

  dispose(): void {
    this.disposeSession();
    this.queue.length = 0;
  }

  private async pumpQueue(): Promise<void> {
    if (this.activeRequest) {
      return;
    }

    this.removeCancelledFromQueue();
    const request = this.queue.shift();
    if (!request) {
      return;
    }

    if (request.cancelled) {
      request.resolve({
        kind: "text",
        summary: "Preview cancelled.",
        detail: "The previous preview task was cancelled because a new selection was made."
      });
      void this.pumpQueue();
      return;
    }

    this.activeRequest = request;

    try {
      await this.ensureSession(request.input.rscriptPath);
      if (request.cancelled) {
        request.resolve({
          kind: "text",
          summary: "Preview cancelled.",
          detail: "The previous preview task was cancelled because a new selection was made."
        });
        return;
      }

      const result = await this.executeRequest(request);
      request.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.resolve({
        kind: "error",
        summary: "Preview failed.",
        detail: message
      });
    } finally {
      this.activeRequest = undefined;
      void this.pumpQueue();
    }
  }

  private async ensureSession(rscriptPath: string): Promise<void> {
    if (this.sessionProcess && !this.sessionProcess.killed) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startSession(rscriptPath);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startSession(rscriptPath: string): Promise<void> {
    this.disposeSession();
    this.sessionDir = await createTempDir("r-hidden-preview-session-");
    this.sessionScriptPath = path.join(this.sessionDir, "session-runner.R");
    await writeUtf8File(this.sessionScriptPath, buildSessionRunnerScript());

    this.resolvedRscriptPath = await resolveRscriptPath(rscriptPath);
    console.log("[R Hidden Preview] Starting long-lived session:", this.resolvedRscriptPath);

    this.sessionProcess = spawn(
      this.resolvedRscriptPath,
      ["--vanilla", this.sessionScriptPath, this.sessionDir],
      {
        windowsHide: true,
        stdio: "pipe"
      }
    );

    this.sessionProcess.stdout.setEncoding("utf8");
    this.sessionProcess.stderr.setEncoding("utf8");

    this.sessionProcess.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += normalizeNewlines(chunk);
      this.signal.emit("data");
    });

    this.sessionProcess.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += normalizeNewlines(chunk);
      this.signal.emit("data");
    });

    this.sessionProcess.on("error", (error) => {
      console.error("[R Hidden Preview] Session process error:", error);
      this.signal.emit("data");
    });

    this.sessionProcess.on("close", () => {
      this.signal.emit("data");
      this.sessionProcess = undefined;
    });
  }

  private async executeRequest(request: PendingRequest): Promise<PreviewResult> {
    if (!this.sessionProcess || !this.sessionDir) {
      throw new Error("R session is not available.");
    }

    const payloadPath = path.join(this.sessionDir, `payload-${request.id}.R`);
    await writeUtf8File(payloadPath, request.input.fullCode);

    const stderrStart = this.stderrBuffer.length;
    const line = `RUN\t${request.id}\t${payloadPath}\t${request.input.maxOutputLength}\n`;
    this.sessionProcess.stdin.write(line, "utf8");

    const begin = `<<RPREVIEW_BEGIN>>${request.id}\n`;
    const end = `<<RPREVIEW_END>>${request.id}\n`;

    const response = await this.waitForResponse(begin, end, request.input.timeoutMs);
    const stderrDelta = this.stderrBuffer.slice(stderrStart);
    const parsed = parsePreviewResult(response, stderrDelta, request.input.maxOutputLength);
    return withPlotImage(parsed.result, parsed.plotFilePath);
  }

  private waitForResponse(beginToken: string, endToken: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const tryExtract = (): string | undefined => {
        const beginIndex = this.stdoutBuffer.indexOf(beginToken);
        if (beginIndex === -1) {
          return undefined;
        }

        const contentStart = beginIndex + beginToken.length;
        const endIndex = this.stdoutBuffer.indexOf(endToken, contentStart);
        if (endIndex === -1) {
          return undefined;
        }

        const payload = this.stdoutBuffer.slice(contentStart, endIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(endIndex + endToken.length);
        return payload;
      };

      const onData = (): void => {
        const payload = tryExtract();
        if (payload === undefined) {
          return;
        }
        cleanup();
        resolve(payload);
      };

      const onTimeout = setTimeout(() => {
        cleanup();
        this.disposeSession();
        reject(new Error(`Execution exceeded ${timeoutMs} ms and the session was restarted.`));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(onTimeout);
        this.signal.off("data", onData);
      };

      this.signal.on("data", onData);
      onData();
    });
  }

  private removeCancelledFromQueue(): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].cancelled) {
        this.queue.splice(i, 1);
      }
    }
  }

  private disposeSession(): void {
    if (this.sessionProcess && !this.sessionProcess.killed) {
      this.sessionProcess.kill();
    }
    this.sessionProcess = undefined;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    const dir = this.sessionDir;
    this.sessionDir = undefined;
    this.sessionScriptPath = undefined;
    this.resolvedRscriptPath = undefined;

    if (dir) {
      void safeRemoveDir(dir);
    }
  }
}

async function withPlotImage(result: PreviewResult, plotFilePath?: string): Promise<PreviewResult> {
  if (!plotFilePath) {
    return result;
  }

  try {
    const pngBuffer = await readFile(plotFilePath);
    if (pngBuffer.length === 0) {
      return result;
    }

    return {
      ...result,
      plotPngBase64: pngBuffer.toString("base64")
    };
  } catch {
    return result;
  }
}

function buildSessionRunnerScript(): string {
  return [
    "args <- commandArgs(trailingOnly = TRUE)",
    "sessionDir <- args[[1]]",
    "stdinConn <- file('stdin', 'r')",
    "",
    "truncate_text <- function(x, n) {",
    "  if (is.na(n) || n <= 0) return(x)",
    "  if (nchar(x, type = 'bytes') <= n) return(x)",
    "  paste0(substr(x, 1, n), '...[truncated]')",
    "}",
    "",
    "safe_read <- function(file_path) {",
    "  lines <- readLines(file_path, warn = FALSE, encoding = 'UTF-8')",
    "  paste(lines, collapse = '\\n')",
    "}",
    "",
    "sanitize_cell <- function(x) {",
    "  value <- as.character(x)",
    "  value <- gsub('\\\\t', ' ', value)",
    "  value <- gsub('\\\\r?\\\\n', ' ', value, perl = TRUE)",
    "  value",
    "}",
    "",
    "emit_response <- function(reqId, kind, summary, detail, plot_file = '', table_tsv = '', table_types = '', table_total_rows = '0', table_is_tibble = 'false', table_truncated = 'false') {",
    "  cat('<<RPREVIEW_BEGIN>>', reqId, '\\n', sep = '')",
    "  cat('<<RPREVIEW_KIND>>', kind, '\\n', sep = '')",
    "  cat('<<RPREVIEW_SUMMARY>>\\n', summary, '\\n<<RPREVIEW_SUMMARY_END>>\\n', sep = '')",
    "  cat('<<RPREVIEW_DETAIL>>\\n', detail, '\\n<<RPREVIEW_DETAIL_END>>\\n', sep = '')",
    "  cat('<<RPREVIEW_PLOT>>\\n', plot_file, '\\n<<RPREVIEW_PLOT_END>>\\n', sep = '')",
    "  cat('<<RPREVIEW_TABLE_TSV>>\\n', table_tsv, '\\n<<RPREVIEW_TABLE_TSV_END>>\\n', sep = '')",
    "  cat('<<RPREVIEW_TABLE_TYPES>>\\n', table_types, '\\n<<RPREVIEW_TABLE_TYPES_END>>\\n', sep = '')",
    "  cat('<<RPREVIEW_TABLE_TOTAL_ROWS>>', table_total_rows, '\\n', sep = '')",
    "  cat('<<RPREVIEW_TABLE_IS_TIBBLE>>', table_is_tibble, '\\n', sep = '')",
    "  cat('<<RPREVIEW_TABLE_TRUNCATED>>', table_truncated, '\\n', sep = '')",
    "  cat('<<RPREVIEW_END>>', reqId, '\\n', sep = '')",
    "  flush.console()",
    "}",
    "",
    "execute_request <- function(reqId, payloadPath, maxLen) {",
    "  plotPath <- file.path(sessionDir, paste0('preview_plot_', reqId, '.png'))",
    "  tryCatch({",
    "    if (file.exists(plotPath)) unlink(plotPath)",
    "    code <- safe_read(payloadPath)",
    "    exprs <- parse(text = code)",
    "    if (length(exprs) == 0) {",
    "      emit_response(reqId, 'text', '(empty)', 'No expression to evaluate.', '', '', '', '0', 'false', 'false')",
    "      return(invisible(NULL))",
    "    }",
    "",
    "    last_value <- NULL",
    "    warning_buffer <- character()",
    "    oldDevice <- getOption('device')",
    "    options(device = function(...) grDevices::png(filename = plotPath, width = 960, height = 600))",
    "    on.exit(options(device = oldDevice), add = TRUE)",
    "",
    "    output_lines <- withCallingHandlers(",
    "      capture.output({",
    "        for (expr in exprs) {",
    "          last_value <- eval(expr, envir = .GlobalEnv)",
    "        }",
    "        if (!is.null(last_value)) {",
    "          print(last_value)",
    "        }",
    "      }, type = 'output'),",
    "      warning = function(w) {",
    "        warning_buffer <<- c(warning_buffer, paste0('Warning: ', conditionMessage(w)))",
    "        invokeRestart('muffleWarning')",
    "      }",
    "    )",
    "",
    "    detail_lines <- c(warning_buffer, output_lines)",
    "    if (length(detail_lines) == 0) {",
    "      detail_lines <- c('(no textual output)')",
    "    }",
    "",
    "    detail <- paste(detail_lines, collapse = '\\n')",
    "    summary <- strsplit(detail, '\\n', fixed = TRUE)[[1]][1]",
    "",
    "    while (!is.null(grDevices::dev.list())) {",
    "      grDevices::dev.off()",
    "    }",
    "",
    "    emittedPlot <- ''",
    "    if (file.exists(plotPath)) {",
    "      fileSize <- file.info(plotPath)$size",
    "      if (!is.na(fileSize) && fileSize > 0) {",
    "        emittedPlot <- plotPath",
    "      }",
    "    }",
    "",
    "    tableTsv <- ''",
    "    tableTypes <- ''",
    "    tableTotalRows <- '0'",
    "    tableIsTibble <- 'false'",
    "    tableTruncated <- 'false'",
    "    if (is.data.frame(last_value)) {",
    "      rowCount <- nrow(last_value)",
    "      tableDf <- if (rowCount > 0) last_value[seq_len(rowCount), , drop = FALSE] else last_value[0, , drop = FALSE]",
    "      tableTotalRows <- as.character(rowCount)",
    "      tableIsTibble <- if (inherits(last_value, 'tbl_df')) 'true' else 'false'",
    "      tableTypes <- paste(vapply(last_value, function(col) paste(class(col), collapse = '/'), character(1)), collapse = '\\t')",
    "      tableDf[] <- lapply(tableDf, sanitize_cell)",
    "      header <- paste(colnames(tableDf), collapse = '\\t')",
    "      body <- if (rowCount > 0) apply(tableDf, 1, function(row) paste(row, collapse = '\\t')) else character()",
    "      tableTsv <- paste(c(header, body), collapse = '\\n')",
    "    }",
    "",
    "    emit_response(reqId, 'text', truncate_text(summary, maxLen), truncate_text(detail, maxLen), emittedPlot, tableTsv, tableTypes, tableTotalRows, tableIsTibble, tableTruncated)",
    "  }, error = function(e) {",
    "    error_message <- paste0('Error: ', conditionMessage(e))",
    "    emit_response(reqId, 'error', truncate_text(error_message, maxLen), truncate_text(error_message, maxLen), '', '', '', '0', 'false', 'false')",
    "  })",
    "}",
    "",
    "repeat {",
    "  line <- readLines(stdinConn, n = 1, warn = FALSE)",
    "  if (length(line) == 0) {",
    "    break",
    "  }",
    "",
    "  if (line == 'EXIT') {",
    "    break",
    "  }",
    "",
    "  parts <- strsplit(line, '\\t', fixed = TRUE)[[1]]",
    "  if (length(parts) < 4 || parts[[1]] != 'RUN') {",
    "    next",
    "  }",
    "",
    "  reqId <- parts[[2]]",
    "  payloadPath <- parts[[3]]",
    "  maxLen <- as.integer(parts[[4]])",
    "  execute_request(reqId, payloadPath, maxLen)",
    "}",
    ""
  ].join("\n");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
