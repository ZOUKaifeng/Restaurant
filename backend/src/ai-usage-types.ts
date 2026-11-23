export type AiFeature = 'menu_recognition' | 'website_chat' | 'website_generate';
export type AiOrigin = 'live' | 'legacy_import';
export type AiTokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export interface AiCallIdentity {
  requestingUserId: string; restaurantId: string;
  websiteJobId?: string; menuJobId?: string;
  runnerToken: string; callIndex: number;
}
export interface AiCallStart extends AiCallIdentity { model: string }
export interface AiCallFinish extends AiCallIdentity {
  status: 'completed' | 'failed'; usage?: AiTokenUsage | null;
  elapsedMs: number; errorCode?: string;
}
export interface AiCallTotals {
  calls: number; known_usage_calls: number; unknown_usage_calls: number; pending_calls: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
}
export interface AiUsageFilters {
  restaurant_id: string | null; feature: AiFeature | null; origin: AiOrigin | null;
  from: string | null; to: string | null;
}
export interface AiCreditPeriod {
  id: string; starts_at: string; ends_at: string; granted_at: string;
  timezone: 'UTC'; origin: 'development_test'; tokens_per_credit: 100; auto_renew: false;
}
export type AiQuotaView =
  | { configured: false; enforced: false; available_tokens: null; granted_tokens: null; reserved_tokens: null; consumed_tokens: null; period?: undefined }
  | { configured: true; enforced: false; available_tokens: number; granted_tokens: number; reserved_tokens: number; consumed_tokens: number; period: AiCreditPeriod };
export interface AiUsageReport {
  mode: 'observation'; policy_version: 'observation-v1'; generated_at: string;
  billing_account: { id: string; status: 'active' | 'suspended' | 'closed' } | null;
  quota: AiQuotaView;
  filters: AiUsageFilters; account_totals: AiCallTotals; filtered_totals: AiCallTotals;
  by_feature: Array<{ feature: AiFeature } & AiCallTotals>;
  calendar_month_totals?: { period_id: string; totals: AiCallTotals };
  legacy: { aggregate_jobs: number; known_total_tokens: number; unknown_usage_jobs: number };
}
export interface AiUsageCall {
  id: string; restaurant_id: string; restaurant_name: string | null;
  job_id: string; feature: AiFeature; model: string; provider: 'deepseek';
  call_index: number; call_status: 'started' | 'completed' | 'failed';
  usage_status: 'pending' | 'known' | 'unknown'; origin: AiOrigin; chargeable: false;
  prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null;
  elapsed_ms: number | null; error_code: string | null; created_at: string; finished_at: string | null;
}
export interface AiUsageCalls { filters: AiUsageFilters; items: AiUsageCall[]; next_cursor: string | null }
