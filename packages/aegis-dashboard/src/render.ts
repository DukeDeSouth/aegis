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

function pendingHint(required: string | null, token: string): string {
  if (required === 'discord') return `Confirm in Discord: /approve ${token}`;
  if (required === 'telegram') return `Confirm in Telegram: /approve ${token}`;
  if (required === 'totp') return `Confirm with TOTP: /approve ${token} &lt;6-digit-code&gt;`;
  return `Confirm in paired channel: /approve ${token}`;
}

function pendingSection(rows: PendingRow[]): string {
  if (rows.length === 0) return '<h2>Pending approvals</h2><p class="empty">(нет ожидающих)</p>';
  const body = rows
    .map(
      (r) =>
        `<tr><td class="mono">${escapeHtml(r.token)}</td><td>${escapeHtml(r.actionId)}</td><td>${escapeHtml(r.originSessionId)}</td><td>${escapeHtml(fmtTs(r.expiresAt))}</td>
<td class="hint">${escapeHtml(pendingHint(r.requiredChannel, r.token))}</td></tr>`,
    )
    .join('');
  return `<h2>Pending approvals</h2>
<p class="note">Дашборд не подтверждает действия — только подсказка.</p>
<table><thead><tr><th>token</th><th>action</th><th>origin</th><th>expires</th><th>hint</th></tr></thead>
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

function connectorsTable(
  servers: import('./config.ts').McpServerSummary[],
  stats: import('./config.ts').ConnectorAuditStat[],
): string {
  if (servers.length === 0) {
    return '<h2>MCP connectors</h2><p class="empty">(none in aegis.config.json)</p>';
  }
  const statMap = new Map(stats.map((s) => [s.server, s]));
  const body = servers
    .map((s) => {
      const st = statMap.get(s.name);
      const last = st?.lastCallAt ? fmtTs(st.lastCallAt) : '—';
      const calls = st?.callCount ?? 0;
      return `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.transport)}</td><td>${s.toolCount}</td><td>${calls}</td><td>${escapeHtml(last)}</td></tr>`;
    })
    .join('');
  return `<h2>MCP connectors</h2>
<table><thead><tr><th>server</th><th>transport</th><th>tools</th><th>calls</th><th>last call</th></tr></thead>
<tbody>${body}</tbody></table>
<p class="note">Per-server call counts from audit action <code>mcp.tool.&lt;name&gt;</code>.</p>`;
}

export function renderConnectorsPage(data: DashboardData): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>AEGIS — Connectors</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;background:#0f1115;color:#e6e8ec;line-height:1.45}
h1{font-size:1.35rem} h2{font-size:1.05rem;margin-top:1.75rem;color:#9ecbff}
table{border-collapse:collapse;width:100%;font-size:.85rem;margin-top:.5rem}
th,td{border:1px solid #2a3140;padding:.35rem .5rem;text-align:left}
th{background:#1a2030}.empty,.note{color:#94a3b8}
footer{margin-top:2rem;font-size:.75rem;color:#64748b}
a{color:#9ecbff}
</style>
</head>
<body>
<h1>AEGIS — MCP connectors</h1>
<p>Generated ${escapeHtml(fmtTs(data.generatedAt))} · <a href="/">← dashboard</a></p>
${connectorsTable(data.mcpServers, data.connectorStats)}
<footer>Read-only · GET only</footer>
</body>
</html>`;
}

function hostHealthBanner(health: import('./queries.ts').HostHealthStatus): string {
  if (health.ok) {
    return '<p class="ok">Host: ok · loop alive</p>';
  }
  if (health.probeError) {
    return `<p class="bad">Host: down · ${escapeHtml(health.probeError)}</p>`;
  }
  if (!health.loopAlive) {
    const last = health.lastTickAt ? fmtTs(health.lastTickAt) : 'never';
    return `<p class="bad">Host: degraded · loop stale (last tick ${escapeHtml(last)})</p>`;
  }
  return '<p class="bad">Host: unknown</p>';
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
${hostHealthBanner(data.hostHealth)}

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

<p><a href="/connectors">MCP connectors →</a></p>

<footer>Read-only · bind localhost · approve only via paired channel</footer>
</body>
</html>`;
}
