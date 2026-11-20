// Token Launch Radar — value model.
//
// The model is fitted on the snapshot itself: the protocols whose token
// already trades with a recorded market cap above zero teach us what a token
// function of TVL, age and recent growth, per category. A protocol that
// records no token gets a fitted launch value from that regression, times
// the odds that a protocol in its category ever records a token at all.
// Every number below comes from the snapshot plus this fit. No protocol
// name, slug or value is hardcoded anywhere in this file.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelMeta {
  n_traded: number;
  n_token_no_mcap: number;
  n_total: number;
  n_pre_token: number;
  n_watchlist: number;
  n_non_candidate: number;
  median_age_days: number;
  global_token_rate: number;
  intercept_groups: string[];
  coefficients: {
    intercepts: Record<string, number>;
    log_tvl: number;
    log_age: number;
    growth: number;
  };
  r2: number;
  loo_median_ape_pct: number;
  loo_within_2x_pct: number;
  residual_sd_log10: number;
  p10_p90_factor: number;
  median_expected_pre_token_usd: number;
  top_expected_pre_token_usd: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  radar_rank: number | null;
  status: 'pre-token' | 'launched';
  watchlist: boolean;
  launch_candidate: boolean;
  exclusion_reason: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  mcap_usd: number | null;
  mcap_missing: boolean;
  implied_value_usd: number;
  launch_value_usd: number;
  token_odds: number | null;
  value_lo_usd: number;
  value_hi_usd: number;
  farm_steps: string[];
  farm_cost_usd: number;
  farm_weeks: number;
}

export interface Board {
  as_of: string;
  source: string;
  floor_usd: number;
  counts: { total: number; pre_token: number; launched: number; watchlist: number };
  model: ModelMeta;
  rows: BoardRow[];
}

// ------------------------------------------------------------ utilities

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days between the snapshot date and the day DefiLlama began tracking. */
export function ageDays(listedAt: string | null, asOf: string, fallback: number): number {
  if (listedAt === null) return fallback;
  const diff = Math.round((parseDay(asOf) - parseDay(listedAt)) / DAY_MS);
  return diff < 0 ? 0 : diff;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

const log10 = (x: number): number => Math.log10(x);

// ------------------------------------------------------------ OLS fit

interface Features {
  group: string; // intercept group for this protocol
  logTvl: number;
  logAge: number;
  growth: number;
}

function featuresOf(p: SnapshotProtocol, age: number, groupOf: (p: SnapshotProtocol) => string): Features {
  return {
    group: groupOf(p),
    logTvl: log10(Math.max(1, p.tvl_usd)),
    logAge: log10(age + 1),
    growth: clamp(p.change_7d ?? 0, -50, 200) / 100,
  };
}

/** Solve A x = b by Gaussian elimination with partial pivoting. A is n x n. */
function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('singular normal equations');
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

interface Fit {
  groups: string[];
  beta: number[]; // [intercept per group..., logTvl, logAge, growth]
}

function designRow(f: Features, groups: string[]): number[] {
  const row = new Array<number>(groups.length + 3).fill(0);
  row[groups.indexOf(f.group)] = 1;
  row[groups.length] = f.logTvl;
  row[groups.length + 1] = f.logAge;
  row[groups.length + 2] = f.growth;
  return row;
}

/** Ordinary least squares of y on the design matrix. Returns coefficients. */
function ols(design: number[][], y: number[]): number[] {
  const p = design[0].length;
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i];
    for (let a = 0; a < p; a++) {
      xty[a] += row[a] * y[i];
      for (let b = 0; b < p; b++) xtx[a][b] += row[a] * row[b];
    }
  }
  return solveLinear(xtx, xty);
}

function predictWith(fit: Fit, f: Features): number {
  const row = designRow(f, fit.groups);
  let s = 0;
  for (let i = 0; i < row.length; i++) s += row[i] * fit.beta[i];
  return s;
}

// ------------------------------------------------------------ farm plans

type FarmGroup =
  | 'lending'
  | 'dex'
  | 'derivatives'
  | 'yield'
  | 'staking'
  | 'rwa'
  | 'bridge'
  | 'other';

function farmGroup(category: string | null): FarmGroup {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lending')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('derivat') || c.includes('perp') || c.includes('options')) return 'derivatives';
  if (c.includes('yield')) return 'yield';
  if (c.includes('stak') || c.includes('restak')) return 'staking';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c.includes('bridge')) return 'bridge';
  return 'other';
}

interface GasTier {
  label: string;
  perTx: number;
}

function gasTier(chain: string): GasTier {
  if (chain === 'Ethereum') return { label: 'Ethereum gas, roughly $3–8 per transaction', perTx: 5 };
  if (chain === 'Arbitrum' || chain === 'Optimism' || chain === 'Base')
    return { label: 'layer-2 gas, roughly $0.20–1 per transaction', perTx: 0.6 };
  if (chain === 'Solana') return { label: 'Solana fees, roughly $0.01 per transaction', perTx: 0.01 };
  return { label: 'gas on this chain, roughly $0.50–2 per transaction', perTx: 1.25 };
}

function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 2000;
  if (tvl >= 200_000_000) return 1000;
  if (tvl >= 50_000_000) return 500;
  return 250;
}

function weeksFor(age: number): number {
  if (age < 180) return 12;
  if (age < 365) return 10;
  if (age < 730) return 8;
  return 6;
}

function txCountFor(group: FarmGroup): number {
  switch (group) {
    case 'lending': return 14;
    case 'dex': return 16;
    case 'derivatives': return 12;
    case 'yield': return 10;
    case 'staking': return 8;
    case 'rwa': return 8;
    case 'bridge': return 10;
    default: return 10;
  }
}

interface FarmPlan {
  steps: string[];
  costUsd: number;
  weeks: number;
}

function buildFarmPlan(p: SnapshotProtocol, age: number): FarmPlan {
  const chain1 = p.chains[0] ?? 'its main chain';
  const chain2 = p.chains[1] ?? null;
  const gas = gasTier(chain1);
  const capital = capitalFor(p.tvl_usd);
  const weeks = weeksFor(age);
  const group = farmGroup(p.category);
  const txs = txCountFor(group);
  const cost = Math.max(1, Math.round(txs * gas.perTx + 4));
  const name = p.name;

  if (p.mcap_usd !== null) {
    const capLine =
      p.mcap_usd > 0
        ? `${name} already records a token that trades, with a market cap near $${Math.round(p.mcap_usd).toLocaleString('en-US')}, so there is no pre-launch farm left here — the plan below is monitoring, not farming.`
        : `${name} already records a token, but the snapshot carries no usable market cap for it, so there is no pre-launch farm left here — the plan below is monitoring, not farming.`;
    return {
      costUsd: 0,
      weeks,
      steps: [
        capLine,
        `If you hold the token, keep the position small, at most 1–2% of a portfolio, and set a review date ${weeks} weeks out rather than checking the price daily.`,
        `Watch TVL, any token unlock schedule and the protocol's announcements weekly; a sharp TVL fall matters more than a short-term price move.`,
        `Revisit the position only when TVL, revenue or the roadmap changes — do not chase short-term price moves or rumours of a second token.`,
      ],
    };
  }

  const gasLine = `Budget ${gas.label} and about ${txs} transactions across the whole plan, roughly $${cost} of gas and fees in total.`;
  const claimLine = `After ${weeks} weeks, unwind the position, claim anything earned, and watch the protocol's announcements for any claim window — the snapshot carries no airdrop flag, so a token is never promised.`;
  const watchLine = `Check the position and the protocol's announcements weekly, and keep a short log of each action with its date, so the history is easy to show later.`;

  let steps: string[];
  switch (group) {
    case 'lending':
      steps = [
        `Deposit about $${capital} in stablecoins into ${name} on ${chain1} as collateral, starting with one asset you already hold so the position is easy to unwind.`,
        `Borrow a modest amount, 30–50% of the deposit, against it and loop the borrow back into a second deposit once, keeping the health factor above 2.`,
        `Repeat a small deposit-and-borrow cycle every 1–2 weeks for ${weeks} weeks, so the position shows steady use rather than one burst of activity.`,
        gasLine,
        watchLine,
        claimLine,
      ];
      break;
    case 'dex':
      steps = [
        `Provide about $${capital} of liquidity to a ${name} pool on ${chain1}, choosing a pair you already hold to avoid a forced swap into an asset you do not want.`,
        `Keep the position open for at least ${weeks} weeks, rebalancing only when the price moves more than about 10% out of range.`,
        `Swap a small amount through the protocol once a week, about $${Math.round(capital / 10)} each time, so the wallet shows trading as well as liquidity.`,
        gasLine,
        `Track the fees earned and any impermanent loss weekly; exit the pool and claim fees if the position drifts badly out of range.`,
        claimLine,
      ];
      break;
    case 'derivatives':
      steps = [
        `Open a first small position on ${name} on ${chain1} with about $${capital} of margin, using 2–3x leverage at most and a stop-loss on every trade.`,
        `Trade once or twice a week for ${weeks} weeks, keeping each position under 10% of the margin so no single trade dominates the history.`,
        `Close losers quickly and let winners run to a planned target; the goal is consistent activity, not one big win.`,
        gasLine,
        `Review open interest, funding and your profit and loss weekly, and cut position size if volatility spikes.`,
        claimLine,
      ];
      break;
    case 'yield':
      steps = [
        `Deposit about $${capital} into a ${name} vault on ${chain1}, starting with a single vault so deposits and rewards stay easy to track.`,
        `Let the vault compound for ${weeks} weeks, adding a small top-up every two weeks rather than one large deposit up front.`,
        `Harvest or restake rewards monthly instead of daily, to keep gas costs down on ${chain1}.`,
        gasLine,
        `Check the vault's yield and strategy weekly; move funds if the vault's TVL falls sharply or its strategy changes without warning.`,
        claimLine,
      ];
      break;
    case 'staking':
      steps = [
        `Stake about $${capital} through ${name} on ${chain1}, using the protocol's own staking flow rather than a third-party wrapper.`,
        `Keep the stake in place for the full ${weeks}-week horizon, and unstake early only if the protocol's terms change in a material way.`,
        `Restake rewards once a month to compound, instead of paying gas on ${chain1} every week.`,
        gasLine,
        watchLine,
        claimLine,
      ];
      break;
    case 'rwa':
      steps = [
        `Buy about $${capital} of the protocol's tokenised real-world asset through ${name} on ${chain1}, after reading its offering documents and checking who holds the underlying asset.`,
        `Hold the position for the full ${weeks}-week horizon and collect any yield distributions as they arrive.`,
        `Add a small top-up once midway if the asset's terms and yield stay attractive, rather than doubling down in one move.`,
        gasLine,
        `Check the underlying asset's reports and the protocol's announcements weekly, and note anything that changes the redemption terms.`,
        claimLine,
      ];
      break;
    case 'bridge':
      steps = [
        `Bridge a small test amount, about $25, through ${name} on ${chain1} first and confirm it arrives before moving anything larger.`,
        chain2
          ? `Move about $${capital} across in 2–3 tranches over the first two weeks, between ${chain1} and ${chain2}, rather than one large transfer.`
          : `Move about $${capital} across in 2–3 tranches over the first two weeks rather than one large transfer.`,
        `Use the bridge again every 1–2 weeks for ${weeks} weeks, varying the direction when the protocol supports it.`,
        gasLine,
        `Check bridge times, fees and any delays weekly, and keep a record of each transfer with its date and amount.`,
        claimLine,
      ];
      break;
    default:
      steps = [
        `Use ${name} on ${chain1} with about $${capital} of capital, starting with a small test transaction to confirm the flow works before committing more.`,
        `Repeat the protocol's core action once a week for ${weeks} weeks, so the wallet shows steady use over time rather than a single visit.`,
        `Keep position sizes modest and avoid putting the whole amount into a single transaction.`,
        gasLine,
        watchLine,
        claimLine,
      ];
  }
  return { steps, costUsd: cost, weeks };
}

// ------------------------------------------------------------ the board

export function buildBoard(snapshot: Snapshot): Board {
  const asOf = snapshot.as_of;
  const protocols = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const watchSet = new Set(snapshot.watchlist);
  const traded = protocols.filter((p) => p.mcap_usd !== null);
  const preToken = protocols.filter((p) => p.mcap_usd === null);
  // The fit needs a real market cap: 16 protocols record a token but carry
  // mcap_usd of -1 or 0 in the snapshot (no usable market cap), so the
  // regression trains on the 128 with mcap_usd > 0. Those 16 still count as
  // launched — they record a token — and get the fitted value instead.
  const fitSet = traded.filter((p) => (p.mcap_usd as number) > 0);

  // Median age of the fitted protocols fills in for a missing listed_at.
  const tradedAges = fitSet.map((p) =>
    p.listed_at === null ? null : Math.max(0, Math.round((parseDay(asOf) - parseDay(p.listed_at)) / DAY_MS)),
  ).filter((a): a is number => a !== null);
  const medianAge = Math.round(median(tradedAges));

  const ageOf = (p: SnapshotProtocol): number => ageDays(p.listed_at, asOf, medianAge);

  // Intercept groups: categories with at least 10 traded protocols get their
  // own intercept; every other protocol shares one global intercept.
  // "Traded" here is the snapshot's own definition (mcap_usd != null, 144),
  // even though the fit itself can only use the 128 with a usable market cap.
  const tradedByCat = new Map<string, number>();
  for (const p of traded) tradedByCat.set(p.category ?? '', (tradedByCat.get(p.category ?? '') ?? 0) + 1);
  const ownGroups = [...tradedByCat.entries()]
    .filter(([, n]) => n >= 10)
    .map(([c]) => c)
    .sort();
  const groups = [...ownGroups, '__other__'];
  const groupOf = (p: SnapshotProtocol): string =>
    ownGroups.includes(p.category ?? '') ? (p.category as string) : '__other__';

  // --- Fit on the protocols with a usable market cap: log10(mcap) ~ group + log10(tvl) + log10(age+1) + growth.
  const fitData = fitSet.map((p) => ({ f: featuresOf(p, ageOf(p), groupOf), y: log10(p.mcap_usd as number) }));
  const design = fitData.map((d) => designRow(d.f, groups));
  const beta = ols(design, fitData.map((d) => d.y));
  const fit: Fit = { groups, beta };

  // --- In-sample validation.
  const n = fitSet.length;
  const pCount = beta.length;
  let ssRes = 0;
  let ssTot = 0;
  const yMean = fitData.reduce((s, d) => s + d.y, 0) / n;
  const fittedLog: number[] = [];
  for (const d of fitData) {
    const pred = predictWith(fit, d.f);
    fittedLog.push(pred);
    ssRes += (d.y - pred) ** 2;
    ssTot += (d.y - yMean) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;
  const sd = Math.sqrt(ssRes / Math.max(1, n - pCount));
  const p10p90 = Math.pow(10, 1.2816 * sd);

  // --- Leave-one-out validation: refit without each fitted protocol.
  const apes: number[] = [];
  let within2x = 0;
  for (let i = 0; i < n; i++) {
    const sub = fitData.filter((_, j) => j !== i);
    const b = ols(sub.map((d) => designRow(d.f, groups)), sub.map((d) => d.y));
    const looFit: Fit = { groups, beta: b };
    const pred = Math.pow(10, predictWith(looFit, fitData[i].f));
    const actual = fitSet[i].mcap_usd as number;
    const ape = Math.abs(pred - actual) / actual;
    apes.push(ape);
    if (pred >= actual / 2 && pred <= actual * 2) within2x++;
  }
  apes.sort((a, b) => a - b);
  const looMedianApe = median(apes) * 100;
  const looWithin2x = (within2x / n) * 100;

  // --- Token odds per category: Laplace-smoothed share of protocols in the
  // category that already record a traded token.
  const globalRate = traded.length / protocols.length;
  const byCat = new Map<string, { total: number; tradedN: number }>();
  for (const p of protocols) {
    const key = p.category ?? '';
    const e = byCat.get(key) ?? { total: 0, tradedN: 0 };
    e.total++;
    if (p.mcap_usd !== null) e.tradedN++;
    byCat.set(key, e);
  }
  const oddsOf = (p: SnapshotProtocol): number => {
    const e = byCat.get(p.category ?? '') ?? { total: 0, tradedN: 0 };
    const odds = (e.tradedN + 4 * globalRate) / (e.total + 4);
    return clamp(odds, 0.02, 0.95);
  };

  // --- Launch candidacy: the house's own watchlist exclusion rule
  // (RULES.txt, "The snapshot"), applied uniformly from the snapshot's own
  // fields. A pre-token protocol is a NON-CANDIDATE when ANY of these hold:
  // its category is Bridge, Canonical Bridge, Liquid Staking, Liquid
  // Restaking, Restaked BTC or CEX; its name begins with an exchange's name
  // (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini);
  // its name ends in a version marker (a space followed by V2, v2, 2.0 or
  // the like); or its name carries a whole word wrapped, staked or staking
  // in any case. Non-candidates keep their fitted launch value but their
  // token odds are floored at 0.02, the existing odds floor, so an exchange
  // that will never launch a token cannot lead the board on TVL alone.
  const EXCLUDED_CATEGORIES = new Set([
    'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
  ]);
  const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
  const VERSION_SUFFIX = /\s([vV]\d+(\.\d+)*|\d+\.\d+(\.\d+)*)$/;
  const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

  interface Candidacy {
    candidate: boolean;
    reason: string | null;
  }

  function candidacyOf(p: SnapshotProtocol): Candidacy {
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
      return {
        candidate: false,
        reason: p.category === 'CEX' ? 'CEX category' : 'excluded category: ' + p.category,
      };
    }
    if (EXCHANGE_PREFIX.test(p.name)) return { candidate: false, reason: 'exchange-named' };
    if (VERSION_SUFFIX.test(p.name)) return { candidate: false, reason: 'versioned name' };
    if (WRAPPED_WORD.test(p.name)) return { candidate: false, reason: 'wrapped/staked product' };
    return { candidate: true, reason: null };
  }

  // --- Build rows.
  interface Scored {
    p: SnapshotProtocol;
    age: number;
    fitted: number;
    odds: number | null;
    cand: Candidacy;
    implied: number;
    launch: number;
    lo: number;
    hi: number;
  }
  const launchedCand: Candidacy = { candidate: false, reason: 'token already trades' };
  const scored: Scored[] = protocols.map((p) => {
    const age = ageOf(p);
    if (p.mcap_usd !== null && p.mcap_usd > 0) {
      const mcap = p.mcap_usd;
      return { p, age, fitted: mcap, odds: null, cand: launchedCand, implied: Math.round(mcap), launch: Math.round(mcap), lo: Math.round(mcap), hi: Math.round(mcap) };
    }
    const f = featuresOf(p, age, groupOf);
    const fitted = Math.pow(10, predictWith(fit, f));
    if (p.mcap_usd !== null) {
      // Records a token but the snapshot carries no usable market cap:
      // value it at the fitted value, with the residual spread and no odds.
      const lo = fitted * Math.pow(10, -1.2816 * sd);
      const hi = fitted * Math.pow(10, 1.2816 * sd);
      return {
        p, age, fitted, odds: null, cand: launchedCand,
        implied: Math.max(1, Math.round(fitted)),
        launch: Math.max(1, Math.round(fitted)),
        lo: Math.max(1, Math.round(lo)), hi: Math.max(1, Math.round(hi)),
      };
    }
    const cand = candidacyOf(p);
    const odds = cand.candidate ? oddsOf(p) : 0.02;
    const expected = fitted * odds;
    const lo = fitted * Math.pow(10, -1.2816 * sd) * odds;
    const hi = fitted * Math.pow(10, 1.2816 * sd) * odds;
    return {
      p,
      age,
      fitted,
      odds,
      cand,
      implied: Math.max(1, Math.round(expected)),
      launch: Math.max(1, Math.round(fitted)),
      lo: Math.max(1, Math.round(lo)),
      hi: Math.max(1, Math.round(hi)),
    };
  });

  // Rank all protocols by implied value descending, slug ascending on ties.
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  let radar = 0;
  const rows: BoardRow[] = scored.map((s, i) => {
    const isPre = s.p.mcap_usd === null;
    if (isPre) radar++;
    const plan = buildFarmPlan(s.p, s.age);
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      radar_rank: isPre ? radar : null,
      status: isPre ? 'pre-token' : 'launched',
      watchlist: watchSet.has(s.p.slug),
      launch_candidate: s.cand.candidate,
      exclusion_reason: s.cand.reason,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      mcap_usd: s.p.mcap_usd,
      mcap_missing: s.p.mcap_usd !== null && s.p.mcap_usd <= 0,
      implied_value_usd: s.implied,
      launch_value_usd: s.launch,
      token_odds: s.odds,
      value_lo_usd: s.lo,
      value_hi_usd: s.hi,
      farm_steps: plan.steps,
      farm_cost_usd: plan.costUsd,
      farm_weeks: plan.weeks,
    };
  });

  const preExpected = rows.filter((r) => r.status === 'pre-token').map((r) => r.implied_value_usd);
  const intercepts: Record<string, number> = {};
  groups.forEach((g, i) => {
    intercepts[g === '__other__' ? 'other categories' : g] = beta[i];
  });

  const model: ModelMeta = {
    n_traded: fitSet.length,
    n_token_no_mcap: traded.length - fitSet.length,
    n_total: protocols.length,
    n_pre_token: preToken.length,
    n_watchlist: snapshot.watchlist.length,
    n_non_candidate: rows.filter((r) => r.status === 'pre-token' && !r.launch_candidate).length,
    median_age_days: medianAge,
    global_token_rate: globalRate,
    intercept_groups: groups.map((g) => (g === '__other__' ? 'other categories' : g)),
    coefficients: {
      intercepts,
      log_tvl: beta[groups.length],
      log_age: beta[groups.length + 1],
      growth: beta[groups.length + 2],
    },
    r2,
    loo_median_ape_pct: looMedianApe,
    loo_within_2x_pct: looWithin2x,
    residual_sd_log10: sd,
    p10_p90_factor: p10p90,
    median_expected_pre_token_usd: Math.round(median(preExpected)),
    top_expected_pre_token_usd: Math.max(...preExpected),
  };

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    counts: { total: protocols.length, pre_token: preToken.length, launched: traded.length, watchlist: snapshot.watchlist.length },
    model,
    rows,
  };
}
