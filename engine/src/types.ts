export type Block =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean; images?: { mediaType: string; data: string }[] };

export interface Msg {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelTurn {
  blocks: Block[];
  stopReason: "end" | "tool_use" | "max_tokens" | "error";
  usage?: { input?: number; output?: number };
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}
