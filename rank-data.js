(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RankData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function valid(row) {
    return Boolean(row && row.status === 'ok' && !row.error &&
      Number.isInteger(row.resultsChecked) && row.resultsChecked > 0 &&
      (row.rank === null || (Number.isInteger(row.rank) && row.rank > 0 && row.rank <= row.resultsChecked)));
  }
  function label(row) {
    if (!valid(row)) return row?.status === 'skipped' ? 'Not checked' : row?.status === 'error' ? 'Check failed' : 'Unverified data';
    return row.rank === null ? `Not found among ${row.resultsChecked} observed results` : `Observed #${row.rank}`;
  }
  function mergeHistory(history, results, date) {
    const next = JSON.parse(JSON.stringify(history));
    for (const [site, data] of Object.entries(results)) {
      for (const [keyword, row] of Object.entries(data.keywords || {})) {
        if (!valid(row)) continue;
        if (!next[site]) next[site] = {};
        next[site][keyword] = { rank: row.rank, status: 'ok', resultsChecked: row.resultsChecked, checkedAt: row.checkedAt, date };
      }
    }
    return next;
  }
  function summarize(results) {
    const rows = Object.values(results).flatMap(site => Object.values(site.keywords || {}));
    const successful = rows.filter(valid).length;
    const skipped = rows.filter(r=>r.status === 'skipped').length;
    const notAttempted = rows.filter(r=>r.attempted === false || r.status === 'skipped').length;
    return { total: rows.length, successful, failed: rows.length - successful - skipped, skipped, notAttempted,
      status: rows.length && successful === rows.length ? 'ok' : successful ? 'partial' : 'error' };
  }
  function reportStatusText(latest) {
    const report = latest?.report;
    if (!report || !latest.attemptId || report.attemptId !== latest.attemptId) return 'Report status unavailable; email delivery is not verified.';
    if (report.status === 'accepted') return 'Report accepted by email provider. Inbox delivery is not verified.';
    if (report.status === 'failed') return `Report not sent: ${report.error?.message || 'Email provider rejected the request.'}`;
    if (report.status === 'not_configured') return 'Report not sent: email API key is not configured.';
    if (report.status === 'sending' || report.status === 'unknown') return 'Report send outcome unknown; do not assume delivery or retry the same attempt.';
    return 'Report not yet sent for this collection attempt.';
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  return { valid, label, mergeHistory, summarize, reportStatusText, escapeHtml };
});

