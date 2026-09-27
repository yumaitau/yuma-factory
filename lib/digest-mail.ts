import { APP_NAME } from '@/lib/brand';
import { LANE_LABELS, OUTSTANDING_LANES, type OutstandingSnapshot } from '@/lib/outstanding';

const PER_LANE = 25;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function digestSubject(snapshot: OutstandingSnapshot): string {
  const attention = snapshot.counts.attention;
  const suffix = snapshot.total === 0
    ? 'all clear'
    : attention > 0
      ? `${attention} need attention`
      : `${snapshot.total} outstanding`;
  return `Factory outstanding · ${snapshot.sydneyDate} · ${suffix}`;
}

export function digestText(snapshot: OutstandingSnapshot): string {
  const lines = [
    `${APP_NAME} outstanding for ${snapshot.sydneyDate}`,
    snapshot.boardUrl,
    '',
  ];
  if (snapshot.total === 0) {
    lines.push('Nothing outstanding.');
    return lines.join('\n');
  }
  for (const lane of OUTSTANDING_LANES) {
    const items = snapshot.lanes[lane];
    if (!items.length) continue;
    lines.push(`${LANE_LABELS[lane]} (${items.length})`);
    for (const item of items.slice(0, PER_LANE)) {
      lines.push(`- ${item.repo}#${item.number} ${item.title}`);
      lines.push(`  ${item.reason}`);
      lines.push(`  ${item.htmlUrl}`);
    }
    if (items.length > PER_LANE) lines.push(`- … ${items.length - PER_LANE} more`);
    lines.push('');
  }
  if (snapshot.pulls.length) {
    lines.push(`PRs to review (${snapshot.pulls.length})`);
    for (const pull of snapshot.pulls.slice(0, PER_LANE)) {
      lines.push(`- ${pull.repo}#${pull.number} ${pull.title}${pull.draft ? ' (draft)' : ''}`);
      lines.push(`  ${pull.url}`);
    }
    lines.push('');
  }
  if (snapshot.unavailableRepos.length) {
    lines.push(`GitHub unavailable: ${snapshot.unavailableRepos.join(', ')}`);
  }
  return lines.join('\n').trimEnd();
}

export function digestHtml(snapshot: OutstandingSnapshot): string {
  const sections: string[] = [];
  for (const lane of OUTSTANDING_LANES) {
    const items = snapshot.lanes[lane];
    if (!items.length) continue;
    const rows = items.slice(0, PER_LANE).map((item) =>
      `<tr><td style="padding:8px 0;border-bottom:1px solid #e7e0d8;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#1c1917;">
        <a href="${escapeHtml(item.htmlUrl)}" style="color:#d74c2f;text-decoration:none;font-weight:600;">${escapeHtml(item.repo)}#${item.number}</a>
        <div>${escapeHtml(item.title)}</div>
        <div style="color:#78716c;font-size:12px;margin-top:4px;">${escapeHtml(item.reason)}</div>
      </td></tr>`).join('');
    const extra = items.length > PER_LANE ? `<p style="color:#78716c;font-size:12px;">${items.length - PER_LANE} more on the board.</p>` : '';
    sections.push(`<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1c1917;margin:24px 0 8px;">${LANE_LABELS[lane]} (${items.length})</h2><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>${extra}`);
  }
  if (snapshot.pulls.length) {
    const rows = snapshot.pulls.slice(0, PER_LANE).map((pull) =>
      `<tr><td style="padding:8px 0;border-bottom:1px solid #e7e0d8;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#1c1917;">
        <a href="${escapeHtml(pull.url)}" style="color:#d74c2f;text-decoration:none;font-weight:600;">${escapeHtml(pull.repo)}#${pull.number}</a>
        <div>${escapeHtml(pull.title)}${pull.draft ? ' (draft)' : ''}</div>
      </td></tr>`).join('');
    sections.push(`<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#1c1917;margin:24px 0 8px;">PRs to review (${snapshot.pulls.length})</h2><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`);
  }
  const body = snapshot.total === 0
    ? '<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1c1917;">Nothing outstanding.</p>'
    : sections.join('');
  const unavailable = snapshot.unavailableRepos.length
    ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#78716c;">GitHub unavailable: ${escapeHtml(snapshot.unavailableRepos.join(', '))}</p>`
    : '';
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:0;background:#faf5ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ee;"><tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e0d8;">
    <tr><td style="background:#1c1917;padding:24px 28px;">
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#d74c2f;">${escapeHtml(APP_NAME.toUpperCase())}</p>
      <p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:22px;color:#fff8f5;">Outstanding ${escapeHtml(snapshot.sydneyDate)}</p>
    </td></tr>
    <tr><td style="padding:28px;">
      <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#78716c;">${snapshot.total} open item${snapshot.total === 1 ? '' : 's'} · <a href="${escapeHtml(snapshot.boardUrl)}" style="color:#d74c2f;">Open the work board</a></p>
      ${body}${unavailable}
    </td></tr>
  </table>
  </td></tr></table>
  </body></html>`;
}

export function digestMail(snapshot: OutstandingSnapshot) {
  return { subject: digestSubject(snapshot), text: digestText(snapshot), html: digestHtml(snapshot) };
}