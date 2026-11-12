import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const TREND_BARS = 60;
const MIN_TREND_BPS = 30n;
const PULLBACK_BARS = 20;
const PULLBACK_BPS = 30n;
const TAKE_PROFIT_BPS = 80n;
const STOP_BPS = 80n;
const MAX_HOLD_BARS = 120;
const CAP_DROP_BARS = 60;
const CAP_DROP_BPS = 100n;
const CAP_REBOUND_BARS = 3;
const CAP_REBOUND_BPS = 10n;
const CAP_TAKE_PROFIT_BPS = 50n;
const CAP_STOP_BPS = 50n;
const CAP_MAX_HOLD_BARS = 60;
const MAX_SLIPPAGE_BPS = 100;
const MAX_SELL_SLIPPAGE_BPS = 500;
const COOLDOWN_BARS = 15;
const FALLBACK_BAR = 1360;
const HISTORY_BARS = Math.max(TREND_BARS, PULLBACK_BARS, CAP_DROP_BARS, CAP_REBOUND_BARS) + 1;

type SignalKind = 'trend' | 'cap';

interface Holding {
  entryPrice: bigint;
  entryBar: number;
  peakClose: bigint;
  kind: SignalKind;
}

const closes: bigint[] = [];
let symbol = 'CBBTC';
let barCount = 0;
let scoredBars = 0;
let holding: Holding | null = null;
let pendingBuyClose: bigint | null = null;
let pendingBuyKind: SignalKind | null = null;
let cooldownUntil = 0;
let traded = false;

function pushClose(close: bigint): void {
  closes.push(close);
  if (closes.length > HISTORY_BARS) closes.shift();
  barCount++;
}

function processFills(batch: Batch, currentClose: bigint): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== symbol) continue;
    if (fill.side === 'buy') {
      if (fill.status !== 'filled') {
        pendingBuyClose = null;
        pendingBuyKind = null;
        continue;
      }
      const signalClose = pendingBuyClose;
      const kind = pendingBuyKind ?? 'trend';
      pendingBuyClose = null;
      pendingBuyKind = null;
      const entryPrice = BigInt(fill.price);
      let peakClose = entryPrice > currentClose ? entryPrice : currentClose;
      if (signalClose !== null && signalClose > peakClose) peakClose = signalClose;
      holding = { entryPrice, entryBar: barCount, peakClose, kind };
      traded = true;
    } else if (fill.status === 'filled') {
      holding = null;
      pendingBuyClose = null;
      pendingBuyKind = null;
      cooldownUntil = barCount + COOLDOWN_BARS;
    }
  }
}

function entryKind(): SignalKind | null {
  if (closes.length < HISTORY_BARS) return null;
  const close = closes[closes.length - 1]!;
  const pullbackBase = closes[closes.length - 1 - PULLBACK_BARS]!;
  const trendBase = closes[closes.length - 1 - TREND_BARS]!;
  if (close * BPS >= trendBase * (BPS + MIN_TREND_BPS) && close * BPS <= pullbackBase * (BPS - PULLBACK_BPS)) {
    return 'trend';
  }
  const dropBase = closes[closes.length - 1 - CAP_DROP_BARS]!;
  const reboundBase = closes[closes.length - 1 - CAP_REBOUND_BARS]!;
  if (close * BPS <= dropBase * (BPS - CAP_DROP_BPS) && close * BPS >= reboundBase * (BPS + CAP_REBOUND_BPS)) {
    return 'cap';
  }
  return null;
}

function exitSignal(close: bigint): boolean {
  if (holding === null) return true;
  const takeProfit = holding.kind === 'trend' ? TAKE_PROFIT_BPS : CAP_TAKE_PROFIT_BPS;
  const stop = holding.kind === 'trend' ? STOP_BPS : CAP_STOP_BPS;
  const maxHold = holding.kind === 'trend' ? MAX_HOLD_BARS : CAP_MAX_HOLD_BARS;
  if (barCount - holding.entryBar >= maxHold) return true;
  if (close * BPS >= holding.entryPrice * (BPS + takeProfit)) return true;
  if (close * BPS <= holding.entryPrice * (BPS - stop)) return true;
  if (close > holding.peakClose) holding.peakClose = close;
  return close * BPS <= holding.peakClose * (BPS - stop);
}

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0]?.symbol ?? 'CBBTC';
    closes.length = 0;
    barCount = 0;
    scoredBars = 0;
    holding = null;
    pendingBuyClose = null;
    pendingBuyKind = null;
    cooldownUntil = 0;
    traded = false;
  },
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === symbol);
    const currentClose = bar === undefined ? state.close(symbol) : BigInt(bar.c);
    if (bar !== undefined) {
      pushClose(BigInt(bar.c));
      if (!state.warmingUp) scoredBars++;
    }
    if (currentClose !== null) processFills(batch, currentClose);

    if (state.warmingUp || currentClose === null || bar === undefined) return [];

    const held = state.positions.get(symbol);
    if (held !== undefined) {
      const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SELL_SLIPPAGE_BPS };
      return exitSignal(currentClose) ? [sell] : [];
    }

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const kind = barCount > cooldownUntil ? entryKind() : null;
    if (kind !== null) {
      const room = state.weightRoom(symbol);
      const notional = state.cash < room ? state.cash : room;
      if (notional >= minNotional) {
        pendingBuyClose = currentClose;
        pendingBuyKind = kind;
        const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }

    if (!traded && scoredBars >= FALLBACK_BAR && state.cash >= minNotional) {
      pendingBuyClose = currentClose;
      pendingBuyKind = 'cap';
      const probe: BuyInput = { side: 'buy', symbol, notional_quote_units: minNotional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [probe];
    }

    return [];
  },
});
