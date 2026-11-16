import { COIN_DECIMALS, COIN_SYMBOL } from '@/lib/config';

export function formatAmount(raw: bigint): string {
  const base = BigInt(10) ** BigInt(COIN_DECIMALS);
  const whole = raw / base;
  const cents = ((raw % base) * BigInt(100)) / base;
  return `${whole}.${cents.toString().padStart(2, '0')} ${COIN_SYMBOL}`;
}

export function formatKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

export function formatTimeLeft(deadlineMs: number): string {
  const mins = Math.max(0, Math.round((deadlineMs - Date.now()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
