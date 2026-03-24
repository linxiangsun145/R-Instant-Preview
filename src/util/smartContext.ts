import * as vscode from "vscode";

interface AssignmentInfo {
  startLine: number;
  endLine: number;
  deps: Set<string>;
}

interface CodeBlock {
  startLine: number;
  endLine: number;
  code: string;
}

const IDENTIFIER_PATTERN = /\b[A-Za-z.][A-Za-z0-9._]*\b/g;
const ASSIGNMENT_PATTERN = /^\s*(.+?)\s*(?:<-|=)\s*([\s\S]+)$/;
const LHS_TARGET_PATTERN =
  /^([A-Za-z.][A-Za-z0-9._]*)(?:\s*(?:\$|@)\s*[A-Za-z.][A-Za-z0-9._]*|\s*\[[^\]]*\])*$/;
const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "repeat",
  "function",
  "in",
  "next",
  "break",
  "return",
  "true",
  "false",
  "null",
  "na",
  "nan",
  "inf"
]);

const PLOT_BASE_FUNCTIONS = new Set([
  "plot",
  "pie",
  "barplot",
  "hist",
  "boxplot",
  "matplot",
  "image",
  "filled.contour",
  "curve",
  "dotchart",
  "qqnorm",
  "pairs",
  "stripchart",
  "mosaicplot",
  "spineplot"
]);

const PLOT_AUGMENT_FUNCTIONS = new Set([
  "legend",
  "title",
  "mtext",
  "axis",
  "abline",
  "lines",
  "points",
  "text",
  "arrows",
  "segments",
  "polygon",
  "rect",
  "grid",
  "box"
]);

export function buildSmartContextCode(editor: vscode.TextEditor, selection: vscode.Selection): string {
  const fullText = editor.document.getText();
  const selectedCode = editor.document.getText(selection);
  return buildSmartContextCodeFromText(fullText, selection.start.line, selectedCode);
}

export function buildSmartContextCodeFromText(
  fullText: string,
  selectionStartLine: number,
  selectedCode: string
): string {
  const selectedAssigned = extractAssignedNames(selectedCode);
  const required = new Set<string>(extractIdentifiers(selectedCode));
  selectedAssigned.forEach((name) => required.delete(name));

  const lines = fullText.split(/\r?\n/);
  const assignments = collectAssignments(lines, selectionStartLine);
  const includedLines = new Set<number>();

  const queue = [...required];
  const visited = new Set<string>();
  consumeDependencyQueue(queue, visited, assignments, includedLines);

  if (shouldIncludePriorPlotContext(selectedCode)) {
    const plotBlock = findNearestPlotProducerBlock(lines, selectionStartLine);
    if (plotBlock) {
      includeLineRange(includedLines, plotBlock.startLine, plotBlock.endLine);
      const plotDeps = extractBlockDependencies(plotBlock.code);
      consumeDependencyQueue(plotDeps, visited, assignments, includedLines);
    }
  }

  const contextCode = [...includedLines]
    .sort((a, b) => a - b)
    .map((line) => lines[line] ?? "")
    .join("\n")
    .trim();

  if (!contextCode) {
    return selectedCode;
  }

  return `${contextCode}\n${selectedCode}`;
}

function collectAssignments(lines: string[], endLineExclusive: number): Map<string, AssignmentInfo> {
  const map = new Map<string, AssignmentInfo>();

  for (let line = 0; line < endLineExclusive; line += 1) {
    const block = collectLogicalBlock(lines, line, endLineExclusive);
    const code = stripComment(block.code).trim();
    line = block.endLine;

    if (!code) {
      continue;
    }

    const parsed = parseAssignment(code);
    if (!parsed) {
      continue;
    }

    const deps = new Set<string>(extractIdentifiers(parsed.rhs));
    deps.delete(parsed.target);

    map.set(parsed.target, {
      startLine: block.startLine,
      endLine: block.endLine,
      deps
    });
  }

  return map;
}

function extractAssignedNames(code: string): Set<string> {
  const names = new Set<string>();

  code.split(/\r?\n/).forEach((line) => {
    const cleaned = stripComment(line).trim();
    const parsed = parseAssignment(cleaned);
    if (parsed) {
      names.add(parsed.target);
    }
  });

  return names;
}

function extractIdentifiers(code: string): string[] {
  const lowered = stripComment(code).toLowerCase();
  const found = lowered.match(IDENTIFIER_PATTERN) ?? [];
  return found.filter((name) => !KEYWORDS.has(name));
}

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function parseAssignment(code: string): { target: string; rhs: string } | undefined {
  const match = code.match(ASSIGNMENT_PATTERN);
  if (!match) {
    return undefined;
  }

  const lhs = (match[1] ?? "").trim();
  const rhs = (match[2] ?? "").trim();
  if (!lhs || !rhs || !LHS_TARGET_PATTERN.test(lhs)) {
    return undefined;
  }

  const base = lhs.match(/^[A-Za-z.][A-Za-z0-9._]*/)?.[0]?.toLowerCase();
  if (!base) {
    return undefined;
  }

  return { target: base, rhs };
}

function collectLogicalBlock(lines: string[], startLine: number, endLineExclusive: number): CodeBlock {
  let endLine = startLine;
  let code = lines[startLine] ?? "";

  while (endLine + 1 < endLineExclusive && needsContinuation(code)) {
    endLine += 1;
    code += `\n${lines[endLine] ?? ""}`;
  }

  return { startLine, endLine, code };
}

function needsContinuation(code: string): boolean {
  const withoutComments = code
    .split(/\r?\n/)
    .map((line) => stripComment(line))
    .join("\n");
  const compact = withoutComments.trim();
  if (!compact) {
    return false;
  }

  const parenBalance = countChar(withoutComments, "(") - countChar(withoutComments, ")");
  const braceBalance = countChar(withoutComments, "{") - countChar(withoutComments, "}");
  const bracketBalance = countChar(withoutComments, "[") - countChar(withoutComments, "]");

  if (parenBalance > 0 || braceBalance > 0 || bracketBalance > 0) {
    return true;
  }

  return /(?:<-|=|\+|-|\*|\/|\^|%%|%\/%|%\*%|\||&|,|:)\s*$/.test(compact);
}

function countChar(text: string, target: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === target) {
      count += 1;
    }
  }
  return count;
}

function includeLineRange(linesSet: Set<number>, startLine: number, endLine: number): void {
  for (let line = startLine; line <= endLine; line += 1) {
    linesSet.add(line);
  }
}

function consumeDependencyQueue(
  queue: Iterable<string>,
  visited: Set<string>,
  assignments: Map<string, AssignmentInfo>,
  includedLines: Set<number>
): void {
  const stack = [...queue];
  while (stack.length > 0) {
    const symbol = stack.pop();
    if (!symbol || visited.has(symbol)) {
      continue;
    }
    visited.add(symbol);

    const assignment = assignments.get(symbol);
    if (!assignment) {
      continue;
    }

    includeLineRange(includedLines, assignment.startLine, assignment.endLine);
    for (const dep of assignment.deps) {
      if (!visited.has(dep)) {
        stack.push(dep);
      }
    }
  }
}

function extractBlockDependencies(code: string): string[] {
  const cleaned = stripComment(code).trim();
  if (!cleaned) {
    return [];
  }

  const assignment = parseAssignment(cleaned);
  const targetCode = assignment ? assignment.rhs : cleaned;
  return extractIdentifiers(targetCode);
}

function shouldIncludePriorPlotContext(selectedCode: string): boolean {
  return containsFunctionCall(selectedCode, PLOT_AUGMENT_FUNCTIONS);
}

function containsFunctionCall(code: string, names: Set<string>): boolean {
  const lowered = code.toLowerCase();
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, "i");
    if (pattern.test(lowered)) {
      return true;
    }
  }
  return false;
}

function findNearestPlotProducerBlock(lines: string[], endLineExclusive: number): CodeBlock | undefined {
  const blocks: CodeBlock[] = [];
  for (let line = 0; line < endLineExclusive; line += 1) {
    const block = collectLogicalBlock(lines, line, endLineExclusive);
    blocks.push(block);
    line = block.endLine;
  }

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (isPlotProducerBlock(block.code)) {
      return block;
    }
  }

  return undefined;
}

function isPlotProducerBlock(code: string): boolean {
  const cleaned = stripComment(code).trim();
  if (!cleaned) {
    return false;
  }

  if (containsFunctionCall(cleaned, PLOT_BASE_FUNCTIONS)) {
    return true;
  }

  const assignment = parseAssignment(cleaned);
  if (!assignment) {
    return false;
  }

  return containsFunctionCall(assignment.rhs, PLOT_BASE_FUNCTIONS);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
