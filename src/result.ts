export const MAX_OUTPUT_LENGTH = 50 * 1024;
const TRUNCATION_MARKER = "\n\n... (output truncated)";

export interface PiTextToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown> & {
    tool?: string;
    projectRoot?: string;
    value?: string;
    error?: string;
    truncated?: boolean;
  };
}

export function truncateOutput(text: string, maxLength = MAX_OUTPUT_LENGTH): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }

  const truncated = text.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxLength * 0.8 ? lastNewline : maxLength;

  return {
    text: truncated.slice(0, cutPoint) + TRUNCATION_MARKER,
    truncated: true,
  };
}

export function textResult(text: string, details: Record<string, unknown> = {}): PiTextToolResult {
  const visible = truncateOutput(text);
  return {
    content: [{ type: "text", text: visible.text }],
    details: {
      ...details,
      value: visible.text,
      truncated: visible.truncated,
    },
  };
}

export function errorResult(message: string, details: Record<string, unknown> = {}): PiTextToolResult {
  const visible = truncateOutput(`CodeGraph error: ${message}`);
  return {
    content: [{ type: "text", text: visible.text }],
    isError: true,
    details: {
      ...details,
      error: visible.text,
      value: visible.text,
      truncated: visible.truncated,
    },
  };
}
