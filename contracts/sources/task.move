/// Ground-truth tasks with escrowed stablecoin payment.
///
/// Flow: a requester (business or AI agent) creates a `Task<T>` and locks
/// `slots * (reward + fee)` of coin `T` (e.g. USDC). Registered workers claim
/// a slot, go on site, and submit proof (a Walrus blob id of Seal-encrypted
/// photos plus a hash of their answers). The requester approves (worker paid,
/// platform fee to treasury) or rejects (slot freed). If the requester stays
/// silent, the worker can force payment after the auto-release window.
///
/// Fair rejections: a rejection is held for a dispute window. The worker can
/// accept it, let the window pass, or open a dispute that trusted verifiers
/// settle by vote. Strikes only count once a rejection is final.
module groundproof::task;

use groundproof::config::{Self, Config};
use groundproof::reputation::Registry;
use std::string::String;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

// === Errors ===
const EZeroReward: u64 = 300;
const EZeroSlots: u64 = 301;
const EWrongPayment: u64 = 302;
const EDeadlinePassed: u64 = 303;
const ETaskClosed: u64 = 304;
const ENoOpenSlot: u64 = 305;
const EAlreadyClaimed: u64 = 306;
const ENotClaimer: u64 = 307;
const EWrongStatus: u64 = 308;
const EClaimExpired: u64 = 309;
const ENotRequester: u64 = 310;
const ETooEarly: u64 = 311;
const ERequesterCannotWork: u64 = 312;
const ENoAccess: u64 = 313;
const EDisputeWindowClosed: u64 = 315;
const EAlreadyVoted: u64 = 316;
const EConflictedVoter: u64 = 317;

// === Task kinds (extend freely) ===
const KIND_BUSINESS_CHECK: u8 = 0;
const KIND_PRICE_PHOTO: u8 = 1;
const KIND_LANGUAGE: u8 = 2;
const KIND_MAX: u8 = 2;
const EBadKind: u64 = 314;

// === Claim statuses ===
const CLAIMED: u8 = 0;
const SUBMITTED: u8 = 1;
const APPROVED: u8 = 2;
const REJECTED: u8 = 3;
const EXPIRED: u8 = 4;
/// Rejected by the requester; worker may still dispute.
const PENDING_REJECTION: u8 = 5;
/// Worker disputed; waiting for verifier votes.
const DISPUTED: u8 = 6;

public struct Claim has store, drop {
    claimed_at_ms: u64,
    status: u8,
    /// Walrus blob id of the (Seal-encrypted) proof bundle.
    proof_blob_id: String,
    /// sha256 of the structured answers (prices, yes/no, text).
    answer_hash: vector<u8>,
    /// Coarse location cell where the proof was captured (e.g. geohash-6).
    captured_cell: String,
    submitted_at_ms: u64,
    rejected_at_ms: u64,
    fraud_flag: bool,
    votes_for_worker: u64,
    votes_for_requester: u64,
    voters: vector<address>,
}

public struct Task<phantom T> has key {
    id: UID,
    requester: address,
    kind: u8,
    /// Coarse target location, e.g. a 6-character geohash (~1 km).
    location_cell: String,
    /// Walrus blob id (or URL) of the full instructions.
    instructions: String,
    reward: u64,
    fee: u64,
    slots: u64,
    approved: u64,
    /// Claims not yet paid or finally rejected; they reserve escrow.
    active: u64,
    deadline_ms: u64,
    closed: bool,
    escrow: Balance<T>,
    claims: Table<address, Claim>,
}

// === Events ===
public struct TaskCreated has copy, drop {
    task_id: ID,
    requester: address,
    kind: u8,
    location_cell: String,
    reward: u64,
    slots: u64,
    deadline_ms: u64,
}

public struct TaskClaimed has copy, drop { task_id: ID, worker: address }

public struct ProofSubmitted has copy, drop {
    task_id: ID,
    worker: address,
    proof_blob_id: String,
    answer_hash: vector<u8>,
    captured_cell: String,
}

public struct TaskPaid has copy, drop {
    task_id: ID,
    worker: address,
    reward: u64,
    fee: u64,
    auto_released: bool,
}

public struct SubmissionRejected has copy, drop { task_id: ID, worker: address, fraud: bool }

public struct RejectionFinal has copy, drop { task_id: ID, worker: address, fraud: bool }

public struct DisputeOpened has copy, drop { task_id: ID, worker: address }

public struct DisputeVote has copy, drop {
    task_id: ID,
    worker: address,
    verifier: address,
    for_worker: bool,
}

public struct DisputeResolved has copy, drop { task_id: ID, worker: address, worker_won: bool }

public struct ClaimExpired has copy, drop { task_id: ID, worker: address }

public struct TaskClosed has copy, drop { task_id: ID, refunded: u64 }

// === Requester actions ===

/// Create a task and lock its full budget. `payment` must equal
/// `slots * (reward + fee)` where fee comes from `Config`.
public fun create<T>(
    config: &Config,
    payment: Coin<T>,
    kind: u8,
    location_cell: String,
    instructions: String,
    reward: u64,
    slots: u64,
    deadline_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    config.assert_not_paused();
    assert!(kind <= KIND_MAX, EBadKind);
    assert!(reward > 0, EZeroReward);
    assert!(slots > 0, EZeroSlots);
    assert!(deadline_ms > clock.timestamp_ms(), EDeadlinePassed);
    let fee = config.fee_for(reward);
    assert!(payment.value() == slots * (reward + fee), EWrongPayment);

    let task = Task<T> {
        id: object::new(ctx),
        requester: ctx.sender(),
        kind,
        location_cell,
        instructions,
        reward,
        fee,
        slots,
        approved: 0,
        active: 0,
        deadline_ms,
        closed: false,
        escrow: payment.into_balance(),
        claims: table::new(ctx),
    };
    let task_id = object::id(&task);
    event::emit(TaskCreated {
        task_id,
        requester: task.requester,
        kind,
        location_cell: task.location_cell,
        reward,
        slots,
        deadline_ms,
    });
    transfer::share_object(task);
    task_id
}

/// Approve a submission: pay the worker, send the fee to the treasury.
public fun approve<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &mut Registry,
    worker: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == task.requester, ENotRequester);
    // The requester may also change their mind on a rejection or dispute.
    let status = claim_mut(task, worker).status;
    assert!(
        status == SUBMITTED || status == PENDING_REJECTION || status == DISPUTED,
        EWrongStatus,
    );
    pay(task, config, registry, worker, false, ctx);
}

/// Reject a submission. `fraud = true` asks for a strike against the worker.
/// The rejection is held for the dispute window before it becomes final, and
/// the slot's money stays reserved until then.
public fun reject<T>(
    task: &mut Task<T>,
    worker: address,
    fraud: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == task.requester, ENotRequester);
    let now = clock.timestamp_ms();
    let task_id = object::id(task);
    let claim = claim_mut(task, worker);
    assert!(claim.status == SUBMITTED, EWrongStatus);
    claim.status = PENDING_REJECTION;
    claim.rejected_at_ms = now;
    claim.fraud_flag = fraud;
    event::emit(SubmissionRejected { task_id, worker, fraud });
}

/// Stop accepting new claims and refund everything not reserved by
/// active claims. Callable by the requester at any time.
public fun close<T>(task: &mut Task<T>, ctx: &mut TxContext) {
    assert!(ctx.sender() == task.requester, ENotRequester);
    assert!(!task.closed, ETaskClosed);
    task.closed = true;
    let reserved = task.active * (task.reward + task.fee);
    let refund = task.escrow.value() - reserved;
    if (refund > 0) {
        let coin = coin::take(&mut task.escrow, refund, ctx);
        transfer::public_transfer(coin, task.requester);
    };
    event::emit(TaskClosed { task_id: object::id(task), refunded: refund });
}

// === Worker actions ===

public fun claim<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &Registry,
    clock: &Clock,
    ctx: &TxContext,
) {
    config.assert_not_paused();
    let worker = ctx.sender();
    assert!(worker != task.requester, ERequesterCannotWork);
    registry.assert_can_work(worker);
    assert!(!task.closed, ETaskClosed);
    let now = clock.timestamp_ms();
    assert!(now < task.deadline_ms, EDeadlinePassed);
    assert!(open_slots(task) > 0, ENoOpenSlot);
    // One claim per worker per task, so consensus tasks get independent people.
    assert!(!task.claims.contains(worker), EAlreadyClaimed);

    task.claims.add(worker, Claim {
        claimed_at_ms: now,
        status: CLAIMED,
        proof_blob_id: b"".to_string(),
        answer_hash: vector[],
        captured_cell: b"".to_string(),
        submitted_at_ms: 0,
        rejected_at_ms: 0,
        fraud_flag: false,
        votes_for_worker: 0,
        votes_for_requester: 0,
        voters: vector[],
    });
    task.active = task.active + 1;
    event::emit(TaskClaimed { task_id: object::id(task), worker });
}

public fun submit_proof<T>(
    task: &mut Task<T>,
    config: &Config,
    proof_blob_id: String,
    answer_hash: vector<u8>,
    captured_cell: String,
    clock: &Clock,
    ctx: &TxContext,
) {
    let worker = ctx.sender();
    let now = clock.timestamp_ms();
    let window = config.claim_window_ms();
    let task_id = object::id(task);
    let claim = claim_mut(task, worker);
    assert!(claim.status == CLAIMED, EWrongStatus);
    assert!(now <= claim.claimed_at_ms + window, EClaimExpired);
    claim.status = SUBMITTED;
    claim.proof_blob_id = proof_blob_id;
    claim.answer_hash = answer_hash;
    claim.captured_cell = captured_cell;
    claim.submitted_at_ms = now;
    event::emit(ProofSubmitted { task_id, worker, proof_blob_id, answer_hash, captured_cell });
}

/// If the requester has not approved or rejected within the auto-release
/// window, the worker can collect payment themselves.
public fun auto_release<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &mut Registry,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let worker = ctx.sender();
    let claim = claim_mut(task, worker);
    assert!(claim.status == SUBMITTED, EWrongStatus);
    let submitted_at = claim.submitted_at_ms;
    assert!(clock.timestamp_ms() >= submitted_at + config.auto_release_ms(), ETooEarly);
    pay(task, config, registry, worker, true, ctx);
}

// === Disputes ===

/// Worker disputes a pending rejection, within the dispute window.
public fun dispute<T>(task: &mut Task<T>, config: &Config, clock: &Clock, ctx: &TxContext) {
    let worker = ctx.sender();
    let window = config.dispute_window_ms();
    let task_id = object::id(task);
    let claim = claim_mut(task, worker);
    assert!(claim.status == PENDING_REJECTION, EWrongStatus);
    assert!(clock.timestamp_ms() <= claim.rejected_at_ms + window, EDisputeWindowClosed);
    claim.status = DISPUTED;
    event::emit(DisputeOpened { task_id, worker });
}

/// Make a pending rejection final. The worker can accept it at any time;
/// anyone (usually the backend) can finalize it once the window has passed.
public fun finalize_rejection<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &mut Registry,
    worker: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let window = config.dispute_window_ms();
    let claim = claim_mut(task, worker);
    assert!(claim.status == PENDING_REJECTION, EWrongStatus);
    assert!(
        ctx.sender() == worker || clock.timestamp_ms() > claim.rejected_at_ms + window,
        ETooEarly,
    );
    finish_rejection(task, registry, worker, ctx);
}

/// A trusted verifier votes on a dispute after reviewing the proof.
/// The first side to reach the quorum wins.
public fun vote<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &mut Registry,
    worker: address,
    for_worker: bool,
    ctx: &mut TxContext,
) {
    let verifier = ctx.sender();
    registry.assert_verifier(verifier);
    assert!(verifier != task.requester && verifier != worker, EConflictedVoter);
    let quorum = config.dispute_quorum();
    let task_id = object::id(task);
    let claim = claim_mut(task, worker);
    assert!(claim.status == DISPUTED, EWrongStatus);
    assert!(!claim.voters.contains(&verifier), EAlreadyVoted);
    claim.voters.push_back(verifier);
    if (for_worker) claim.votes_for_worker = claim.votes_for_worker + 1
    else claim.votes_for_requester = claim.votes_for_requester + 1;
    let (w, r) = (claim.votes_for_worker, claim.votes_for_requester);
    event::emit(DisputeVote { task_id, worker, verifier, for_worker });

    if (w >= quorum) {
        pay(task, config, registry, worker, false, ctx);
        event::emit(DisputeResolved { task_id, worker, worker_won: true });
    } else if (r >= quorum) {
        finish_rejection(task, registry, worker, ctx);
        event::emit(DisputeResolved { task_id, worker, worker_won: false });
    }
}

// === Anyone ===

/// Free a slot whose worker claimed but never submitted in time.
/// Anyone (usually the backend) can call this.
public fun expire_claim<T>(
    task: &mut Task<T>,
    config: &Config,
    worker: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let window = config.claim_window_ms();
    let claim = claim_mut(task, worker);
    assert!(claim.status == CLAIMED, EWrongStatus);
    assert!(clock.timestamp_ms() > claim.claimed_at_ms + window, ETooEarly);
    claim.status = EXPIRED;
    free_slot(task, ctx);
    event::emit(ClaimExpired { task_id: object::id(task), worker });
}

// === Seal access policy ===

/// Seal key servers dry-run this to decide who may decrypt a proof.
/// Encryption ids are `task object id bytes || nonce`. The requester may
/// decrypt, and so may trusted verifiers (needed to judge disputes and for
/// the platform's automated fraud checks).
entry fun seal_approve<T>(id: vector<u8>, task: &Task<T>, registry: &Registry, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(sender == task.requester || registry.is_verifier(sender), ENoAccess);
    let prefix = object::id(task).to_bytes();
    assert!(id.length() >= prefix.length(), ENoAccess);
    let mut i = 0;
    while (i < prefix.length()) {
        assert!(id[i] == prefix[i], ENoAccess);
        i = i + 1;
    };
}

// === Internal ===

fun pay<T>(
    task: &mut Task<T>,
    config: &Config,
    registry: &mut Registry,
    worker: address,
    auto_released: bool,
    ctx: &mut TxContext,
) {
    let (reward, fee) = (task.reward, task.fee);
    claim_mut(task, worker).status = APPROVED;
    task.active = task.active - 1;
    task.approved = task.approved + 1;

    let payout = coin::take(&mut task.escrow, reward, ctx);
    transfer::public_transfer(payout, worker);
    if (fee > 0) {
        let fee_coin = coin::take(&mut task.escrow, fee, ctx);
        transfer::public_transfer(fee_coin, config::treasury(config));
    };
    registry.record_success(worker);
    event::emit(TaskPaid { task_id: object::id(task), worker, reward, fee, auto_released });
}

fun finish_rejection<T>(
    task: &mut Task<T>,
    registry: &mut Registry,
    worker: address,
    ctx: &mut TxContext,
) {
    let task_id = object::id(task);
    let claim = claim_mut(task, worker);
    claim.status = REJECTED;
    let fraud = claim.fraud_flag;
    free_slot(task, ctx);
    registry.record_rejection(worker, fraud);
    event::emit(RejectionFinal { task_id, worker, fraud });
}

/// An active claim ended without payment. Its reservation either
/// returns to the open pool or, if the task is closed, back to the requester.
fun free_slot<T>(task: &mut Task<T>, ctx: &mut TxContext) {
    task.active = task.active - 1;
    if (task.closed) {
        let coin = coin::take(&mut task.escrow, task.reward + task.fee, ctx);
        transfer::public_transfer(coin, task.requester);
    }
}

fun claim_mut<T>(task: &mut Task<T>, worker: address): &mut Claim {
    assert!(task.claims.contains(worker), ENotClaimer);
    &mut task.claims[worker]
}

// === Reads ===

public fun open_slots<T>(task: &Task<T>): u64 {
    if (task.closed) return 0;
    task.slots - task.approved - task.active
}

public fun requester<T>(task: &Task<T>): address { task.requester }

public fun kind<T>(task: &Task<T>): u8 { task.kind }

public fun reward<T>(task: &Task<T>): u64 { task.reward }

public fun fee<T>(task: &Task<T>): u64 { task.fee }

public fun approved<T>(task: &Task<T>): u64 { task.approved }

public fun active<T>(task: &Task<T>): u64 { task.active }

public fun is_closed<T>(task: &Task<T>): bool { task.closed }

public fun escrow_value<T>(task: &Task<T>): u64 { task.escrow.value() }

public fun claim_status<T>(task: &Task<T>, worker: address): u8 {
    assert!(task.claims.contains(worker), ENotClaimer);
    task.claims[worker].status
}

public fun kind_business_check(): u8 { KIND_BUSINESS_CHECK }

public fun kind_price_photo(): u8 { KIND_PRICE_PHOTO }

public fun kind_language(): u8 { KIND_LANGUAGE }

public fun status_claimed(): u8 { CLAIMED }

public fun status_submitted(): u8 { SUBMITTED }

public fun status_approved(): u8 { APPROVED }

public fun status_rejected(): u8 { REJECTED }

public fun status_expired(): u8 { EXPIRED }

public fun status_pending_rejection(): u8 { PENDING_REJECTION }

public fun status_disputed(): u8 { DISPUTED }

#[test_only]
public fun seal_approve_for_testing<T>(id: vector<u8>, task: &Task<T>, registry: &Registry, ctx: &TxContext) {
    seal_approve(id, task, registry, ctx)
}

#[test_only]
public fun destroy_for_testing<T>(task: Task<T>) {
    let Task { id, escrow, claims, .. } = task;
    id.delete();
    sui::balance::destroy_for_testing(escrow);
    claims.drop();
}
