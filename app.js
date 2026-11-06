const BASE = 'https://raw.githubusercontent.com/iambenfinnie/seo-monitor/main';
const {valid,label,escapeHtml:escape} = RankData;
async function loadJson(file) {
  try { const r = await fetch(`${BASE}/${file}`,{cache:'no-store'}); return r.ok ? await r.json() : null; }
  catch { return null; }
}
function rankClass(row) {
  if (!valid(row) || row.rank === null) return 'notfound';
  return row.rank <= 3 ? 'top3' : row.rank <= 10 ? 'top10' : row.rank <= 20 ? 'top20' : '';
}
function changeHtml(row) {
  if (!valid(row) || row.change === null || row.change === undefined) return '<span class="change flat">unknown</span>';
  return row.change > 0 ? `<span class="change up">▲${row.change}</span>` : row.change < 0 ? `<span class="change down">▼${Math.abs(row.change)}</span>` : '<span class="change flat">—</span>';
}
async function render() {
  const app = document.getElementById('app');
  const [history,latest] = await Promise.all([loadJson('rank-history.json'),loadJson('latest-run.json')]);
  const date = latest && /^\d{4}-\d{2}-\d{2}$/.test(latest.date) ? latest.date : new Date().toISOString().slice(0,10);
  const loadedSnapshot = await loadJson(`snapshot-${date}.json`);
  const snapshot = loadedSnapshot && Object.keys(loadedSnapshot).length ? loadedSnapshot : null;
  const dates = Object.values(history || {}).flatMap(rows=>Object.values(rows).map(r=>r.checkedAt || r.date).filter(Boolean)).sort();
  document.getElementById('last-updated').textContent = latest?.finishedAt
    ? `Latest attempt: ${latest.finishedAt}`
    : dates.length ? `Stored data through: ${dates.at(-1)}` : 'No verified collection timestamp';
  const stale = latest && Date.now() - Date.parse(latest.finishedAt) > 36*60*60*1000;
  document.getElementById('collection-status').textContent = latest
    ? `${stale ? 'Stale collection. ' : ''}Latest attempt: ${latest.status}; ${latest.successful}/${latest.total} usable checks; ${latest.notAttempted ?? latest.skipped ?? 0} not attempted. ${latest.error ? latest.error.message + ' ' : ''}${snapshot ? 'Failed checks do not establish rankings.' : 'Snapshot unavailable; showing stored history, not current ranks.'}`
    : 'Collection status unavailable. Legacy records lack validation and are not reliable ranking evidence.';
  document.getElementById('report-status').textContent = RankData.reportStatusText(latest);
  if (!snapshot && !history) { app.innerHTML = '<p class="no-data">Rank data could not be loaded.</p>'; return; }
  let html = '';
  for (const [site,data] of Object.entries(snapshot || history)) {
    html += `<div class="site-block"><div class="site-title">${escape(site)}</div><table><thead><tr><th>Keyword</th><th>Observation</th><th>Change</th><th>Last valid observation</th><th>Checked</th></tr></thead><tbody>`;
    for (const [keyword,row] of Object.entries(snapshot ? data.keywords || {} : data)) {
      const previous = history?.[site]?.[keyword];
      const last = valid(previous) ? `${label(previous)} (${previous.checkedAt || previous.date || 'date unknown'})` : 'None verified';
      html += `<tr><td>${escape(keyword)}</td><td><span class="rank ${rankClass(row)}">${escape(label(row))}</span>${row.error ? `<br><small>${escape(row.error.message)}</small>` : ''}</td><td>${changeHtml(row)}</td><td>${escape(last)}</td><td>${escape(row.checkedAt || row.date || 'unknown')}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  app.innerHTML = html;
}
render().catch(() => { document.getElementById('collection-status').textContent = 'Unable to render collection data; rankings are unknown.'; });

