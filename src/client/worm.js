// The worm: each player's score after each of their throws, as in cricket's run chase charts. Misses are hollow
// circles on the line (like wickets), going over the target shows as a drop back to half, and a dashed line marks
// the target. Returns HTML (a legend and an inline SVG), so it needs no library and scales to fit.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// series: [{ name, color, points: [{ y, miss }], dashed (drawn as a guide, e.g. a pace line) }]
// max: the top of the scale. target: a dashed line across (optional). xLabel/yLabel: the axes' names.
export function wormHTML(series, { max, target = null, xLabel = 'Throws', yLabel = 'Points' }) {
  const W = 320, H = 170, L = 30, R = 10, T = 10, B = 26;
  const n = Math.max(5, ...series.map(s => s.points.length));
  const x = i => L + (i / n) * (W - L - R), y = v => T + (1 - v / max) * (H - T - B);
  const step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 100 ? 25 : 30;
  const xStep = n <= 10 ? 1 : n <= 20 ? 2 : 5;
  let svg = '';
  // Gridlines, labels and the target
  for (let v = 0; v <= max; v += step) {
    svg += `<line class="wgrid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="wtick" x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
  }
  for (let i = xStep; i <= n; i += xStep) svg += `<text class="wtick" x="${x(i)}" y="${H - B + 13}" text-anchor="middle">${i}</text>`;
  if (target != null) svg += `<line class="wtarget" x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}"/>`;
  svg += `<line class="waxis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/><line class="waxis" x1="${L}" x2="${L}" y1="${T}" y2="${y(0)}"/>`;
  svg += `<text class="wlabel" x="${(L + W - R) / 2}" y="${H - 2}" text-anchor="middle">${esc(xLabel)}</text>`;
  svg += `<text class="wlabel" transform="translate(9 ${(T + y(0)) / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>`;
  // The worms: guides first, so the players' lines sit on top
  for (const s of [...series].sort((a, b) => !!b.dashed - !!a.dashed)) {
    const pts = [[x(0), y(0)], ...s.points.map((p, i) => [x(i + 1), y(Math.min(max, p.y))])];
    svg += `<polyline class="wline${s.dashed ? ' dashed' : ''}" stroke="${s.color}" points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>`;
    if (s.dashed) continue;
    s.points.forEach((p, i) => { if (p.miss) svg += `<circle class="wmiss" cx="${x(i + 1).toFixed(1)}" cy="${y(Math.min(max, p.y)).toFixed(1)}" r="3.4" stroke="${s.color}"/>`; });
    const last = pts[pts.length - 1];
    svg += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${s.color}"/>`;
  }
  const legend = series.map(s => `<span><i class="${s.dashed ? 'dashed' : ''}" style="--c:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="worm"><div class="wlegend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scores after each throw">${svg}</svg></div>`;
}
