import type { AiCreditPeriod } from './ai-usage-types.js';

export type BillingPlanCode = 'maintain' | 'build' | 'unlimited';
export type BillingInterval = 'month' | 'year';
export interface BillingPrice {
  id: string; interval: BillingInterval; amount_minor: number; currency: 'USD'; status: 'draft' | 'active' | 'retired';
}
export interface BillingPlan {
  id: string; code: BillingPlanCode; name: string; version: number; status: 'draft' | 'active' | 'retired';
  ai: { mode: 'limited' | 'unlimited'; monthly_credits: number | null; tokens_per_credit: number; allocation_status: 'proposed' | 'confirmed'; grant_schedule: 'unconfirmed' | 'service_month' };
  hosted_site_limit: number | null; prices: BillingPrice[];
}
export interface BillingCreditPack {
  id: string; name: string; credits: number; amount_minor: number; currency: 'USD'; tokens_per_credit: number;
  validity_days: number | null; validity_policy: 'unconfirmed' | 'days' | 'never_expires'; status: 'draft' | 'active' | 'retired';
}
export interface BillingCatalog {
  schema_version: 'billing-catalog-v1'; billing_model: 'subscription_with_credit_addons'; currency: 'USD';
  payment_enabled: false; plans: BillingPlan[]; credit_packs: BillingCreditPack[];
  addons_status: 'not_configured' | 'draft';
  seed_offer: { plan_code: 'unlimited'; amount_minor: 3990; interval: 'month'; requires_approval: true; duration_status: 'unconfirmed'; purchasable: false };
}
export interface BillingSubscriptionView {
  id: string; plan_id: string; plan_code: BillingPlanCode; plan_name: string; price_id: string;
  interval: BillingInterval; amount_minor: number; currency: 'USD';
  status: 'incomplete' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'expired';
  period_start: string | null; period_end: string | null; paid_through: string | null;
  cancel_requested_at: string | null; revision: number;
}
export interface BillingOverview {
  schema_version: 'billing-overview-v1'; mode: 'observation'; payment_enabled: false;
  account: { id: string; status: 'active' | 'suspended' | 'closed' } | null;
  subscription: BillingSubscriptionView | null;
  seed_eligibility: 'not_granted' | 'pending' | 'approved' | 'ended';
  credits:
    | { status: 'not_configured'; enforced: false; available: null; reserved: null; consumed: null }
    | { status: 'development_test'; enforced: false; available: number; reserved: number; consumed: number; granted: number; period: AiCreditPeriod };
  addons_status: 'not_configured' | 'draft'; generated_at: string;
}
