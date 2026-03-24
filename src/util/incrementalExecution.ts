import { hashCodeContext } from "./hash";

interface BlockMeta {
  code: string;
  hash: string;
  provides: string[];
  uses: string[];
  dependents: number[];
}

interface ScopeState {
  blocks: BlockMeta[];
}

export interface IncrementalExecutionPlan {
  scopeKey: string;
  executionCode: string;
  totalBlocks: number;
  executeBlockCount: number;
  changedBlockCount: number;
  reusedBlockCount: number;
  reason: string;
  nextState: ScopeState;
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

export class IncrementalExecutionManager {
  private readonly states = new Map<string, ScopeState>();

  createPlan(scopeKey: string, code: string): IncrementalExecutionPlan {
    const current = buildBlockMetas(code);
    const previous = this.states.get(scopeKey);

    const dirty = new Set<number>();
    let reason = "stable";

    if (!previous) {
      for (let i = 0; i < current.length; i += 1) {
        dirty.add(i);
      }
      reason = "cold-start";
    } else {
      if (previous.blocks.length !== current.length) {
        reason = "shape-changed";
      }

      for (let i = 0; i < current.length; i += 1) {
        const currentBlock = current[i];
        const prevBlock = previous.blocks[i];
        if (!prevBlock) {
          dirty.add(i);
          continue;
        }

        if (
          currentBlock.hash !== prevBlock.hash ||
          !sameStringArray(currentBlock.provides, prevBlock.provides) ||
          !sameStringArray(currentBlock.uses, prevBlock.uses)
        ) {
          dirty.add(i);
        }
      }
    }

    const queue = [...dirty];
    while (queue.length > 0) {
      const idx = queue.pop();
      if (idx === undefined) {
        continue;
      }

      for (const dep of current[idx]?.dependents ?? []) {
        if (!dirty.has(dep)) {
          dirty.add(dep);
          queue.push(dep);
        }
      }
    }

    // Always include the final block for preview freshness under incremental mode.
    if (current.length > 0) {
      dirty.add(current.length - 1);
    }

    const executionIndices = [...dirty].sort((a, b) => a - b);
    const executionCode = executionIndices.map((idx) => current[idx].code).join("\n");

    return {
      scopeKey,
      executionCode,
      totalBlocks: current.length,
      executeBlockCount: executionIndices.length,
      changedBlockCount: dirty.size,
      reusedBlockCount: Math.max(0, current.length - executionIndices.length),
      reason,
      nextState: { blocks: current }
    };
  }

  commitPlan(plan: IncrementalExecutionPlan): void {
    this.states.set(plan.scopeKey, plan.nextState);
  }

  invalidate(scopeKey: string): void {
    this.states.delete(scopeKey);
  }

  resetAll(): void {
    this.states.clear();
  }
}

function buildBlockMetas(code: string): BlockMeta[] {
  const lines = code.split(/\r?\n/);
  const blocks = splitLogicalBlocks(lines);
  const metas: BlockMeta[] = blocks.map((block) => {
    const cleaned = stripComment(block).trim();
    const assignment = parseAssignment(cleaned);
    const provides = assignment ? [assignment.target] : [];
    const uses = extractIdentifiers(assignment ? assignment.rhs : cleaned).filter((name) => !provides.includes(name));

    return {
      code: block,
      hash: hashCodeContext(block, "block"),
      provides,
      uses,
      dependents: []
    };
  });

  const latestProvider = new Map<string, number>();
  for (let i = 0; i < metas.length; i += 1) {
    for (const use of metas[i].uses) {
      const provider = latestProvider.get(use);
      if (provider !== undefined && provider < i) {
        metas[provider].dependents.push(i);
      }
    }

    for (const provided of metas[i].provides) {
      latestProvider.set(provided, i);
    }
  }

  for (const meta of metas) {
    meta.dependents = uniqueSorted(meta.dependents);
  }

  return metas;
}

function splitLogicalBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let line = 0;

  while (line < lines.length) {
    let end = line;
    let code = lines[line] ?? "";

    while (end + 1 < lines.length && needsContinuation(code)) {
      end += 1;
      code += `\n${lines[end] ?? ""}`;
    }

    if (code.trim().length > 0) {
      blocks.push(code);
    }

    line = end + 1;
  }

  return blocks;
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

function extractIdentifiers(code: string): string[] {
  const lowered = stripComment(code).toLowerCase();
  const found = lowered.match(IDENTIFIER_PATTERN) ?? [];
  return uniqueSorted(found.filter((name) => !KEYWORDS.has(name)));
}

function uniqueSorted(values: number[]): number[];
function uniqueSorted(values: string[]): string[];
function uniqueSorted(values: Array<number | string>): Array<number | string> {
  const unique = [...new Set(values)];
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
