export interface Bot {
  id: string; name: string; emoji: string; color: string; persona: string; providerId: string | null; model: string | null;
  approvalMode: "ask-risky" | "ask-all" | "auto"; tools: { web: boolean; browser: boolean; apps: boolean; phone: boolean };
  skills: string[]; pinned: boolean; hidden: boolean; unread: number; busy?: boolean; last?: Msg | null; lastMessageAt?: string;
}
export interface Msg {
  id: string; role: "user" | "assistant" | "tool" | "note"; text: string; at: string; source?: string;
  status?: string; tool?: { name: string; input?: unknown; result?: string; isError?: boolean; status: string };
}
export interface Card { id: string; kind: "approval" | "question"; botId: string; title: string; detail: string; tool?: string; options?: string[] }
export interface Provider {
  id: string; label: string; kind: string; baseUrl?: string; defaultModel: string; models: string[]; runOn?: string; computerUrl?: string;
  enabled: boolean; needsKey: boolean; hasKey: boolean; note?: string; free?: boolean; subId?: string;
}
