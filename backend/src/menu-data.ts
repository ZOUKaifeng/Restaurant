import { ApiError } from './errors.js';
import type { AiTokenUsage } from './ai-usage-types.js';

export interface MenuItemData { name: string; description: string | null; price_text: string | null; review_note: string | null }
export interface MenuCategoryData { name: string; items: MenuItemData[] }
export interface MenuData { categories: MenuCategoryData[]; warnings: string[] }
export interface ConfirmedMenuSnapshot { revision: number; data: MenuData }
export interface MenuImageInput { bytes: Buffer; mime_type: 'image/jpeg' | 'image/png' }
export interface MenuRecognitionOutput { data: MenuData; model: string; usage: AiTokenUsage | null }

export function normalizeMenuData(value: unknown, modelOutput = false): MenuData {
  const fail = (): never => { throw new ApiError(modelOutput ? 503 : 422, modelOutput ? 'AI_OUTPUT_INVALID' : 'MENU_DATA_INVALID'); };
  const obj = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
    const data = input as Record<string, unknown>;
    if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) fail();
    return data;
  };
  const text = (input: unknown, max: number, nullable = false): string | null => {
    if (input === null && nullable) return null;
    if (typeof input !== 'string' || !input.trim() || Array.from(input).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input)) fail();
    return input as string;
  };
  const input = obj(value, ['categories', 'warnings']);
  if (!Array.isArray(input.categories) || input.categories.length > 20 || !Array.isArray(input.warnings) || input.warnings.length > 20) fail();
  let count = 0;
  const categories = (input.categories as unknown[]).map(category => {
    const data = obj(category, ['name', 'items']);
    if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > 80) fail();
    const items = (data.items as unknown[]).map(item => {
      if (++count > 80) fail();
      const row = obj(item, ['name', 'description', 'price_text', 'review_note']);
      return { name: text(row.name, 200)!, description: text(row.description, 1000, true), price_text: text(row.price_text, 80, true), review_note: text(row.review_note, 500, true) };
    });
    return { name: text(data.name, 150)!, items };
  });
  return { categories, warnings: (input.warnings as unknown[]).map(item => text(item, 500)!) };
}
