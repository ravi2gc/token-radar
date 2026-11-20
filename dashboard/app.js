// Token Launch Radar — dashboard logic. Reads board.json (one local file,
// no network) and renders the board, the per-protocol detail view, the
// filters and the method section. Hash routing: #p=<slug> opens a protocol,
// #f=status:pre-token,category:Lending applies a filter on load.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  var moneyFull = function (n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); };
  var pct = function (x, d) { return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; };
  var num = function (n, d) { return n == null ? '—' : n.toFixed(d == null ? 2 : d); };
  var fmtAge = function (d) { return d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; };
  var fmtChg = function (c) { return c == null ? '—' : (c > 0 ? '+' : '') + c.toFixed(1) + '%'; };

  var board = null, rows = [], model = null;
  var state = { q: '', cat: '', chain: '', status: 'pre-token', sort: 'value', watch: false };
  var detailSlug = null;
  var MAX_ROWS = 100;

  function catCounts() {
    var m = {};
    rows.forEach(function (r) {
      var k = r.category || '(none)';
      m[k] = m[k] || { total: 0, traded: 0 };
      m[k].total++;
      if (r.status === 'launched') m[k].traded++;
    });
    return m;
  }

  function applyFilters() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.status && r.status !== state.status) return false;
      if (state.watch && !r.watchlist) return false;
      if (state.cat && (r.category || '') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d);
      if (key === 'age') return b.age_days - a.age_days;
      if (key === 'odds') return (b.token_odds || 0) - (a.token_odds || 0);
      return b.implied_value_usd - a.implied_value_usd;
    });
    return list;
  }

  function renderBoard() {
    var list = applyFilters();
    var tb = $('rows');
    var html = '';
    list.slice(0, MAX_ROWS).forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' + (detailSlug === r.slug ? ' class="sel"' : '') + '>'
        + '<td class="num">' + (r.radar_rank == null ? '—' : '#' + r.radar_rank) + '</td>'
        + '<td class="num">' + r.rank + '</td>'
        + '<td><span class="nm">' + esc(r.name) + '</span><br><span class="sl">' + esc(r.slug) + '</span>'
        + (r.watchlist ? ' <span class="tag watch">watchlist</span>' : '')
        + (r.status === 'pre-token' && !r.launch_candidate ? ' <span class="tag nc">non-candidate</span>' : '') + '</td>'
        + '<td>' + esc(r.category || '—') + '</td>'
        + '<td>' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>'
        + '<td class="num">' + money(r.tvl_usd) + '</td>'
        + '<td class="num">' + fmtChg(r.change_7d) + '</td>'
        + '<td class="num">' + fmtAge(r.age_days) + '</td>'
        + '<td class="num">' + (r.token_odds == null ? '—' : pct(r.token_odds, 0)) + '</td>'
        + '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>'
        + '<td class="num">' + money(r.launch_value_usd) + '</td></tr>';
    });
    tb.innerHTML = html || '<tr><td colspan="11">No protocols match these filters.</td></tr>';
    $('count').textContent = 'Showing ' + Math.min(list.length, MAX_ROWS) + ' of ' + list.length
      + ' matching protocols · ' + board.counts.pre_token + ' pre-token of ' + board.counts.total + ' in the snapshot';
    $('shownote').textContent = list.length > MAX_ROWS
      ? 'First ' + MAX_ROWS + ' rows shown — narrow the filters to see more.' : '';
  }

  function breakdown(r) {
    if (r.status !== 'pre-token' && !r.mcap_missing) return null;
    var c = model.coefficients;
    var grp = model.intercept_groups.indexOf(r.category) >= 0 ? r.category : 'other categories';
    var logTvl = Math.log10(Math.max(1, r.tvl_usd));
    var logAge = Math.log10(r.age_days + 1);
    var growth = Math.max(-50, Math.min(200, r.change_7d == null ? 0 : r.change_7d)) / 100;
    var terms = [
      { term: 'Category intercept (' + grp + ')', value: 1, coef: c.intercepts[grp], contrib: c.intercepts[grp] },
      { term: 'log10(TVL) = ' + logTvl.toFixed(2), value: logTvl, coef: c.log_tvl, contrib: logTvl * c.log_tvl },
      { term: 'log10(age + 1) = ' + logAge.toFixed(2), value: logAge, coef: c.log_age, contrib: logAge * c.log_age },
      { term: '7-day growth term = ' + growth.toFixed(2), value: growth, coef: c.growth, contrib: growth * c.growth },
    ];
    var sum = terms.reduce(function (s, t) { return s + t.contrib; }, 0);
    return { terms: terms, sum: sum };
  }

  function comps(r) {
    var peers = rows.filter(function (x) {
      return x.status === 'launched' && (x.category || '') === (r.category || '');
    }).map(function (x) {
      return { x: x, d: Math.abs(Math.log10(x.tvl_usd) - Math.log10(Math.max(1, r.tvl_usd))) };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, 5).map(function (o) { return o.x; });
    return peers;
  }

  function renderDetail() {
    var el = $('detail');
    var r = rows.find(function (x) { return x.slug === detailSlug; });
    if (!r) { el.hidden = true; return; }
    var bd = breakdown(r);
    var counts = catCounts();
    var cc = counts[r.category || '(none)'] || { total: 0, traded: 0 };
    var why;
    if (bd && r.mcap_missing) {
      var mainM = bd.terms.slice(1).sort(function (a, b) { return b.contrib - a.contrib; })[0];
      why = 'This protocol records a token, but the snapshot carries no usable market cap for it, so it is valued at the fitted launch value instead of an actual market cap. The fit is driven most by '
        + mainM.term.split(' = ')[0] + ' (contribution ' + mainM.contrib.toFixed(2) + ' to log10 value). TVL ' + money(r.tvl_usd)
        + ' at ' + fmtAge(r.age_days) + ' old, with ' + fmtChg(r.change_7d) + ' over 7 days.';
    } else if (bd) {
      var main = bd.terms.slice(1).sort(function (a, b) { return b.contrib - a.contrib; })[0];
      why = 'The fitted launch value is driven most by ' + main.term.split(' = ')[0]
        + ' (contribution ' + main.contrib.toFixed(2) + ' to log10 value). TVL ' + money(r.tvl_usd)
        + ' at ' + fmtAge(r.age_days) + ' old, with ' + fmtChg(r.change_7d) + ' over 7 days. Token odds '
        + pct(r.token_odds, 0) + ' come from its category: ' + cc.traded + ' of ' + cc.total
        + ' protocols in ' + (r.category || 'no category') + ' record a traded token, smoothed toward the global rate '
        + pct(model.global_token_rate, 0) + '.';
      if (!r.launch_candidate) {
        why += ' It is treated as a non-candidate under the house watchlist rule (' + r.exclusion_reason
          + '), so token odds are floored at 2%.';
      }
    } else {
      why = 'This protocol already records a token that trades, so its implied value is the actual market cap '
        + moneyFull(r.mcap_usd) + ' — no fitted value, no odds, no farm. It is shown so the board separates what has launched from what has not.';
    }
    var peers = comps(r);
    var compRows = peers.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td class="num">' + money(x.tvl_usd) + '</td>'
        + '<td class="num">' + money(x.mcap_usd) + '</td><td class="num">' + (x.mcap_usd / x.tvl_usd).toFixed(2) + 'x</td></tr>';
    }).join('');
    var bdRows = bd ? bd.terms.map(function (t) {
      return '<tr><td>' + esc(t.term) + '</td><td class="num">' + num(t.coef, 3) + '</td><td class="num">' + t.contrib.toFixed(2) + '</td></tr>';
    }).join('') + '<tr><td><b>Fitted log10(launch value) — sum</b></td><td></td><td class="num"><b>' + bd.sum.toFixed(2) + '</b></td></tr>' : '';

    var n = r.farm_steps.length;
    var stepCost = r.farm_cost_usd > 0 ? Math.floor(r.farm_cost_usd / n) : 0;
    var steps = r.farm_steps.map(function (s, i) {
      var wk0 = Math.floor(i * r.farm_weeks / n) + 1;
      var wk1 = Math.floor((i + 1) * r.farm_weeks / n);
      if (wk1 < wk0) wk1 = wk0;
      var cost = r.farm_cost_usd > 0 ? ' · ≈ $' + (i === 0 ? r.farm_cost_usd - stepCost * (n - 1) : stepCost) + ' gas/fees' : '';
      return '<li>' + esc(s) + '<br><span class="st">week ' + wk0 + '–' + wk1 + cost + '</span></li>';
    }).join('');

    var chainList = r.chains.slice(0, 8).join(', ') + (r.chains.length > 8 ? ' +' + (r.chains.length - 8) + ' more' : '');
    el.innerHTML = '<button type="button" id="back">← Back to board</button>'
      + '<h2>' + esc(r.name) + ' ' + (r.watchlist ? '<span class="tag watch">watchlist</span>' : '')
      + ' <span class="tag' + (r.status === 'launched' ? ' launched' : '') + '">' + r.status + '</span></h2>'
      + '<p class="meta">' + esc(r.category || 'No category') + ' · ' + esc(chainList)
      + ' · global rank #' + r.rank + (r.radar_rank ? ' · radar rank #' + r.radar_rank : '')
      + ' · TVL ' + money(r.tvl_usd) + ' · ' + fmtAge(r.age_days) + ' old</p>'
      + '<div class="cards">'
      + '<div class="card"><div class="k">Expected value</div><div class="v">' + money(r.implied_value_usd) + '</div><div class="s">fitted value × token odds</div></div>'
      + '<div class="card"><div class="k">Fitted launch value</div><div class="v">' + money(r.launch_value_usd) + '</div><div class="s">' + (r.status === 'pre-token' || r.mcap_missing ? 'from the regression on traded tokens' : 'actual market cap') + '</div></div>'
      + '<div class="card"><div class="k">Token odds</div><div class="v">' + (r.token_odds == null ? '—' : pct(r.token_odds, 0)) + '</div><div class="s">'
      + (r.token_odds == null ? 'no odds — token trades' : (r.launch_candidate ? 'smoothed category rate' : 'floored at 2% — non-candidate')) + '</div></div>'
      + '<div class="card"><div class="k">P10–P90 range</div><div class="v">' + money(r.value_lo_usd) + ' – ' + money(r.value_hi_usd) + '</div><div class="s">residual spread ×' + model.p10_p90_factor.toFixed(2) + '</div></div>'
      + '</div>'
      + '<p class="why"><b>Why this rank.</b> ' + esc(why) + '</p>'
      + '<h3>Nearest traded peers in ' + esc(r.category || 'the same category') + '</h3>'
      + (peers.length ? '<div class="tablewrap"><table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Mcap / TVL</th></tr></thead><tbody>'
        + compRows
        + '<tr><td><b>' + esc(r.name) + ' (fitted)</b></td><td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.launch_value_usd) + '</td><td class="num">' + (r.launch_value_usd / r.tvl_usd).toFixed(2) + 'x</td></tr>'
        + '</tbody></table></div>' : '<p>No traded peer shares this category in the snapshot.</p>')
      + (bd ? '<h3>Model breakdown — fitted log10(launch value)</h3>'
        + '<div class="tablewrap"><table><thead><tr><th>Term</th><th class="num">Coefficient</th><th class="num">Contribution</th></tr></thead><tbody>' + bdRows + '</tbody></table></div>' : '')
      + '<h3>Farm plan — ' + r.farm_weeks + ' weeks, estimated ' + (r.farm_cost_usd > 0 ? '$' + r.farm_cost_usd + ' gas and fees' : 'no farm cost') + '</h3>'
      + '<ol class="steps">' + steps + '</ol>'
      + '<p class="totals">Total: ≈ $' + r.farm_cost_usd + ' · ' + r.farm_weeks + ' weeks · ' + n + ' steps</p>'
      + '<p class="note">Data: DefiLlama snapshot as of ' + esc(board.as_of) + '. ' + esc(r.name)
      + (r.status === 'pre-token' ? ' records no token in this snapshot.' : ' records a token that trades.')
      + ' The snapshot carries no airdrop flag; this plan positions a wallet, it does not promise a token.</p>';
    el.hidden = false;
    $('back').addEventListener('click', function () { location.hash = ''; });
    document.querySelector('.tablewrap').style.display = 'none';
    document.querySelector('.controls').style.display = 'none';
    $('count').style.display = 'none';
    $('shownote').style.display = 'none';
    window.scrollTo(0, 0);
  }

  function closeDetail() {
    detailSlug = null;
    $('detail').hidden = true;
    document.querySelector('.tablewrap').style.display = '';
    document.querySelector('.controls').style.display = '';
    $('count').style.display = '';
    $('shownote').style.display = '';
    renderBoard();
  }

  function renderMethod() {
    var c = model.coefficients;
    var intRows = Object.keys(c.intercepts).sort().map(function (g) {
      return '<tr><td>Intercept — ' + esc(g) + '</td><td class="num">' + num(c.intercepts[g], 3) + '</td></tr>';
    }).join('');
    $('method-body').innerHTML =
      '<p><b>Model.</b> Fitted on the ' + model.n_traded + ' protocols in the snapshot whose token already trades with a recorded market cap above zero, by ordinary least squares (normal equations, solved in code — no libraries):</p>'
      + '<p><code>log10(market cap) = intercept[category] + ' + num(c.log_tvl, 3) + ' × log10(TVL) + ' + num(c.log_age, 3) + ' × log10(age in days + 1) + ' + num(c.growth, 3) + ' × growth</code></p>'
      + '<p>where growth is the 7-day TVL change clipped to −50…+200% and divided by 100 (missing growth counts as 0), and a missing listing date uses the traded median age of ' + model.median_age_days + ' days. Categories with at least 10 traded protocols get their own intercept; the rest share one. '
      + model.n_token_no_mcap + ' further protocols record a token but carry no usable market cap in the snapshot (market cap −1 or 0); they were left out of the fit and are valued at the fitted value instead.</p>'
      + '<div class="tablewrap"><table><thead><tr><th>Fitted coefficient</th><th class="num">Value</th></tr></thead><tbody>'
      + intRows
      + '<tr><td>log10(TVL)</td><td class="num">' + num(c.log_tvl, 3) + '</td></tr>'
      + '<tr><td>log10(age + 1)</td><td class="num">' + num(c.log_age, 3) + '</td></tr>'
      + '<tr><td>Growth term</td><td class="num">' + num(c.growth, 3) + '</td></tr>'
      + '</tbody></table></div>'
      + '<p><b>Validation — leave-one-out over all ' + model.n_traded + ' traded protocols.</b> Each protocol is predicted from a fit that never saw it. R² (in-sample) ' + num(model.r2, 3)
      + ' · median absolute error ' + num(model.loo_median_ape_pct, 1) + '% · ' + num(model.loo_within_2x_pct, 1)
      + '% of predictions within 2× of the actual market cap · residual standard deviation ' + num(model.residual_sd_log10, 3)
      + ' in log10, so the P10–P90 range multiplies the fitted value by ×' + num(model.p10_p90_factor, 2) + ' either way.</p>'
      + '<p><b>Token odds.</b> <code>odds = (traded in category + 4 × global rate) / (total in category + 4)</code>, global rate '
      + num(model.global_token_rate, 3) + ' (' + (model.n_total - model.n_pre_token) + ' of ' + model.n_total + '), clamped to 0.02–0.95. <b>Expected value</b> for a protocol that records no token is fitted launch value × odds; for one whose token trades, the actual market cap.</p>'
      + '<p><b>Launch candidates.</b> The house watchlist rule (RULES.txt, “The snapshot”) excludes a pre-token protocol as a launch candidate when its category is Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX, its name begins with an exchange name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini), ends in a version marker, or carries a whole word wrapped, staked or staking. '
      + model.n_non_candidate + ' of the ' + model.n_pre_token + ' pre-token protocols are non-candidates under that rule, and their token odds are floored at 2% — so a centralised exchange can never lead this board on TVL alone, and the top of the radar is protocols that could plausibly launch a token.</p>'
      + '<p><b>Limitations.</b> One snapshot, fetched 2026-11-14 — TVL, growth and ages are a single day\'s picture. The snapshot carries no airdrop flag, no revenue and no team or tokenomics data, so odds are a category base rate, not a prediction that a token will launch, and values are this entry\'s own claim. Farm costs are gas estimates by chain tier, not quotes.</p>';
  }

  function renderKpis() {
    var m = model;
    $('kpis').innerHTML =
      '<div class="kpi"><div class="k">Median expected · pre-token</div><div class="v">' + money(m.median_expected_pre_token_usd) + '</div><div class="s">across ' + m.n_pre_token + ' protocols</div></div>'
      + '<div class="kpi"><div class="k">Top expected value</div><div class="v">' + money(m.top_expected_pre_token_usd) + '</div><div class="s">best pre-token launch</div></div>'
      + '<div class="kpi"><div class="k">LOO median error</div><div class="v">' + num(m.loo_median_ape_pct, 1) + '%</div><div class="s">leave-one-out, ' + m.n_traded + ' traded</div></div>'
      + '<div class="kpi"><div class="k">Model R²</div><div class="v">' + num(m.r2, 3) + '</div><div class="s">' + num(m.loo_within_2x_pct, 0) + '% of LOO within 2×</div></div>'
      + '<div class="kpi"><div class="k">Watchlist covered</div><div class="v">' + m.n_watchlist + '/' + m.n_watchlist + '</div><div class="s">all ' + m.n_watchlist + ' on the board</div></div>';
  }

  function fillSelects() {
    var cats = {}, chains = {};
    rows.forEach(function (r) {
      if (r.category) cats[r.category] = 1;
      r.chains.forEach(function (c) { chains[c] = 1; });
    });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; $('cat').appendChild(o);
    });
    Object.keys(chains).sort().forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = c; $('chain').appendChild(o);
    });
  }

  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) { if (detailSlug) closeDetail(); return; }
    if (h.indexOf('p=') === 0) {
      var slug = decodeURIComponent(h.slice(2));
      if (rows.some(function (r) { return r.slug === slug; })) { detailSlug = slug; renderDetail(); renderBoard(); }
      return;
    }
    if (h.indexOf('f=') === 0) {
      closeDetail();
      h.slice(2).split(',').forEach(function (pair) {
        var kv = pair.split(':');
        var k = kv[0], v = kv.slice(1).join(':');
        if (k === 'status') { state.status = v; $('status').value = v; }
        if (k === 'category') { state.cat = v; $('cat').value = v; }
        if (k === 'chain') { state.chain = v; $('chain').value = v; }
        if (k === 'sort') { state.sort = v; $('sort').value = v; }
        if (k === 'q') { state.q = v; $('q').value = v; }
        if (k === 'watchlist') { state.watch = v === '1'; $('watch').checked = state.watch; }
      });
      renderBoard();
    }
  }

  function bind() {
    $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
    $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
    $('status').addEventListener('change', function (e) { state.status = e.target.value; renderBoard(); });
    $('watch').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });
    $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
    $('reset').addEventListener('click', function () {
      state = { q: '', cat: '', chain: '', status: 'pre-token', sort: 'value', watch: false };
      $('q').value = ''; $('cat').value = ''; $('chain').value = ''; $('status').value = 'pre-token'; $('sort').value = 'value'; $('watch').checked = false;
      renderBoard();
    });
    $('rows').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr) location.hash = 'p=' + tr.getAttribute('data-slug');
    });
    window.addEventListener('hashchange', parseHash);
  }

  fetch('../board.json').then(function (res) {
    if (!res.ok) throw new Error('board.json returned HTTP ' + res.status);
    return res.json();
  }).then(function (data) {
    board = data;
    rows = data.rows;
    model = data.model;
    $('meta').textContent = 'Snapshot ' + board.as_of + ' · Source: DefiLlama · Watchlist floor $50,000,000 · '
      + board.counts.total + ' protocols · ' + board.counts.pre_token + ' pre-token · ' + board.counts.watchlist + ' watchlist';
    renderKpis();
    fillSelects();
    bind();
    renderMethod();
    parseHash();
    if (!detailSlug) renderBoard();
  }).catch(function (err) {
    var e = $('error');
    e.hidden = false;
    e.textContent = 'Could not load the board data (board.json): ' + err.message
      + '. Serve the output directory over HTTP — opening this page from disk blocks the data load.';
    $('meta').textContent = 'Snapshot data failed to load.';
  });
})();
