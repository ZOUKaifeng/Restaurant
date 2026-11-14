import type { WebsiteOutput } from './deepseek.js';
export interface WebsiteDiagnostic { file: 'index.html' | 'styles.css' | 'assets' | 'agent'; line: number; column: number; code: string; message: string }
export interface WebsitePlanItem { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }
export interface WebsiteAgentProgress { phase: 'planning' | 'writing' | 'checking' | 'repairing' | 'ready' | 'failed'; round: number; model_calls: number; total_tokens: number; prompt_tokens?: number; completion_tokens?: number; elapsed_ms?: number; plan: WebsitePlanItem[]; diagnostics: WebsiteDiagnostic[] }
export interface WebsiteAgentEvent { action: string; status: 'ok' | 'error'; round: number; message: string; diagnostics: WebsiteDiagnostic[]; model_call?: { index: number; prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null; elapsed_ms: number; status: 'started' | 'completed' | 'failed'; error_code?: string } }
export interface WebsiteAgentObservation { progress: WebsiteAgentProgress; event: WebsiteAgentEvent; draft?: Pick<WebsiteOutput, 'html_body' | 'css' | 'summary'> }
export interface WebsiteToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type WebsiteToolMessage = { role: 'system' | 'user'; content: string } | { role: 'assistant'; content: string | null; tool_calls: WebsiteToolCall[] } | { role: 'tool'; tool_call_id: string; content: string };
export interface WebsiteToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface WebsiteToolExchange { message: { role: 'assistant'; content: string | null; tool_calls: WebsiteToolCall[] }; usage: WebsiteOutput['usage'] }
export interface WebsiteAgentResult extends WebsiteOutput { html: string; checksum: string; progress: WebsiteAgentProgress }
