/**
 * HTML-рендер дашборда (F11): только escaped текст, без JS.
 */
import { escapeHtml } from './escape.ts';
import type { AuditRow, DashboardData, PendingRow, QueueRow, SkillRow } from './queries.ts';

function fmtTs(ts: number): string {
  return new Date(ts).toISOString();
}

function pct(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${Math.round(rate * 100)}%`;
}

function queueTable(title: string, rows: QueueRow[]): string {
  if (rows.length === 0) return `<h2>${escapeHtml(title)}</h2><p class="empty">(пусто)</p>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.id}</td><td>${escapeHtml(r.provenance)}</td><td class="mono">${escapeHtml(r.payloadPreview)}</td><td>${escapeHtml(fmtTs(r.createdAt))}</td><td>${escapeHtml(r.claimedBy ?? '—')}</td></tr>`,
    )
    .join('');
  return `<h2>${escapeHtml(title)}</h2>
<table><thead><tr><th>id</th><th>provenance</th><th>payload</th><th>created</th><th>claimed</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function pendingSection(rows: PendingRow[]): string {
  if (rows.length === 0) return '<h2>Pending approvals</h2><p class="empty">(нет ожидающих)</p>';
  const body = rows
    .map(
      (r) =>
        `<tr><td class="mono">${escapeHtml(r.token)}</td><td>${escapeHtml(r.actionId)}</td><td>${r.chatId}</td><td>${escapeHtml(fmtTs(r.expiresAt))}</td>
<td class="hint">Подтвердите в paired-канале: <code>/approve ${escapeHtml(r.token)}</code></td></tr>`,
    )
    .join('');
  return `<h2>Pending approvals</h2>
<p class="note">Дашборд не подтверждает действия — только подсказка.</p>
<table><thead><tr><th>token</th><th>action</th><th>chat</th><th>expires</th><th>hint</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function auditSection(tail: AuditRow[], chainOk: boolean, entries: number, brokenAt?: number): string {
  const status = chainOk
    ? `<span class="ok">✓ chain OK (${entries} entries)</span>`
    : `<span class="bad">✗ chain BROKEN at id ${brokenAt ?? '?'}</span>`;
  const body = tail
    .map(
      (r) =>
        `<tr><td>${r.id}</td><td>${escapeHtml(fmtTs(r.ts))}</td><td>${escapeHtml(r.actor)}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.decision)}</td></tr>`,
    )
    .join('');
  return `<h2>Audit log</h2><p>${status}</p>
<table><thead><tr><th>id</th><th>ts</th><th>actor</th><th>action</th><th>decision</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

function skillsTable(skills: SkillRow[]): string {
  if (skills.length === 0) return '<h2>Skills</h2><p class="empty">(нет навыков)</p>';
  const body = skills
    .map((s) => {
      const flags = [
        s.code ? 'code' : 'data',
        s.requiresReview ? 'requires_review' : 'ok',
      ].join(', ');
      const last = s.lastUsedAt ? fmtTs(s.lastUsedAt) : '—';
      return `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.version)}</td><td>${escapeHtml(flags)}</td><td>${s.invocations}</td><td>${s.successes}</td><td>${escapeHtml(last)}</td></tr>`;
    })
    .join('');
  return `<h2>Skills</h2>
<table><thead><tr><th>name</th><th>version</th><th>status</th><th>invocations</th><th>successes</th><th>last used</th></tr></thead>
<tbody>${body}</tbody></table>`;
}

export function renderDashboard(data: DashboardData): string {
  const cur = data.lastCuration
    ? `Snapshot #${data.lastCuration.snapshotId} (${escapeHtml(data.lastCuration.reason)}) at ${escapeHtml(fmtTs(data.lastCuration.createdAt))}`
    : data.lastCurationAudit
      ? `Last audit curation.completed at ${escapeHtml(fmtTs(data.lastCurationAudit.ts))}`
      : '(нет данных о курации)';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>AEGIS Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;background:#0f1115;color:#e6e8ec;line-height:1.45}
h1{font-size:1.35rem} h2{font-size:1.05rem;margin-top:1.75rem;color:#9ecbff}
table{border-collapse:collapse;width:100%;font-size:.85rem;margin-top:.5rem}
th,td{border:1px solid #2a3140;padding:.35rem .5rem;text-align:left;vertical-align:top}
th{background:#1a2030}.mono{font-family:ui-monospace,monospace;word-break:break-word}
.ok{color:#6ee7a0}.bad{color:#f87171}.empty,.note{color:#94a3b8}
.hint code{background:#1e293b;padding:.1rem .25rem;border-radius:3px}
footer{margin-top:2rem;font-size:.75rem;color:#64748b}
</style>
</head>
<body>
<h1>AEGIS — read-only dashboard</h1>
<p>Generated ${escapeHtml(fmtTs(data.generatedAt))} · write surface = <strong>0</strong></p>

<h2>Metrics</h2>
<ul>
<li>Reuse rate: ${escapeHtml(pct(data.reuse.reuseRate))} (${data.reuse.used}/${data.reuse.injectable} knowledge)</li>
<li>Skill reuse: ${escapeHtml(pct(data.skillReuse.reuseRate))} (${data.skillReuse.used}/${data.skillReuse.tracked} skills)</li>
<li>Budget ${escapeHtml(data.budget.day)}: ${data.budget.used}/${data.budget.limit} tokens${data.budget.backgroundBlocked ? ' · background blocked' : ''}</li>
</ul>

<h2>Last curation</h2>
<p>${cur}</p>

${pendingSection(data.pending)}
${queueTable('Inbound queue', data.inbound)}
${queueTable('Outbound queue', data.outbound)}
${auditSection(data.auditTail, data.auditChainOk, data.auditEntries, data.auditBrokenAtId)}
${skillsTable(data.skills)}

<footer>Read-only · bind localhost · approve only via paired channel</footer>
</body>
</html>`;
}
