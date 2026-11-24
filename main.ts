// Momentum paper-trading bot for the Pump.fun Bot Sprint (agent-fun/replay/v2).
//
// The hello message carries the run's capital, caps and fees. Every batch
// carries one slot of chain events plus the fills of orders decided on
// earlier batches; the orders returned for a batch fill two slots later.
// The bot buys young curves with strong buy-heavy flow, then sells on a
// take-profit, a stop-loss, a trailing exit, or a time exit. No clock,
// environment or randomness is read anywhere, so two runs agree exactly.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type Done, type OrderInput } from './vendor/makefun-bot.ts';

const SCALE = 1_000_000_000n;
const BUY_SOL = 50_000_000n; // 0.05 SOL per coin
const MIN_BUY = 10_000_000n; // 0.01 SOL: the guardrail round-trip floor
const SLIPPAGE_BPS = 500;
const MAX_AGE_SLOTS = 300; // only buy curves created within ~2 min
const MAX_HOLD_SLOTS = 300; // time exit: free the slot after ~2 min
const TAKE_PROFIT_NUM = 110n; // sell at +10% vs entry price: scalp the burst
const STOP_LOSS_NUM = 95n; // sell at -5% vs entry price
const TRAIL_ARM_NUM = 106n; // trailing exit arms once +6% up
const TRAIL_NUM = 95n; // sell at -5% from the peak price
const MIN_REAL_SOL = 1_000_000_000n; // need >= 1 SOL real reserves so the 100 bps cap allows >= 0.01 SOL

interface MintStats {
  createdSlot: number | null;
  firstPrice: bigint | null;
  lastPrice: bigint | null;
  trades: number;
  buySol: bigint; // buy volume over the last few trades
  sellSol: bigint; // sell volume over the last few trades
  recent: { buy: boolean; sol: bigint }[];
}

interface Entry {
  entryPrice: bigint;
  peakPrice: bigint;
  buySlot: number;
}

const stats = new Map<string, MintStats>();
const entries = new Map<string, Entry>();
const bought = new Set<string>();

function priceOf(vq: bigint, vt: bigint): bigint | null {
  if (vt <= 0n || vq <= 0n) return null;
  return (vq * SCALE) / vt;
}

function track(mint: string): MintStats {
  let s = stats.get(mint);
  if (s === undefined) {
    s = { createdSlot: null, firstPrice: null, lastPrice: null, trades: 0, buySol: 0n, sellSol: 0n, recent: [] };
    stats.set(mint, s);
  }
  return s;
}

function onHello(_state: BotState): void {
  // Nothing to seed: every decision below comes from the hello caps and the
  // batches themselves, so the run is deterministic by construction.
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];

  // Settle fills first: a filled buy records its entry price, a rejected or
  // failed buy frees the mint for another attempt.
  for (const fill of batch.fills) {
    if (fill.side !== 'buy') continue;
    if (fill.status === 'filled') {
      const tokens = BigInt(fill.token_amount);
      const quote = BigInt(fill.quote_lamports);
      if (tokens > 0n && quote > 0n) {
        const entryPrice = (quote * SCALE) / tokens;
        entries.set(fill.mint, { entryPrice, peakPrice: entryPrice, buySlot: batch.slot });
      }
    } else {
      bought.delete(fill.mint);
      entries.delete(fill.mint);
    }
  }

  // Fold this batch's events into per-mint flow stats and collect the mints
  // that traded, so only they are considered as fresh buy candidates.
  const candidates: string[] = [];
  for (const event of batch.events) {
    const s = track(event.mint);
    if (event.event === 'CreateEvent') {
      if (s.createdSlot === null) s.createdSlot = event.slot;
      const p = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
      if (s.firstPrice === null && p !== null) s.firstPrice = p;
      if (p !== null) s.lastPrice = p;
    } else if (event.event === 'TradeEvent') {
      s.trades += 1;
      const sol = BigInt(event.sol_amount);
      s.recent.push({ buy: event.is_buy, sol });
      if (event.is_buy) s.buySol += sol;
      else s.sellSol += sol;
      while (s.recent.length > 5) {
        const old = s.recent.shift();
        if (old !== undefined) {
          if (old.buy) s.buySol -= old.sol;
          else s.sellSol -= old.sol;
        }
      }
      const p = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
      if (s.firstPrice === null && p !== null) s.firstPrice = p;
      if (p !== null) s.lastPrice = p;
      if (!candidates.includes(event.mint)) candidates.push(event.mint);
    }
  }

  // Exits first: every held position is checked against take-profit,
  // stop-loss, trailing and time exits, priced off the curve's reserves.
  // A mint with a sell already in flight is skipped: its fill lands two
  // slots after the batch that decided it, and a duplicate sell would be
  // rejected for insufficient tokens.
  const sellPending = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') sellPending.add(p.order.mint);
  }
  for (const [mint, holding] of state.positions) {
    if (sellPending.has(mint)) continue;
    const entry = entries.get(mint);
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price === null) continue;
    if (entry !== undefined && price > entry.peakPrice) entry.peakPrice = price;
    let sell = false;
    if (entry === undefined) {
      // No fill seen for this position (e.g. resumed state): exit on age only.
      sell = false;
    } else if (price * 100n >= entry.entryPrice * TAKE_PROFIT_NUM) {
      sell = true; // take-profit: +40%
    } else if (price * 100n <= entry.entryPrice * STOP_LOSS_NUM) {
      sell = true; // stop-loss: -25%
    } else if (
      entry.peakPrice * 100n >= entry.entryPrice * TRAIL_ARM_NUM &&
      price * 100n <= entry.peakPrice * TRAIL_NUM
    ) {
      sell = true; // trailing exit: -20% from a peak at least +20% up
    } else if (batch.slot - entry.buySlot > MAX_HOLD_SLOTS) {
      sell = true; // time exit: free the slot for a fresher coin
    }
    if (sell && holding.token_amount > 0n) {
      // Keep the entry record until the position actually closes: a
      // rejected sell must be retried on the next batch, not forgotten.
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    }
  }

  // Prune entry records for positions the harness already closed.
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) entries.delete(mint);
  }

  // Entries: young curves with buy-heavy recent flow and rising price.
  // One buy per mint ever, so the book spreads across many distinct coins.
  const maxPositions = state.hello.caps.max_open_positions;
  for (const mint of candidates) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (state.committedPositionCount() >= maxPositions) break;
    if (bought.has(mint) || state.positions.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const s = stats.get(mint);
    if (s === undefined || s.trades < 3 || s.firstPrice === null || s.lastPrice === null) continue;
    if (s.createdSlot !== null && batch.slot - s.createdSlot > MAX_AGE_SLOTS) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
    // Buy-heavy flow: buys dominate sells over the last few trades.
    if (s.buySol < s.sellSol * 5n) continue;
    // At least two of the last three trades were buys.
    const tail = s.recent.slice(-3);
    if (tail.filter((t) => t.buy).length < 2) continue;
    // Momentum, but not a vertical spike: +1% to +15% vs the first price.
    if (s.lastPrice * 100n < s.firstPrice * 101n) continue;
    if (s.lastPrice * 100n > s.firstPrice * 115n) continue;
    const cap = state.maxBuyLamports(mint);
    let size = BUY_SOL < cap ? BUY_SOL : cap;
    const free = state.freeCashLamports() - state.txFeeLamports();
    if (size > free) size = free;
    if (size < MIN_BUY) continue;
    bought.add(mint);
    orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
  }

  return orders;
}

function onDone(state: BotState, done: Done): void {
  console.error(`done ${done.reason} cash=${state.cash} positions=${state.positions.size}`);
}

await runBot({ onHello, onBatch, onDone });
