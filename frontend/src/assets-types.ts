export type AssetKind = 'menu_source' | 'logo' | 'restaurant_photo' | 'dish_photo';
export type AssetMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export type AssetStorageMode = 'local' | 's3';

export interface Asset {
  id: string;
  restaurant_id: string;
  kind: AssetKind;
  origin: 'upload';
  original_filename: string;
  mime_type: AssetMime;
  size_bytes: number;
  checksum: string;
  width_px: number | null;
  height_px: number | null;
  alt_text: string | null;
  rights_confirmed_at: string;
  safety_status: 'approved';
  status: 'ready' | 'deleted';
  revision: number;
  created_at: string;
  updated_at: string;
  can_delete: boolean;
  content_url: string;
}

export interface AssetList {
  items: Asset[];
  next_cursor: string | null;
  has_more: boolean;
  storage_mode: AssetStorageMode;
}

export interface AssetUploadAttempt {
  file: File;
  kind: AssetKind;
  rights: true;
  key: string;
}
