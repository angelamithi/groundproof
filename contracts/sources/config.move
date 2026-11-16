/// Global settings for the Shahidi marketplace: platform fee, treasury,
/// emergency pause and payout timings. One shared `Config` object exists;
/// whoever holds the `AdminCap` can change it.
module groundproof::config;

use sui::event;

// === Errors ===
const EFeeTooHigh: u64 = 100;
const EPaused: u64 = 101;

// === Constants ===
/// Hard ceiling on the platform fee: 20% (in basis points).
const MAX_FEE_BPS: u64 = 2_000;
/// Default fee: 5%.
const DEFAULT_FEE_BPS: u64 = 500;
/// Default time a worker has to submit after claiming: 2 hours.
const DEFAULT_CLAIM_WINDOW_MS: u64 = 2 * 60 * 60 * 1000;
/// Default time after submission before a worker can force payment: 48 hours.
const DEFAULT_AUTO_RELEASE_MS: u64 = 48 * 60 * 60 * 1000;
/// Default time a worker has to dispute a rejection: 24 hours.
const DEFAULT_DISPUTE_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
/// Default verifier votes needed to settle a dispute. Start at 1 while the
/// verifier pool is small; raise to 3 as it grows.
const DEFAULT_DISPUTE_QUORUM: u64 = 1;
const EZeroQuorum: u64 = 102;

/// Capability that lets its holder administer the platform.
public struct AdminCap has key, store { id: UID }

/// Shared platform configuration.
public struct Config has key {
    id: UID,
    fee_bps: u64,
    treasury: address,
    paused: bool,
    claim_window_ms: u64,
    auto_release_ms: u64,
    dispute_window_ms: u64,
    dispute_quorum: u64,
}

public struct ConfigChanged has copy, drop {
    fee_bps: u64,
    treasury: address,
    paused: bool,
    claim_window_ms: u64,
    auto_release_ms: u64,
    dispute_window_ms: u64,
    dispute_quorum: u64,
}

fun init(ctx: &mut TxContext) {
    let sender = ctx.sender();
    transfer::share_object(Config {
        id: object::new(ctx),
        fee_bps: DEFAULT_FEE_BPS,
        treasury: sender,
        paused: false,
        claim_window_ms: DEFAULT_CLAIM_WINDOW_MS,
        auto_release_ms: DEFAULT_AUTO_RELEASE_MS,
        dispute_window_ms: DEFAULT_DISPUTE_WINDOW_MS,
        dispute_quorum: DEFAULT_DISPUTE_QUORUM,
    });
    transfer::transfer(AdminCap { id: object::new(ctx) }, sender);
}

// === Admin ===

public fun set_fee_bps(_: &AdminCap, config: &mut Config, fee_bps: u64) {
    assert!(fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    config.fee_bps = fee_bps;
    emit_changed(config);
}

public fun set_treasury(_: &AdminCap, config: &mut Config, treasury: address) {
    config.treasury = treasury;
    emit_changed(config);
}

public fun set_paused(_: &AdminCap, config: &mut Config, paused: bool) {
    config.paused = paused;
    emit_changed(config);
}

public fun set_windows(
    _: &AdminCap,
    config: &mut Config,
    claim_window_ms: u64,
    auto_release_ms: u64,
) {
    config.claim_window_ms = claim_window_ms;
    config.auto_release_ms = auto_release_ms;
    emit_changed(config);
}

public fun set_dispute_rules(
    _: &AdminCap,
    config: &mut Config,
    dispute_window_ms: u64,
    dispute_quorum: u64,
) {
    assert!(dispute_quorum > 0, EZeroQuorum);
    config.dispute_window_ms = dispute_window_ms;
    config.dispute_quorum = dispute_quorum;
    emit_changed(config);
}

// === Reads ===

public fun fee_bps(config: &Config): u64 { config.fee_bps }

public fun treasury(config: &Config): address { config.treasury }

public fun is_paused(config: &Config): bool { config.paused }

public fun claim_window_ms(config: &Config): u64 { config.claim_window_ms }

public fun auto_release_ms(config: &Config): u64 { config.auto_release_ms }

public fun dispute_window_ms(config: &Config): u64 { config.dispute_window_ms }

public fun dispute_quorum(config: &Config): u64 { config.dispute_quorum }

public fun assert_not_paused(config: &Config) {
    assert!(!config.paused, EPaused);
}

/// Fee charged on top of a reward, rounded down.
public fun fee_for(config: &Config, reward: u64): u64 {
    ((reward as u128) * (config.fee_bps as u128) / 10_000) as u64
}

fun emit_changed(config: &Config) {
    event::emit(ConfigChanged {
        fee_bps: config.fee_bps,
        treasury: config.treasury,
        paused: config.paused,
        claim_window_ms: config.claim_window_ms,
        auto_release_ms: config.auto_release_ms,
        dispute_window_ms: config.dispute_window_ms,
        dispute_quorum: config.dispute_quorum,
    });
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }
