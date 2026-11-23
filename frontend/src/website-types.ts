import type { AssetMime } from './assets-types';

export interface WebsiteAgent {
  id: string | null;
  revision: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  design_brief: string;
}
export interface WebsiteVersion {
  id: string;
  restaurant_id: string;
  version_number: number;
  summary: string;
  created_at: string;
  checksum: string;
  asset_ids: string[];
}
export type WebsiteJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface WebsiteDiagnostic {
  file: 'index.html' | 'styles.css' | 'assets' | 'agent';
  line: number;
  column: number;
  code: string;
  message: string;
}
export interface WebsiteProgress {
  phase: 'planning' | 'writing' | 'checking' | 'repairing' | 'ready' | 'failed';
  round: number;
  model_calls: number;
  total_tokens: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  elapsed_ms?: number;
  plan: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>;
  diagnostics: WebsiteDiagnostic[];
}
export interface WebsiteModelCall {
  index: number;
  status: 'started' | 'completed' | 'failed';
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  elapsed_ms: number | null;
  error_code?: string | null;
}
export interface WebsiteUsage {
  job_id: string;
  calls: Array<WebsiteModelCall & { error_code: string | null }>;
  totals: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  unknown_usage_calls: number;
  legacy_summary?: {
    model_calls: number;
    total_tokens: number | null;
    prompt_tokens: null;
    completion_tokens: null;
  };
}
export interface WebsiteCancelInput { confirmed: true }
export interface WebsiteCancelled { job_id: string; status: 'failed' }
export interface WebsiteTrace {
  action: string;
  status: 'ok' | 'error';
  round: number;
  message: string;
  diagnostics: WebsiteDiagnostic[];
  model_call?: WebsiteModelCall;
}
export interface WebsiteJob {
  id: string;
  kind: 'chat' | 'generate';
  status: WebsiteJobStatus;
  error_code: string | null;
  progress?: WebsiteProgress | null;
  trace?: WebsiteTrace[];
  result_version_id: string | null;
  created_at: string;
}
export interface WebsitePublication {
  revision: number;
  published_version_id: string | null;
  slug: string | null;
  url: string | null;
  deployment_mode: 'local' | 'unconfigured';
}
export interface WebsiteState {
  agent: WebsiteAgent;
  versions: WebsiteVersion[];
  jobs: WebsiteJob[];
  publication: WebsitePublication;
  model: string;
  model_configured: boolean;
  menu_recognition_enabled: true;
  menu: { revision: number; status: 'empty' | 'draft' | 'confirmed'; item_count: number };
}
export interface WebsiteAccepted { job_id: string; status: WebsiteJobStatus }
export interface WebsiteMessageInput { message: string; expected_revision: number }
export interface WebsiteGenerateInput {
  brief: string;
  asset_ids: string[];
  public_assets_confirmed: true;
  image_vision_confirmed?: true;
  expected_restaurant_revision: number;
  expected_menu_revision?: number;
}
export interface WebsitePublishInput {
  version_id: string; slug?: string; expected_revision: number;
  expected_checksum?: string; expected_public_content_hash?: string;
  content_mode?: 'current' | 'historical'; review_confirmed?: true;
}
export interface WebsiteContentVersion extends WebsiteVersion {
  source_status: 'available' | 'missing' | 'incompatible';
  origin: 'generation' | 'content_refresh' | 'legacy';
  base_version_id: string | null; public_content_hash: string | null;
}
export interface WebsiteEditableContent {
  restaurant: import('./types').RestaurantProfile;
  restaurant_revision: number;
  opening_hours: import('./types').OpeningInterval[];
  menu: { revision: number; status: 'empty' | 'draft' | 'confirmed'; data: import('./menu-types').MenuData };
}
export interface WebsiteContentDifference {
  field: 'name' | 'description' | 'cuisine' | 'address' | 'contact' | 'timezone' | 'locale' | 'currency' | 'hours' | 'menu' | 'reservation';
  label: string; before: string; after: string;
}
// 前端内存中的候选版本保存差异；来自成功回执或已保存快照，不是当前事实差异。
export interface WebsiteContentReview {
  restaurant_id: string; version_id: string; version_number: number; base_version_id: string;
  checksum: string; public_content_hash: string; differences: WebsiteContentDifference[];
}
export interface WebsiteWorkbenchReport {
  restaurant_id: string; generated_at: string; publication: WebsitePublication;
  published_version: WebsiteContentVersion | null; editing_version: WebsiteContentVersion | null;
  latest_version: WebsiteContentVersion | null; content: WebsiteEditableContent;
  current_public_content_hash: string; differences: WebsiteContentDifference[];
  saved_differences?: WebsiteContentDifference[];
  blockers: string[]; model_configured: boolean; ai_usage_mode: 'observation';
}
export interface WebsiteContentPreviewInput {
  base_version_id: string; expected_restaurant_revision: number; expected_menu_revision: number;
  expected_public_content_hash: string; expected_publication_revision: number;
  restaurant_patch?: import('./types').RestaurantPatchInput;
  opening_hours?: import('./types').OpeningInterval[];
  menu_data?: import('./menu-types').MenuData; menu_review_confirmed?: true;
}
export interface WebsiteContentPreviewResult {
  version: WebsiteContentVersion; content: WebsiteEditableContent; public_content_hash: string;
  base_publication_revision: number; differences: WebsiteContentDifference[];
  changed: boolean; ai_called: false; warnings: string[];
}
export interface WebsiteContentVersionPage {
  items: WebsiteContentVersion[]; has_more: boolean; next_cursor: string | null;
}
export interface WebsitePreviewAsset { id: string; content_url: string; mime_type: AssetMime }
export interface WebsitePreview { html: string; assets: WebsitePreviewAsset[]; checksum: string }
export type WebsiteAttempt =
  | { kind: 'chat'; key: string; body: WebsiteMessageInput }
  | { kind: 'generate'; key: string; body: WebsiteGenerateInput }
  | { kind: 'publish'; key: string; body: WebsitePublishInput };
