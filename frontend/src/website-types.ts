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
export interface WebsiteJob {
  id: string;
  kind: 'chat' | 'generate';
  status: WebsiteJobStatus;
  error_code: string | null;
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
  expected_restaurant_revision: number;
  expected_menu_revision?: number;
}
export interface WebsitePublishInput { version_id: string; slug?: string; expected_revision: number }
export interface WebsitePreviewAsset { id: string; content_url: string; mime_type: AssetMime }
export interface WebsitePreview { html: string; assets: WebsitePreviewAsset[]; checksum: string }
export type WebsiteAttempt =
  | { kind: 'chat'; key: string; body: WebsiteMessageInput }
  | { kind: 'generate'; key: string; body: WebsiteGenerateInput }
  | { kind: 'publish'; key: string; body: WebsitePublishInput };
