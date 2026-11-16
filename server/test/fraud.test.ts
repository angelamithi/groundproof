import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../../app/lib/geohash.ts';
import { assess, type Lookups } from '../src/fraud.ts';

const T0 = 1_800_000_000_000;
const cell = encode(-1.2676, 36.8108, 6);
const task = { id: '0xtask', coinType: 'X', requester: '0xr', kind: 0, locationCell: cell, instructions: '', reward: 1n,
  slots: 1, approved: 0, active: 1, openSlots: 0, deadlineMs: T0 + 1e8, closed: false, claimsTableId: '0x1' };
const claim = { worker: '0xw', claimedAtMs: T0, status: 1, proofBlobId: 'b', answerHash: new Uint8Array(),
  capturedCell: cell, submittedAtMs: T0 + 20 * 60_000, rejectedAtMs: 0, fraudFlag: false, votesForWorker: 0, votesForRequester: 0 };
const photo = (o = {}) => ({ sha256: 'aa', lat: -1.2677, lng: 36.8109, accuracyM: 10, takenAtMs: T0 + 15 * 60_000, jpegBase64: '', ...o });
const bundle = (photos = [photo()], answers: Record<string, string> = { exists: 'yes' }) =>
  ({ version: 1 as const, taskId: task.id, worker: claim.worker, answers, photos, userAgent: '', createdAtMs: T0 });
const clean: Lookups = { reusedElsewhere: () => [], previousPhoto: () => null };
const ok = { ok: true, problems: [] };
const codes = (r: { flags: { code: string }[] }) => r.flags.map((f) => f.code);

test('honest on-site submission is ok', () => {
  const r = assess(task, claim, bundle(), ok, clean);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.risk, 0);
});

test('tampered proof is suspicious', () => {
  const r = assess(task, claim, bundle(), { ok: false, problems: ['Photo 1 was altered'] }, clean);
  assert.equal(r.verdict, 'suspicious');
  assert.deepEqual(codes(r), ['integrity']);
});

test('photo taken far away', () => {
  const r = assess(task, claim, bundle([photo({ lat: -1.30, lng: 36.85 })]), ok, clean);
  assert.ok(codes(r).includes('too_far'));
  assert.equal(r.verdict, 'suspicious');
});

test('reused photo from another task', () => {
  const r = assess(task, claim, bundle(), ok, { ...clean, reusedElsewhere: () => [{ taskId: '0xother', worker: '0xw2' }] });
  assert.ok(codes(r).includes('reused_photo'));
  assert.equal(r.verdict, 'suspicious');
});

test('photo older than the claim', () => {
  const r = assess(task, claim, bundle([photo({ takenAtMs: T0 - 3_600_000 })]), ok, clean);
  assert.ok(codes(r).includes('photo_before_claim'));
});

test('impossible travel since previous job', () => {
  const prev = { lat: -4.04, lng: 39.67, takenAtMs: T0, taskId: '0xprev' }; // Mombasa 15 min earlier
  const r = assess(task, claim, bundle(), ok, { ...clean, previousPhoto: () => prev });
  assert.ok(codes(r).includes('impossible_travel'));
});

test('missing photos and answers needs review', () => {
  const r = assess(task, claim, bundle([], {}), ok, clean);
  assert.ok(codes(r).includes('no_photos') && codes(r).includes('missing_answer'));
  assert.equal(r.verdict, 'review');
});

test('weak GPS alone stays ok', () => {
  const r = assess(task, claim, bundle([photo({ accuracyM: 250 })]), ok, clean);
  assert.equal(r.verdict, 'ok');
  assert.ok(codes(r).includes('weak_gps'));
});
