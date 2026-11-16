import { COIN_DECIMALS } from './config';
import { encode, isValid } from './geohash';
import type { NewTask } from './tx';
import { TaskKind } from './types';

/**
 * Accepts "lat, lng", a Google Maps link (…/@-1.2676,36.8108,17z or ?q=-1.26,36.81),
 * or a 6+ character geohash. Returns the 6-character location cell stored on-chain.
 */
export function parseLocation(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, // maps URL with @lat,lng
    /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i,
    /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/, // plain "lat, lng"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return encode(lat, lng, 6);
    }
  }
  if (/^[0-9a-z]{6,12}$/i.test(text) && isValid(text)) return text.slice(0, 6).toLowerCase();
  return null;
}

/** "2.50" USDC -> 2_500_000 base units. */
export function toBaseUnits(amount: string): bigint | null {
  const m = amount.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, COIN_DECIMALS).padEnd(COIN_DECIMALS, '0');
  return BigInt(m[1]) * BigInt(10) ** BigInt(COIN_DECIMALS) + BigInt(frac || '0');
}

const KIND_NAMES: Record<string, number> = {
  '0': TaskKind.BusinessCheck,
  business_check: TaskKind.BusinessCheck,
  business: TaskKind.BusinessCheck,
  '1': TaskKind.PricePhoto,
  price_photo: TaskKind.PricePhoto,
  price: TaskKind.PricePhoto,
  '2': TaskKind.Language,
  language: TaskKind.Language,
};

export const KIND_LABELS = ['Business check', 'Price photo', 'Language task'];

export const CSV_TEMPLATE =
  'kind,location,reward_usdc,workers,hours,instructions\n' +
  'business_check,"-1.2676, 36.8108",2.00,1,48,"Confirm the shop exists. Photograph the sign, front and inside. Note opening hours."\n' +
  'price_photo,"-1.2833, 36.8219",0.80,3,24,"Photograph the prices of bread, milk, sugar and maize flour."\n';

/** Minimal CSV parser that handles quoted fields with commas and "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export type CsvResult = { tasks: NewTask[]; errors: string[] };

export function tasksFromCsv(text: string, now = Date.now()): CsvResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const tasks: NewTask[] = [];
  if (rows.length === 0) return { tasks, errors: ['The file is empty'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const need = ['kind', 'location', 'reward_usdc', 'workers', 'hours', 'instructions'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) return { tasks, errors: [`Missing columns: ${missing.join(', ')}`] };

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (name: string) => (r[col(name)] ?? '').trim();
    const kind = KIND_NAMES[get('kind').toLowerCase()];
    const cell = parseLocation(get('location'));
    const reward = toBaseUnits(get('reward_usdc'));
    const slots = Number(get('workers'));
    const hours = Number(get('hours'));
    const instructions = get('instructions');
    const problems = [
      kind === undefined && 'unknown kind',
      !cell && 'bad location',
      (!reward || reward <= BigInt(0)) && 'bad reward',
      (!Number.isInteger(slots) || slots < 1 || slots > 50) && 'workers must be 1–50',
      (!(hours > 0) || hours > 24 * 90) && 'hours must be 1–2160',
      !instructions && 'instructions missing',
    ].filter(Boolean);
    if (problems.length) errors.push(`Row ${line}: ${problems.join(', ')}`);
    else
      tasks.push({
        kind: kind!,
        locationCell: cell!,
        instructions,
        reward: reward!,
        slots,
        deadlineMs: now + hours * 3_600_000,
      });
  });
  return { tasks, errors };
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((v) => csvEscape(String(v))).join(',')).join('\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
