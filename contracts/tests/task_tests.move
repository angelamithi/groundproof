#[test_only]
module groundproof::task_tests;

use groundproof::config::{Self, Config, AdminCap};
use groundproof::reputation::{Self, Registry};
use groundproof::task::{Self, Task};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// Stand-in for USDC in tests.
public struct USDC has drop {}

const ADMIN: address = @0xA;
const REQUESTER: address = @0xB;
const WORKER: address = @0xC;
const WORKER2: address = @0xD;
const STRANGER: address = @0xE;

const REWARD: u64 = 1_000_000; // 1 USDC (6 decimals)
const FEE: u64 = 50_000; // 5%
const HOUR: u64 = 60 * 60 * 1000;

// === Helpers ===

fun setup(): (Scenario, Clock) {
    let mut s = ts::begin(ADMIN);
    config::init_for_testing(s.ctx());
    reputation::init_for_testing(s.ctx());
    let mut clock = clock::create_for_testing(s.ctx());
    clock.set_for_testing(1_000);
    register(&mut s, WORKER);
    register(&mut s, WORKER2);
    (s, clock)
}

fun register(s: &mut Scenario, who: address) {
    s.next_tx(who);
    let mut reg = s.take_shared<Registry>();
    reg.register(s.ctx());
    ts::return_shared(reg);
}

fun create_task(s: &mut Scenario, clock: &Clock, slots: u64) {
    s.next_tx(REQUESTER);
    let cfg = s.take_shared<Config>();
    let pay = coin::mint_for_testing<USDC>(slots * (REWARD + FEE), s.ctx());
    task::create(
        &cfg,
        pay,
        task::kind_business_check(),
        b"kzf0t8".to_string(),
        b"walrus:instructions".to_string(),
        REWARD,
        slots,
        clock.timestamp_ms() + 24 * HOUR,
        clock,
        s.ctx(),
    );
    ts::return_shared(cfg);
}

fun claim(s: &mut Scenario, clock: &Clock, who: address) {
    s.next_tx(who);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let reg = s.take_shared<Registry>();
    t.claim(&cfg, &reg, clock, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
}

fun submit(s: &mut Scenario, clock: &Clock, who: address) {
    s.next_tx(who);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    t.submit_proof(
        &cfg,
        b"walrus:proof123".to_string(),
        x"abcd",
        b"kzf0t8".to_string(),
        clock,
        s.ctx(),
    );
    ts::return_shared(t);
    ts::return_shared(cfg);
}

fun approve(s: &mut Scenario, caller: address, worker: address) {
    s.next_tx(caller);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let mut reg = s.take_shared<Registry>();
    t.approve(&cfg, &mut reg, worker, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
}

fun reject(s: &mut Scenario, clock: &Clock, worker: address, fraud: bool) {
    s.next_tx(REQUESTER);
    let mut t = s.take_shared<Task<USDC>>();
    t.reject(worker, fraud, clock, s.ctx());
    ts::return_shared(t);
}

/// `caller` finalizes `worker`'s pending rejection.
fun finalize(s: &mut Scenario, clock: &Clock, caller: address, worker: address) {
    s.next_tx(caller);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let mut reg = s.take_shared<Registry>();
    t.finalize_rejection(&cfg, &mut reg, worker, clock, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
}

fun open_dispute(s: &mut Scenario, clock: &Clock, worker: address) {
    s.next_tx(worker);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    t.dispute(&cfg, clock, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
}

fun vote(s: &mut Scenario, verifier: address, worker: address, for_worker: bool) {
    s.next_tx(verifier);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let mut reg = s.take_shared<Registry>();
    t.vote(&cfg, &mut reg, worker, for_worker, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
}

fun add_verifier(s: &mut Scenario, who: address) {
    s.next_tx(ADMIN);
    let cap = s.take_from_sender<AdminCap>();
    let mut reg = s.take_shared<Registry>();
    reputation::add_verifier(&cap, &mut reg, who);
    ts::return_shared(reg);
    s.return_to_sender(cap);
}

fun strikes_of(s: &mut Scenario, worker: address): u64 {
    s.next_tx(ADMIN);
    let reg = s.take_shared<Registry>();
    let n = reg.stats(worker).strikes();
    ts::return_shared(reg);
    n
}

/// Common start: one-slot task, WORKER submitted and was rejected.
fun rejected_submission(s: &mut Scenario, clock: &Clock, fraud: bool) {
    create_task(s, clock, 1);
    claim(s, clock, WORKER);
    submit(s, clock, WORKER);
    reject(s, clock, WORKER, fraud);
}

fun balance_of(s: &mut Scenario, who: address): u64 {
    s.next_tx(who);
    let ids = ts::ids_for_address<Coin<USDC>>(who);
    let mut total = 0;
    ids.do!(|id| {
        let c = s.take_from_address_by_id<Coin<USDC>>(who, id);
        total = total + c.value();
        ts::return_to_address(who, c);
    });
    total
}

fun finish(s: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    s.end();
}

// === Tests ===

#[test]
fun happy_path_pays_worker_and_treasury() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);
    approve(&mut s, REQUESTER, WORKER);

    assert!(balance_of(&mut s, WORKER) == REWARD);
    assert!(balance_of(&mut s, ADMIN) == FEE);

    s.next_tx(ADMIN);
    let t = s.take_shared<Task<USDC>>();
    let reg = s.take_shared<Registry>();
    assert!(t.escrow_value() == 0);
    assert!(t.approved() == 1);
    assert!(t.claim_status(WORKER) == task::status_approved());
    assert!(reg.stats(WORKER).completed() == 1);
    ts::return_shared(t);
    ts::return_shared(reg);
    finish(s, clock);
}

#[test]
fun two_slots_two_workers() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 2);
    claim(&mut s, &clock, WORKER);
    claim(&mut s, &clock, WORKER2);
    submit(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER2);
    approve(&mut s, REQUESTER, WORKER);
    approve(&mut s, REQUESTER, WORKER2);
    assert!(balance_of(&mut s, WORKER) == REWARD);
    assert!(balance_of(&mut s, WORKER2) == REWARD);
    assert!(balance_of(&mut s, ADMIN) == 2 * FEE);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ENoOpenSlot)]
fun cannot_claim_full_task() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    claim(&mut s, &clock, WORKER2);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EAlreadyClaimed)]
fun cannot_claim_twice() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 2);
    claim(&mut s, &clock, WORKER);
    claim(&mut s, &clock, WORKER);
    finish(s, clock);
}

#[test, expected_failure(abort_code = reputation::ENotRegistered)]
fun unregistered_worker_cannot_claim() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, STRANGER);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ERequesterCannotWork)]
fun requester_cannot_claim_own_task() {
    let (mut s, clock) = setup();
    register(&mut s, REQUESTER);
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, REQUESTER);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EWrongPayment)]
fun wrong_payment_amount_fails() {
    let (mut s, clock) = setup();
    s.next_tx(REQUESTER);
    let cfg = s.take_shared<Config>();
    let pay = coin::mint_for_testing<USDC>(REWARD, s.ctx()); // fee missing
    task::create(
        &cfg, pay, 0, b"x".to_string(), b"y".to_string(),
        REWARD, 1, 10 * HOUR, &clock, s.ctx(),
    );
    ts::return_shared(cfg);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ENotRequester)]
fun only_requester_can_approve() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);
    approve(&mut s, STRANGER, WORKER);
    finish(s, clock);
}

#[test]
fun reject_frees_slot_for_another_worker() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);
    reject(&mut s, &clock, WORKER, false);
    finalize(&mut s, &clock, WORKER, WORKER); // worker accepts the rejection
    claim(&mut s, &clock, WORKER2);
    submit(&mut s, &clock, WORKER2);
    approve(&mut s, REQUESTER, WORKER2);
    assert!(balance_of(&mut s, WORKER) == 0);
    assert!(balance_of(&mut s, WORKER2) == REWARD);
    finish(s, clock);
}

#[test, expected_failure(abort_code = reputation::EBanned)]
fun three_fraud_strikes_ban_worker() {
    let (mut s, clock) = setup();
    let mut i: u64 = 0;
    while (i < 3) {
        create_task(&mut s, &clock, 1);
        // take the most recently created task
        s.next_tx(WORKER);
        let id = ts::most_recent_id_shared<Task<USDC>>().destroy_some();
        let mut t = s.take_shared_by_id<Task<USDC>>(id);
        let cfg = s.take_shared<Config>();
        let mut reg = s.take_shared<Registry>();
        t.claim(&cfg, &reg, &clock, s.ctx());
        t.submit_proof(&cfg, b"p".to_string(), x"01", b"c".to_string(), &clock, s.ctx());
        ts::return_shared(t);
        s.next_tx(REQUESTER);
        let mut t = s.take_shared_by_id<Task<USDC>>(id);
        t.reject(WORKER, true, &clock, s.ctx());
        ts::return_shared(t);
        s.next_tx(WORKER);
        let mut t = s.take_shared_by_id<Task<USDC>>(id);
        t.finalize_rejection(&cfg, &mut reg, WORKER, &clock, s.ctx());
        ts::return_shared(t);
        ts::return_shared(cfg);
        ts::return_shared(reg);
        i = i + 1;
    };
    s.next_tx(WORKER);
    let reg = s.take_shared<Registry>();
    reg.assert_can_work(WORKER);
    ts::return_shared(reg);
    finish(s, clock);
}

#[test]
fun auto_release_after_window() {
    let (mut s, mut clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);
    clock.increment_for_testing(48 * HOUR);
    s.next_tx(WORKER);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let mut reg = s.take_shared<Registry>();
    t.auto_release(&cfg, &mut reg, &clock, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
    assert!(balance_of(&mut s, WORKER) == REWARD);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ETooEarly)]
fun auto_release_too_early_fails() {
    let (mut s, mut clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);
    clock.increment_for_testing(HOUR);
    s.next_tx(WORKER);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    let mut reg = s.take_shared<Registry>();
    t.auto_release(&cfg, &mut reg, &clock, s.ctx());
    ts::return_shared(t);
    ts::return_shared(cfg);
    ts::return_shared(reg);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EClaimExpired)]
fun late_submission_fails() {
    let (mut s, mut clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    clock.increment_for_testing(3 * HOUR);
    submit(&mut s, &clock, WORKER);
    finish(s, clock);
}

#[test]
fun expired_claim_frees_slot() {
    let (mut s, mut clock) = setup();
    create_task(&mut s, &clock, 1);
    claim(&mut s, &clock, WORKER);
    clock.increment_for_testing(3 * HOUR);
    s.next_tx(STRANGER);
    let mut t = s.take_shared<Task<USDC>>();
    let cfg = s.take_shared<Config>();
    t.expire_claim(&cfg, WORKER, &clock, s.ctx());
    assert!(t.open_slots() == 1);
    assert!(t.claim_status(WORKER) == task::status_expired());
    ts::return_shared(t);
    ts::return_shared(cfg);
    finish(s, clock);
}

#[test]
fun close_refunds_unreserved_then_rest_after_reject() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 3);
    claim(&mut s, &clock, WORKER);
    submit(&mut s, &clock, WORKER);

    // Close: 2 unclaimed slots refunded, 1 stays reserved for WORKER.
    s.next_tx(REQUESTER);
    let mut t = s.take_shared<Task<USDC>>();
    t.close(s.ctx());
    assert!(t.escrow_value() == REWARD + FEE);
    assert!(t.open_slots() == 0);
    ts::return_shared(t);
    assert!(balance_of(&mut s, REQUESTER) == 2 * (REWARD + FEE));

    // A final rejection of the last submission returns its reservation too.
    reject(&mut s, &clock, WORKER, false);
    assert!(balance_of(&mut s, REQUESTER) == 2 * (REWARD + FEE)); // held during dispute window
    finalize(&mut s, &clock, WORKER, WORKER);
    assert!(balance_of(&mut s, REQUESTER) == 3 * (REWARD + FEE));
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ETaskClosed)]
fun cannot_claim_closed_task() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    s.next_tx(REQUESTER);
    let mut t = s.take_shared<Task<USDC>>();
    t.close(s.ctx());
    ts::return_shared(t);
    claim(&mut s, &clock, WORKER);
    finish(s, clock);
}

#[test, expected_failure(abort_code = config::EPaused)]
fun paused_platform_blocks_new_tasks() {
    let (mut s, clock) = setup();
    s.next_tx(ADMIN);
    let cap = s.take_from_sender<AdminCap>();
    let mut cfg = s.take_shared<Config>();
    config::set_paused(&cap, &mut cfg, true);
    ts::return_shared(cfg);
    s.return_to_sender(cap);
    create_task(&mut s, &clock, 1);
    finish(s, clock);
}

#[test, expected_failure(abort_code = config::EFeeTooHigh)]
fun fee_cap_enforced() {
    let (mut s, clock) = setup();
    s.next_tx(ADMIN);
    let cap = s.take_from_sender<AdminCap>();
    let mut cfg = s.take_shared<Config>();
    config::set_fee_bps(&cap, &mut cfg, 5_000);
    ts::return_shared(cfg);
    s.return_to_sender(cap);
    finish(s, clock);
}

// === Dispute tests ===

const VERIFIER: address = @0xF;

#[test]
fun rejection_held_until_window_passes_then_strike() {
    let (mut s, mut clock) = setup();
    rejected_submission(&mut s, &clock, true);
    // No strike while the worker can still dispute.
    assert!(strikes_of(&mut s, WORKER) == 0);
    clock.increment_for_testing(25 * HOUR);
    finalize(&mut s, &clock, STRANGER, WORKER);
    assert!(strikes_of(&mut s, WORKER) == 1);
    s.next_tx(ADMIN);
    let t = s.take_shared<Task<USDC>>();
    assert!(t.open_slots() == 1);
    assert!(t.claim_status(WORKER) == task::status_rejected());
    ts::return_shared(t);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ETooEarly)]
fun stranger_cannot_finalize_inside_window() {
    let (mut s, clock) = setup();
    rejected_submission(&mut s, &clock, false);
    finalize(&mut s, &clock, STRANGER, WORKER);
    finish(s, clock);
}

#[test]
fun dispute_won_by_worker_pays_worker() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, VERIFIER);
    rejected_submission(&mut s, &clock, true);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, VERIFIER, WORKER, true);
    assert!(balance_of(&mut s, WORKER) == REWARD);
    assert!(balance_of(&mut s, ADMIN) == FEE);
    assert!(strikes_of(&mut s, WORKER) == 0);
    finish(s, clock);
}

#[test]
fun dispute_lost_by_worker_gives_strike_and_frees_slot() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, VERIFIER);
    rejected_submission(&mut s, &clock, true);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, VERIFIER, WORKER, false);
    assert!(balance_of(&mut s, WORKER) == 0);
    assert!(strikes_of(&mut s, WORKER) == 1);
    claim(&mut s, &clock, WORKER2); // slot reopened
    finish(s, clock);
}

#[test]
fun quorum_of_two_needs_two_votes() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, VERIFIER);
    add_verifier(&mut s, STRANGER);
    s.next_tx(ADMIN);
    let cap = s.take_from_sender<AdminCap>();
    let mut cfg = s.take_shared<Config>();
    config::set_dispute_rules(&cap, &mut cfg, 24 * HOUR, 2);
    ts::return_shared(cfg);
    s.return_to_sender(cap);

    rejected_submission(&mut s, &clock, false);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, VERIFIER, WORKER, true);
    assert!(balance_of(&mut s, WORKER) == 0); // not settled yet
    vote(&mut s, STRANGER, WORKER, true);
    assert!(balance_of(&mut s, WORKER) == REWARD);
    finish(s, clock);
}

#[test]
fun requester_can_change_mind_and_approve() {
    let (mut s, clock) = setup();
    rejected_submission(&mut s, &clock, false);
    open_dispute(&mut s, &clock, WORKER);
    approve(&mut s, REQUESTER, WORKER);
    assert!(balance_of(&mut s, WORKER) == REWARD);
    finish(s, clock);
}

#[test, expected_failure(abort_code = reputation::ENotVerifier)]
fun non_verifier_cannot_vote() {
    let (mut s, clock) = setup();
    rejected_submission(&mut s, &clock, false);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, STRANGER, WORKER, true);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EConflictedVoter)]
fun requester_cannot_vote_even_if_verifier() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, REQUESTER);
    rejected_submission(&mut s, &clock, false);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, REQUESTER, WORKER, false);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EAlreadyVoted)]
fun verifier_cannot_vote_twice() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, VERIFIER);
    s.next_tx(ADMIN);
    let cap = s.take_from_sender<AdminCap>();
    let mut cfg = s.take_shared<Config>();
    config::set_dispute_rules(&cap, &mut cfg, 24 * HOUR, 3);
    ts::return_shared(cfg);
    s.return_to_sender(cap);
    rejected_submission(&mut s, &clock, false);
    open_dispute(&mut s, &clock, WORKER);
    vote(&mut s, VERIFIER, WORKER, true);
    vote(&mut s, VERIFIER, WORKER, true);
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::EDisputeWindowClosed)]
fun cannot_dispute_after_window() {
    let (mut s, mut clock) = setup();
    rejected_submission(&mut s, &clock, false);
    clock.increment_for_testing(25 * HOUR);
    open_dispute(&mut s, &clock, WORKER);
    finish(s, clock);
}

// === Seal access tests ===

fun seal_check(s: &mut Scenario, who: address, suffix: vector<u8>) {
    s.next_tx(who);
    let t = s.take_shared<Task<USDC>>();
    let reg = s.take_shared<Registry>();
    let mut id = object::id(&t).to_bytes();
    id.append(suffix);
    task::seal_approve_for_testing(id, &t, &reg, s.ctx());
    ts::return_shared(t);
    ts::return_shared(reg);
}

#[test]
fun requester_and_verifier_can_decrypt() {
    let (mut s, clock) = setup();
    add_verifier(&mut s, VERIFIER);
    create_task(&mut s, &clock, 1);
    seal_check(&mut s, REQUESTER, x"0102");
    seal_check(&mut s, VERIFIER, x"0304");
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ENoAccess)]
fun worker_cannot_decrypt_others_proofs() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    seal_check(&mut s, WORKER2, x"01");
    finish(s, clock);
}

#[test, expected_failure(abort_code = task::ENoAccess)]
fun seal_id_must_start_with_task_id() {
    let (mut s, clock) = setup();
    create_task(&mut s, &clock, 1);
    s.next_tx(REQUESTER);
    let t = s.take_shared<Task<USDC>>();
    let reg = s.take_shared<Registry>();
    task::seal_approve_for_testing(x"deadbeef", &t, &reg, s.ctx());
    ts::return_shared(t);
    ts::return_shared(reg);
    finish(s, clock);
}
