import { MAX_DISTANCE_KM } from '../../app/lib/config.ts';
import { decode, distanceKm, encode } from '../../app/lib/geohash.ts';
import type { ProofBundle, Verification } from '../../app/lib/proof.ts';
import { TaskKind, type Claim, type Task } from '../../app/lib/types.ts';

export type Flag = { code: string; detail: string; weight: number };
export type Verdict = 'ok' | 'review' | 'suspicious';
export type CheckResult = { risk: number; verdict: Verdict; flags: Flag[] };

/** Earlier photos from this worker, used to spot impossible travel. */
export type PriorPhoto = { lat: number; lng: number; takenAtMs: number; taskId: string };

export type Lookups = {
  /** Other submissions (any task, any worker) that already used this photo hash. */
  reusedElsewhere: (sha256: string) => { taskId: string; worker: string }[];
  /** The worker's most recent photo before `beforeMs` on a different task. */
  previousPhoto: (worker: string, beforeMs: number, excludeTask: string) => PriorPhoto | null;
};

const MAX_TRAVEL_KMH = 150;
const CELL_SLACK_KM = 0.7; // a 6-char location cell is about 1.2 × 0.6 km

/**
 * Score a submission. Everything here is re-checked server-side because the
 * app's own checks run on the worker's phone and can be bypassed.
 */
export function assess(
  task: Task,
  claim: Claim,
  bundle: ProofBundle,
  integrity: Verification,
  lookups: Lookups,
): CheckResult {
  const flags: Flag[] = [];
  const add = (code: string, detail: string, weight: number) => flags.push({ code, detail, weight });
  const photoTask = task.kind !== TaskKind.Language;
  const target = decode(task.locationCell);

  // 1. Integrity: the decrypted proof must match what was committed on-chain.
  for (const p of integrity.problems) add('integrity', p, 100);

  // 2. Photos present
  if (photoTask && bundle.photos.length === 0) add('no_photos', 'No photos in a photo task', 40);

  for (const [i, p] of bundle.photos.entries()) {
    const n = i + 1;
    // 3. Location
    const km = distanceKm(p, target);
    if (km > MAX_DISTANCE_KM) add('too_far', `Photo ${n} taken ${km.toFixed(2)} km from the task area`, 60);
    else if (km > CELL_SLACK_KM) add('far', `Photo ${n} taken ${km.toFixed(2)} km from the task area centre`, 15);
    if (p.accuracyM > 100) add('weak_gps', `Photo ${n} GPS accuracy only ±${Math.round(p.accuracyM)} m`, 10);

    // 4. Timing: photos must be taken between claiming and submitting.
    if (p.takenAtMs < claim.claimedAtMs - 60_000) {
      add('photo_before_claim', `Photo ${n} is timestamped before the task was claimed`, 50);
    }
    if (claim.submittedAtMs && p.takenAtMs > claim.submittedAtMs + 120_000) {
      add('photo_after_submit', `Photo ${n} is timestamped after submission (clock tampering?)`, 50);
    }

    // 5. Reused photos
    const reused = lookups.reusedElsewhere(p.sha256);
    if (reused.length) {
      const where = reused[0];
      const detail =
        where.taskId === task.id
          ? `Photo ${n} is identical to one another worker submitted for this task`
          : `Photo ${n} was already submitted for another task (${where.taskId.slice(0, 10)}…)`;
      add('reused_photo', detail, 80);
    }
  }

  // 6. Photos spread out implausibly for one visit
  for (let i = 0; i < bundle.photos.length; i++) {
    for (let j = i + 1; j < bundle.photos.length; j++) {
      const km = distanceKm(bundle.photos[i], bundle.photos[j]);
      if (km > 0.5) {
        add('photos_spread', `Photos ${i + 1} and ${j + 1} are ${km.toFixed(2)} km apart`, 20);
        i = bundle.photos.length; // report once
        break;
      }
    }
  }

  // 7. On-chain capture cell should match the photos
  if (bundle.photos[0] && claim.capturedCell) {
    const cell = encode(bundle.photos[0].lat, bundle.photos[0].lng, 6);
    if (cell !== claim.capturedCell) add('cell_mismatch', 'On-chain capture area differs from the photo location', 30);
  }

  // 8. Impossible travel since the worker's previous job
  const first = [...bundle.photos].sort((a, b) => a.takenAtMs - b.takenAtMs)[0];
  if (first) {
    const prev = lookups.previousPhoto(claim.worker, first.takenAtMs, task.id);
    if (prev) {
      const hours = Math.max((first.takenAtMs - prev.takenAtMs) / 3_600_000, 1 / 3600);
      const km = distanceKm(prev, first);
      const speed = km / hours;
      if (km > 2 && speed > MAX_TRAVEL_KMH) {
        add('impossible_travel', `Moved ${km.toFixed(1)} km in ${(hours * 60).toFixed(0)} min since the previous job`, 50);
      }
    }
  }

  // 9. Suspiciously fast for an on-site task
  if (photoTask && claim.submittedAtMs && claim.submittedAtMs - claim.claimedAtMs < 60_000) {
    add('too_fast', 'Submitted less than a minute after claiming', 15);
  }

  // 10. Missing key answers
  if (task.kind === TaskKind.BusinessCheck && !bundle.answers.exists) add('missing_answer', 'Did not say if the business exists', 15);
  if (task.kind === TaskKind.PricePhoto && !bundle.answers.prices?.trim()) add('missing_answer', 'No prices entered', 15);
  if (task.kind === TaskKind.Language && !bundle.answers.answer?.trim()) add('missing_answer', 'Empty answer', 40);

  const risk = Math.min(100, flags.reduce((s, f) => s + f.weight, 0));
  const verdict: Verdict = risk >= 60 ? 'suspicious' : risk >= 25 ? 'review' : 'ok';
  return { risk, verdict, flags };
}
