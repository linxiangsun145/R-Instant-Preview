export interface TablePreview {
  columns: string[];
  columnTypes: string[];
  rows: string[][];
  totalRows: number;
  isTibble: boolean;
  truncated: boolean;
}

export interface VariablePreviewItem {
  name: string;
  type: string;
  size: string;
  preview: string;
}

interface PreviewResultBase {
  summary: string;
  detail?: string;
  plotPngBase64?: string;
  tablePreview?: TablePreview;
  variables?: VariablePreviewItem[];
}

export type PreviewResult =
  | ({ kind: "text" } & PreviewResultBase)
  | ({ kind: "error" } & PreviewResultBase);

export type ContextMode = "selectionOnly" | "documentBeforeSelection" | "smartContext";

export interface SelectionCheck {
  ok: boolean;
  shouldSkip: boolean;
  reason?: string;
}
