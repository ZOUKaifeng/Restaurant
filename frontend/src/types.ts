export interface ApiErrorBody {
  code: string;
  message: string;
  request_id: string;
  details: Array<{ field: string; code: string }>;
}

export interface Accepted { message: string }
export interface RegistrationPolicy {
  terms_version: string;
  terms_url: string;
  privacy_notice_version: string;
  privacy_url: string;
  supported_locales: string[];
  password_min_length: 15;
  password_max_length: 128;
}
export interface CsrfResponse { csrf_token: string; expires_at: string }
export interface CurrentUser {
  id: string;
  email: string;
  display_name: string | null;
  locale: string;
  status: 'active';
  email_verified_at: string;
  created_at: string;
}
export interface SessionView { user: CurrentUser; session_expires_at: string }
export interface LoginResponse extends SessionView { csrf_token: string }
export interface RegisterInput {
  email: string;
  password: string;
  display_name?: string;
  locale: string;
  terms_version: string;
  accepted_terms: true;
}
export interface EmailInput { email: string }
export interface ActionTokenInput { token: string }
export interface VerifyEmailInput extends ActionTokenInput { continue_session?: boolean }
export interface LoginInput extends EmailInput { password: string }
export interface LogoutAllInput { current_password: string }
export interface ResetPasswordInput extends ActionTokenInput { new_password: string }

export interface RestaurantProfile {
  name: string;
  description: string | null;
  cuisine_label: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  contact_email: string | null;
  phone: string | null;
  timezone: string | null;
  currency_code: string | null;
  primary_locale: string;
}
export type RestaurantCreateInput = Pick<RestaurantProfile, 'name' | 'primary_locale'> & Partial<Omit<RestaurantProfile, 'name' | 'primary_locale'>>;
export type RestaurantPatchInput = Partial<RestaurantProfile>;
export interface Readiness { ready_for_publication: boolean; missing_fields: string[] }
export interface Restaurant extends RestaurantProfile {
  id: string;
  slug: string;
  status: 'draft' | 'active' | 'suspended' | 'archived';
  reservation_enabled: boolean;
  revision: number;
  role: 'owner';
  created_at: string;
  updated_at: string;
  readiness: Readiness;
}
export interface RestaurantList {
  items: Restaurant[];
  next_cursor: string | null;
  has_more: boolean;
}
export interface OpeningInterval {
  weekday: number;
  opens_at_local: string;
  closes_at_local: string;
  closes_day_offset: 0 | 1;
  accepts_requests: boolean;
  sort_order: number;
}
export interface OpeningHoursInput { intervals: OpeningInterval[] }
export interface OpeningHoursView extends OpeningHoursInput {
  restaurant_id: string;
  restaurant_revision: number;
  timezone: string | null;
}
export interface Versioned<T> { data: T; etag: string }
