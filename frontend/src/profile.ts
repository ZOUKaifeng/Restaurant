import type { RestaurantProfile, RestaurantPatchInput } from './types';

type ProfileField = {
  key: keyof RestaurantProfile;
  label: string;
  maxLength: number;
  group: 'basic' | 'address' | 'contact';
  type?: 'email' | 'tel';
  pattern?: string;
  hint?: string;
};
export const profileFields: ProfileField[] = [
  { key: 'name', label: '餐厅名称', maxLength: 150, group: 'basic' },
  { key: 'description', label: '餐厅简介', maxLength: 2000, group: 'basic' },
  { key: 'cuisine_label', label: '菜系', maxLength: 100, group: 'basic' },
  { key: 'primary_locale', label: '餐厅主要语言', maxLength: 35, group: 'basic', pattern: '[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*' },
  { key: 'country_code', label: '国家代码', maxLength: 2, group: 'address', pattern: '[A-Z]{2}', hint: '两位大写 ISO 国家代码。' },
  { key: 'region', label: '地区', maxLength: 100, group: 'address' },
  { key: 'city', label: '城市', maxLength: 100, group: 'address' },
  { key: 'address_line1', label: '地址第一行', maxLength: 200, group: 'address' },
  { key: 'address_line2', label: '地址第二行', maxLength: 200, group: 'address' },
  { key: 'postal_code', label: '邮政编码', maxLength: 32, group: 'address' },
  { key: 'contact_email', label: '联系邮箱', maxLength: 254, group: 'contact', type: 'email' },
  { key: 'phone', label: '联系电话', maxLength: 16, group: 'contact', type: 'tel', pattern: '\\+[1-9][0-9]{6,14}', hint: '国际格式，包含 + 和国家区号。' },
  { key: 'timezone', label: '时区', maxLength: 64, group: 'contact', hint: '真实 IANA 时区，例如 Asia/Shanghai、Europe/London，或 UTC。保存时由服务端验证。' },
  { key: 'currency_code', label: '币种代码', maxLength: 3, group: 'contact', pattern: '[A-Z]{3}', hint: '三位大写 ISO 币种代码；实际支持范围由服务端验证。' },
];
export type ProfileDraft = { [K in keyof RestaurantProfile]: string };
export function toProfileDraft(profile: RestaurantProfile): ProfileDraft {
  return Object.fromEntries(profileFields.map(({ key }) => [key, profile[key] ?? ''])) as ProfileDraft;
}
export function profilePatch(draft: ProfileDraft, original: RestaurantProfile): RestaurantPatchInput {
  const patch: RestaurantPatchInput = {};
  for (const { key } of profileFields) {
    if (draft[key] === (original[key] ?? '')) continue;
    const value = draft[key].trim();
    if (key === 'name' || key === 'primary_locale') patch[key] = value;
    else patch[key] = value === '' ? null : value;
  }
  return patch;
}
