import type { WebsiteSnapshot } from './website-html.js';

export type WebsiteSourceStatus = 'available' | 'missing' | 'incompatible';
export interface WebsiteContentVersion {
  id: string; restaurant_id: string; version_number: number; summary: string; created_at: string;
  checksum: string; asset_ids: string[]; source_status: WebsiteSourceStatus;
  origin: 'generation' | 'content_refresh' | 'legacy'; base_version_id: string | null;
  public_content_hash: string | null;
}
export interface WebsiteContentDifference {
  field: 'name' | 'description' | 'cuisine' | 'address' | 'contact' | 'timezone' | 'locale' | 'currency' | 'hours' | 'menu' | 'reservation';
  label: string; before: string; after: string;
}
export interface WebsiteEditableContent {
  restaurant: Record<string, unknown>; restaurant_revision: number;
  opening_hours: { weekday: number; opens_at_local: string; closes_at_local: string; closes_day_offset: 0 | 1; accepts_requests: boolean; sort_order: number }[];
  menu: { revision: number; status: 'empty' | 'draft' | 'confirmed'; data: unknown };
}
export interface WebsiteWorkbenchReport {
  restaurant_id: string; generated_at: string;
  publication: { revision: number; published_version_id: string | null; slug: string | null; url: string | null; deployment_mode: 'local' | 'unconfigured' };
  published_version: WebsiteContentVersion | null; editing_version: WebsiteContentVersion | null;
  latest_version: WebsiteContentVersion | null;
  content: WebsiteEditableContent; current_public_content_hash: string;
  differences: WebsiteContentDifference[];
  saved_differences?: WebsiteContentDifference[];
  blockers: string[]; model_configured: boolean; ai_usage_mode: 'observation';
}
export interface WebsiteContentPreviewInput {
  base_version_id: string; expected_restaurant_revision: number; expected_menu_revision: number;
  expected_public_content_hash: string; expected_publication_revision: number;
  restaurant_patch?: Record<string, unknown>;
  opening_hours?: WebsiteEditableContent['opening_hours'];
  menu_data?: unknown; menu_review_confirmed?: true;
}
export interface WebsiteContentPreviewResult {
  version: WebsiteContentVersion; content: WebsiteEditableContent;
  public_content_hash: string; base_publication_revision: number;
  differences: WebsiteContentDifference[]; changed: boolean; ai_called: false;
  warnings: string[];
}
export interface WebsiteContentVersionPage {
  items: WebsiteContentVersion[]; has_more: boolean; next_cursor: string | null;
}
export interface WebsiteStoredSource {
  restaurant_id: string; version_id: string; base_version_id: string | null;
  origin: 'generation' | 'content_refresh'; html_body: string; css: string;
  source_checksum: string; renderer_version: string; source_schema_version: number;
  public_content_hash: string; restaurant_revision: number; menu_revision: number | null;
  source_job_id: string | null;
}
export type WebsiteRawSource = { html_body: string; css: string; summary: string };
export type WebsitePublicContentSnapshot = WebsiteSnapshot;
