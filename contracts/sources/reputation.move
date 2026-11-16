/// Worker registry and reputation. Stats live in one shared `Registry`
/// so the task module can update them and admins can ban cheaters.
/// Reputation cannot be transferred or bought.
module groundproof::reputation;

use groundproof::config::AdminCap;
use sui::event;
use sui::table::{Self, Table};

// === Errors ===
const EAlreadyRegistered: u64 = 200;
const ENotRegistered: u64 = 201;
const EBanned: u64 = 202;
const ENotVerifier: u64 = 203;

/// Strikes that trigger an automatic ban.
const MAX_STRIKES: u64 = 3;

public struct Stats has store, copy, drop {
    completed: u64,
    rejected: u64,
    strikes: u64,
    banned: bool,
}

public struct Registry has key {
    id: UID,
    workers: Table<address, Stats>,
    /// Trusted people who settle disputes. Managed by the admin.
    verifiers: Table<address, bool>,
}

public struct WorkerRegistered has copy, drop { worker: address }

public struct VerifierChanged has copy, drop { verifier: address, active: bool }

public struct ReputationChanged has copy, drop {
    worker: address,
    completed: u64,
    rejected: u64,
    strikes: u64,
    banned: bool,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry {
        id: object::new(ctx),
        workers: table::new(ctx),
        verifiers: table::new(ctx),
    });
}

/// A worker signs up (e.g. right after their first zkLogin sign-in).
public fun register(registry: &mut Registry, ctx: &TxContext) {
    let worker = ctx.sender();
    assert!(!registry.workers.contains(worker), EAlreadyRegistered);
    registry.workers.add(worker, Stats { completed: 0, rejected: 0, strikes: 0, banned: false });
    event::emit(WorkerRegistered { worker });
}

public fun ban(_: &AdminCap, registry: &mut Registry, worker: address) {
    let stats = stats_mut(registry, worker);
    stats.banned = true;
    emit_changed(worker, *stats);
}

public fun unban(_: &AdminCap, registry: &mut Registry, worker: address) {
    let stats = stats_mut(registry, worker);
    stats.banned = false;
    stats.strikes = 0;
    emit_changed(worker, *stats);
}

public fun add_verifier(_: &AdminCap, registry: &mut Registry, verifier: address) {
    if (!registry.verifiers.contains(verifier)) registry.verifiers.add(verifier, true);
    event::emit(VerifierChanged { verifier, active: true });
}

public fun remove_verifier(_: &AdminCap, registry: &mut Registry, verifier: address) {
    if (registry.verifiers.contains(verifier)) { registry.verifiers.remove(verifier); };
    event::emit(VerifierChanged { verifier, active: false });
}

public fun is_verifier(registry: &Registry, who: address): bool {
    registry.verifiers.contains(who)
}

public fun assert_verifier(registry: &Registry, who: address) {
    assert!(registry.verifiers.contains(who), ENotVerifier);
}

// === Package-only updates (called by the task module) ===

public(package) fun record_success(registry: &mut Registry, worker: address) {
    let stats = stats_mut(registry, worker);
    stats.completed = stats.completed + 1;
    emit_changed(worker, *stats);
}

public(package) fun record_rejection(registry: &mut Registry, worker: address, fraud: bool) {
    let stats = stats_mut(registry, worker);
    stats.rejected = stats.rejected + 1;
    if (fraud) {
        stats.strikes = stats.strikes + 1;
        if (stats.strikes >= MAX_STRIKES) stats.banned = true;
    };
    emit_changed(worker, *stats);
}

// === Reads ===

public fun is_registered(registry: &Registry, worker: address): bool {
    registry.workers.contains(worker)
}

public fun assert_can_work(registry: &Registry, worker: address) {
    assert!(registry.workers.contains(worker), ENotRegistered);
    assert!(!registry.workers[worker].banned, EBanned);
}

public fun stats(registry: &Registry, worker: address): Stats {
    assert!(registry.workers.contains(worker), ENotRegistered);
    registry.workers[worker]
}

public fun completed(s: &Stats): u64 { s.completed }

public fun rejected(s: &Stats): u64 { s.rejected }

public fun strikes(s: &Stats): u64 { s.strikes }

public fun banned(s: &Stats): bool { s.banned }

/// Level 0 (new) to 3 (trusted), used to gate higher-value tasks off-chain
/// and, later, on-chain.
public fun level(s: &Stats): u8 {
    if (s.banned) return 0;
    if (s.completed >= 200 && s.strikes == 0) 3
    else if (s.completed >= 50) 2
    else if (s.completed >= 10) 1
    else 0
}

fun stats_mut(registry: &mut Registry, worker: address): &mut Stats {
    assert!(registry.workers.contains(worker), ENotRegistered);
    &mut registry.workers[worker]
}

fun emit_changed(worker: address, s: Stats) {
    event::emit(ReputationChanged {
        worker,
        completed: s.completed,
        rejected: s.rejected,
        strikes: s.strikes,
        banned: s.banned,
    });
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
