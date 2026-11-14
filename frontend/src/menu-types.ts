export interface MenuItem {
  name: string;
  description: string | null;
  price_text: string | null;
  review_note: string | null;
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface MenuData {
  categories: MenuCategory[];
  warnings: string[];
}

export interface MenuDraft {
  revision: number;
  status: 'empty' | 'draft' | 'confirmed';
  data: MenuData;
  source_asset_ids: string[];
  confirmed_at: string | null;
}

export interface MenuJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error_code: string | null;
  created_at: string;
  result_revision: number | null;
}

export interface MenuState {
  draft: MenuDraft | null;
  jobs: MenuJob[];
  model: string;
  model_configured: boolean;
  input_mode: 'vision';
  pdf_supported: false;
}

export interface MenuRecognitionInput {
  asset_ids: string[];
  consent_to_ai_processing: true;
  expected_revision: number;
}

export interface MenuRecognitionAttempt {
  key: string;
  body: MenuRecognitionInput;
}

export interface MenuAccepted {
  job_id: string;
  status: MenuJob['status'];
}

export interface MenuPatchInput {
  data: MenuData;
  expected_revision: number;
}

export interface MenuConfirmInput {
  expected_revision: number;
  confirmed: true;
}
