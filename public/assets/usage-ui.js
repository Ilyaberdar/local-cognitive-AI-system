// Settings → Usage (spec §10): lifetime tokens, a period's input and output, and Token Activity by
// day, week and cumulatively. The numbers come from the main process (the account's Cloud totals
// plus this computer's unsent part) and, when a server is connected, its unsent part too.

const KEYS = ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens', 'requestsWithoutUsage'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const empty = () => Object.fromEntries(KEYS.map(key => [key, 0]));
const add = (target, source) => { for (const key of KEYS) target[key] += Number(source?.[key] ?? 0) || 0; return target; };
const DAY_MS = 86_400_000;
export const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** Monday-based weekday: 0 is Monday. */
const weekday = date => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
export const mondayOf = date => shiftDate(date, -weekday(date));

const whole = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const formatTokens = (value, short = false) => (short ? compact : whole).format(Math.round(Number(value) || 0));
const dayLabel = date => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const shortDate = date => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const longDate = instant => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(instant));

/** A connected server's unsent part, added where it belongs: nothing in it is in the Cloud's totals. */
export function withServerPending(overview, pending, host) {
  const days = new Map(overview.days.map(day => [day.date, { ...day }]));
  for (const day of pending.days || []) days.set(day.date, add(days.get(day.date) || { date: day.date, ...empty() }, day));
  const sources = overview.sources.map(source => ({ ...source }));
  const tokens = Number(pending.lifetime?.totalTokens) || 0;
  if (Number(pending.lifetime?.requests)) {
    const known = sources.find(source => source.id === host.hostId);
    if (known) known.totalTokens += tokens;
    else sources.push({ id: host.hostId, kind: 'host', name: host.hostName || pending.name || null, here: false, totalTokens: tokens });
  }
  return { ...overview, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), sources,
    lifetime: add({ ...overview.lifetime }, pending.lifetime), before: add({ ...overview.before }, pending.before),
    firstEventAt: [overview.firstEventAt, pending.firstEventAt].filter(Boolean).sort()[0] || null };
}

/** Totals of the last 7 or 30 days (today included) or of this calendar month. */
export function periodTotals(days, period, today) {
  const start = period === 'month' ? `${today.slice(0, 7)}-01` : shiftDate(today, period === '7d' ? -6 : -29);
  return days.filter(day => day.date >= start && day.date <= today).reduce((total, day) => add(total, day), empty());
}

/** Weeks from Monday, the last `count` of them, empty ones included. */
export function weeklyTotals(days, today, count = 26) {
  const last = mondayOf(today), byWeek = new Map();
  for (const day of days) { const week = mondayOf(day.date); byWeek.set(week, add(byWeek.get(week) || empty(), day)); }
  return Array.from({ length: count }, (_, index) => { const start = shiftDate(last, (index - count + 1) * 7); return { start, ...(byWeek.get(start) || empty()) }; });
}

/** The running total by day over the window, starting with everything before it. */
export function cumulativeTotals(days, before, from, today) {
  const byDate = new Map(days.map(day => [day.date, day.totalTokens]));
  const points = [];
  let total = Number(before?.totalTokens) || 0;
  for (let date = from; date <= today; date = shiftDate(date, 1)) { total += byDate.get(date) || 0; points.push({ date, total }); }
  return points;
}

function heatmap(days, today) {
  const byDate = new Map(days.map(day => [day.date, day]));
  const start = shiftDate(mondayOf(today), -52 * 7);
  const values = days.filter(day => day.date >= start).map(day => day.totalTokens).filter(value => value > 0);
  const max = Math.max(0, ...values);
  const cells = [];
  for (let date = start; date <= shiftDate(mondayOf(today), 6); date = shiftDate(date, 1)) {
    if (date > today) { cells.push('<span class="usage-cell is-future" aria-hidden="true"></span>'); continue; }
    const total = byDate.get(date)?.totalTokens || 0;
    // A square root keeps one large day from flattening the rest.
    const level = total && max ? Math.max(1, Math.ceil(4 * Math.sqrt(total / max))) : 0;
    cells.push(`<span class="usage-cell" data-level="${level}" title="${escape(`${dayLabel(date)}: ${formatTokens(total)} tokens`)}"></span>`);
  }
  const months = [];
  for (let week = 0; week < 53; week++) {
    const monday = shiftDate(start, week * 7), previous = shiftDate(monday, -7);
    if (week === 0 || monday.slice(5, 7) !== previous.slice(5, 7)) months.push(`<span style="grid-column:${week + 1}">${escape(new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(new Date(`${monday}T00:00:00Z`)))}</span>`);
  }
  return `<div class="usage-heatmap-scroll"><div class="usage-heatmap"><div class="usage-heatmap-months">${months.join('')}</div><div class="usage-heatmap-days" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span></div><div class="usage-heatmap-grid" role="img" aria-label="Tokens by day over the last year">${cells.join('')}</div></div></div>
    <div class="usage-heatmap-legend" aria-hidden="true"><span>Less</span>${[0, 1, 2, 3, 4].map(level => `<span class="usage-cell" data-level="${level}"></span>`).join('')}<span>More</span></div>`;
}

function weeklyChart(weeks) {
  const max = Math.max(1, ...weeks.map(week => week.totalTokens));
  const width = 100 / weeks.length;
  return `<svg class="usage-chart" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Tokens by week, the last ${weeks.length} weeks">${weeks.map((week, index) => {
    const height = week.totalTokens ? Math.max(0.6, 38 * week.totalTokens / max) : 0;
    return `<rect x="${(index * width + width * 0.15).toFixed(3)}" y="${(40 - height).toFixed(3)}" width="${(width * 0.7).toFixed(3)}" height="${height.toFixed(3)}" rx="0.6"><title>${escape(`Week of ${shortDate(week.start)}: ${formatTokens(week.totalTokens)} tokens`)}</title></rect>`;
  }).join('')}</svg><div class="usage-axis"><span>${escape(shortDate(weeks[0].start))}</span><span>${escape(shortDate(weeks.at(-1).start))}</span></div>`;
}

function cumulativeChart(points) {
  const max = Math.max(1, ...points.map(point => point.total));
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const line = points.map((point, index) => `${(index * step).toFixed(3)},${(40 - 38 * point.total / max).toFixed(3)}`).join(' ');
  return `<svg class="usage-chart is-line" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${escape(`Cumulative tokens: ${formatTokens(points.at(-1)?.total)}`)}"><polyline points="0,40 ${line} 100,40" class="usage-area" /><polyline points="${line}" class="usage-line" vector-effect="non-scaling-stroke" /></svg><div class="usage-axis"><span>${escape(shortDate(points[0].date))}</span><span>${escape(`${formatTokens(points.at(-1)?.total, true)} by ${shortDate(points.at(-1).date)}`)}</span></div>`;
}

function statusText(view) {
  const { overview, server } = view;
  const parts = [];
  if (overview.state === 'cloud') parts.push(`Your account on every computer and server, as of ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(overview.asOf))}.`);
  else if (overview.state === 'offline') parts.push('The Cloud could not be reached: this shows only what ran on this computer.');
  else parts.push('Signed out: this shows only what ran on this computer. Sign in to see your account across computers and servers.');
  if (overview.unsentHere) parts.push(`${formatTokens(overview.unsentHere)} ${overview.unsentHere === 1 ? 'request' : 'requests'} from this computer ${overview.unsentHere === 1 ? 'is' : 'are'} not sent yet and ${overview.unsentHere === 1 ? 'is' : 'are'} included.`);
  if (server?.error) parts.push(`${server.name} could not be asked for what it has not sent yet; that part is missing.`);
  else if (server?.unsent) parts.push(`${server.name}: ${formatTokens(server.unsent)} not yet sent ${server.unsent === 1 ? 'request is' : 'requests are'} included.`);
  return parts.join(' ');
}

export function usagePageHtml(view, choice) {
  if (view.loading && !view.overview) return '<div class="usage-loading" role="status"><span class="button-spinner" aria-hidden="true"></span>Loading usage…</div>';
  if (view.error && !view.overview) return `<div class="settings-empty" role="alert"><h2>Usage could not be loaded</h2><p>${escape(view.error)}</p><div class="settings-empty-actions"><button type="button" class="ghost-button" data-usage-refresh>Try again</button></div></div>`;
  const overview = view.overview, today = overview.to;
  const life = overview.lifetime;
  const period = periodTotals(overview.days, choice.period, today);
  const known = period.inputTokens + period.outputTokens;
  const tabs = (name, items, value) => `<div class="usage-tabs" role="tablist">${items.map(([id, label]) => `<button type="button" role="tab" data-usage-${name}="${id}" aria-selected="${id === value}">${label}</button>`).join('')}</div>`;
  const sourceName = source => source.here ? 'This computer' : source.kind === 'host' ? source.name || 'A server' : 'Another computer';
  const since = overview.firstEventAt || overview.ledgerStartedAt;
  return `<div class="usage-page">
    <p class="settings-description usage-status" role="status">${escape(statusText(view))}</p>
    <section class="usage-card usage-lifetime">
      <div class="usage-card-head"><h2>Lifetime tokens</h2><button type="button" class="ghost-button usage-refresh" data-usage-refresh ${view.loading ? 'disabled' : ''}>${view.loading ? '<span class="button-spinner" aria-hidden="true"></span>Refreshing…' : 'Refresh'}</button></div>
      <div class="usage-big">${escape(formatTokens(life.totalTokens))}</div>
      <p class="usage-sub">Input ${escape(formatTokens(life.inputTokens))} · Output ${escape(formatTokens(life.outputTokens))}${life.cachedInputTokens ? ` · ${escape(formatTokens(life.cachedInputTokens))} of the input from a prompt cache` : ''}${life.reasoningTokens ? ` · ${escape(formatTokens(life.reasoningTokens))} of the output reasoning` : ''}</p>
      <p class="usage-sub">Since ${escape(longDate(since))}. Activity before usage recording started is not included.</p>
      ${life.requestsWithoutUsage ? `<p class="usage-sub">${escape(formatTokens(life.requestsWithoutUsage))} ${life.requestsWithoutUsage === 1 ? 'request' : 'requests'} without a token report from the provider ${life.requestsWithoutUsage === 1 ? 'is' : 'are'} not counted.</p>` : ''}
    </section>
    <section class="usage-card">
      <div class="usage-card-head"><h2>Period</h2>${tabs('period', [['7d', '7 days'], ['30d', '30 days'], ['month', 'This month']], choice.period)}</div>
      <div class="usage-period-total">${escape(formatTokens(period.totalTokens))} <small>tokens</small></div>
      <div class="usage-bar" aria-hidden="true">${known ? `<span class="is-input" style="width:${(100 * period.inputTokens / known).toFixed(2)}%"></span><span class="is-output" style="width:${(100 * period.outputTokens / known).toFixed(2)}%"></span>` : ''}</div>
      <p class="usage-legend"><span class="usage-key is-input"></span>Input ${escape(formatTokens(period.inputTokens))}<span class="usage-key is-output"></span>Output ${escape(formatTokens(period.outputTokens))}<span class="usage-legend-note">${escape(formatTokens(period.requests))} ${period.requests === 1 ? 'request' : 'requests'}</span></p>
    </section>
    <section class="usage-card">
      <div class="usage-card-head"><h2>Token Activity</h2>${tabs('activity', [['daily', 'Daily'], ['weekly', 'Weekly'], ['cumulative', 'Cumulative']], choice.activity)}</div>
      ${choice.activity === 'weekly' ? weeklyChart(weeklyTotals(overview.days, today)) : choice.activity === 'cumulative' ? cumulativeChart(cumulativeTotals(overview.days, overview.before, overview.from, today)) : heatmap(overview.days, today)}
      <p class="usage-sub">Days and weeks (from Monday) in ${escape(overview.timeZone)}.</p>
    </section>
    ${overview.sources.length ? `<section class="usage-card"><div class="usage-card-head"><h2>Where it ran</h2></div><div class="usage-sources">${overview.sources.map(source => `<div class="usage-source"><span>${escape(sourceName(source))}</span><span>${escape(formatTokens(source.totalTokens))}</span></div>`).join('')}</div></section>` : ''}
  </div>`;
}

/** Mounts the page; returns its disposer. */
export function mountUsagePage(container, { usage = window.desktopUsage, remote = window.desktopRemote } = {}) {
  if (!container) return () => {};
  const choice = { period: '7d', activity: 'daily' };
  const view = { loading: true, overview: null, error: '', server: null };
  let disposed = false, generation = 0;
  const paint = () => { if (!disposed) container.innerHTML = usagePageHtml(view, choice); };
  const load = async () => {
    const mine = ++generation;
    view.loading = true; paint();
    try {
      if (!usage?.overview) throw new Error('Usage is shown in the desktop app.');
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await usage.overview({ timeZone });
      if (!result?.ok) throw new Error(result?.error?.message || 'Usage could not be loaded.');
      let overview = result.value, server = null;
      // A connected server adds what it has not sent to the Cloud yet.
      const status = overview.state !== 'local' ? (await remote?.status?.().catch(() => undefined))?.value : undefined;
      if (status?.state === 'connected' && status.hostId && (status.capabilities || []).includes('usage.pending')) {
        const name = status.hostName || 'The server';
        const pending = await remote.runtime.request('usage.pending', { timeZone: overview.timeZone, from: overview.from, ...(overview.asOf ? { asOf: overview.asOf } : {}) }, status.hostId).catch(error => ({ ok: false, error }));
        if (pending?.ok && pending.value?.available) { overview = withServerPending(overview, pending.value, status); server = { name, unsent: pending.value.unsent }; }
        else server = { name, error: true };
      }
      if (mine !== generation) return;
      Object.assign(view, { overview, server, error: '' });
    } catch (error) {
      if (mine !== generation) return;
      view.error = error instanceof Error ? error.message : String(error);
    }
    view.loading = false; paint();
  };
  const onClick = event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.usageRefresh !== undefined) { void load(); return; }
    if (target.dataset.usagePeriod) { choice.period = target.dataset.usagePeriod; paint(); }
    if (target.dataset.usageActivity) { choice.activity = target.dataset.usageActivity; paint(); }
  };
  container.addEventListener('click', onClick);
  void load();
  return () => { disposed = true; container.removeEventListener('click', onClick); };
}
