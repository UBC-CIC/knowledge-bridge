async function build(exportRunId, run, { sqlConnection }) {
  const meta = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : (run.metadata ?? {});
  const rawGroupId = meta.groupId;
  const timeRangeParam = meta.timeRange ?? null;
  const isAllTime = timeRangeParam === 'all' || !timeRangeParam;

  let startDateIso = null;
  if (!isAllTime) {
    let daysBack = 90;
    const m = String(timeRangeParam).match(/^(\d+)([dmy])$/);
    if (m) {
      const value = parseInt(m[1], 10);
      const unit = m[2];
      if (unit === 'd') daysBack = value;
      if (unit === 'm') daysBack = value * 30;
      if (unit === 'y') daysBack = value * 365;
    }
    daysBack = Math.min(Math.max(1, daysBack), 365);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    startDateIso = startDate.toISOString();
  }

  // groupId can be: a single UUID string, an array of UUIDs, or "all"/null
  let groupsToExport;
  if (Array.isArray(rawGroupId) && rawGroupId.length > 0) {
    groupsToExport = await sqlConnection`SELECT id, display_name FROM entra_groups WHERE id = ANY(${rawGroupId}) ORDER BY display_name ASC`;
  } else if (rawGroupId && rawGroupId !== 'all') {
    const [grp] = await sqlConnection`SELECT id, display_name FROM entra_groups WHERE id = ${rawGroupId} LIMIT 1`;
    groupsToExport = grp ? [grp] : [];
  } else {
    groupsToExport = await sqlConnection`SELECT id, display_name FROM entra_groups ORDER BY display_name ASC`;
    groupsToExport = [{ id: null, display_name: 'All' }, ...groupsToExport];
  }

  const csvRows = ['date,group,users,chat_sessions,questions'];

  for (const grp of groupsToExport) {
    let rows;
    if (!grp.id && !startDateIso) {
      rows = await sqlConnection`
        WITH date_series AS (
          SELECT generate_series(DATE_TRUNC('day', (SELECT MIN(created_at) FROM chat_sessions)), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date
        ),
        dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs GROUP BY 1),
        dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id WHERE cm.sender = 'user' GROUP BY 1)
        SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
        FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
      `;
    } else if (!grp.id) {
      rows = await sqlConnection`
        WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
        dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs WHERE cs.created_at >= ${startDateIso} GROUP BY 1),
        dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1)
        SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
        FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
      `;
    } else if (!startDateIso) {
      rows = await sqlConnection`
        WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', (SELECT MIN(cs.created_at) FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id})), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
        dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} GROUP BY 1),
        dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cm.sender = 'user' GROUP BY 1)
        SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
        FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
      `;
    } else {
      rows = await sqlConnection`
        WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
        dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cs.created_at >= ${startDateIso} GROUP BY 1),
        dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1)
        SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
        FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
      `;
    }
    const groupLabel = grp.display_name.replace(/"/g, '""');
    for (const r of rows) {
      csvRows.push(`${r.date},"${groupLabel}",${r.users},${r.chat_sessions},${r.questions}`);
    }
  }

  const scopeLabel = Array.isArray(rawGroupId) && rawGroupId.length > 0
    ? groupsToExport.map(g => g.display_name).join(', ')
    : (rawGroupId && rawGroupId !== 'all')
      ? (groupsToExport[0]?.display_name ?? 'group')
      : 'All Groups';
  const rowCount = csvRows.length - 1;

  return {
    body: csvRows.join('\n'),
    rowCount,
    contentDisposition: `attachment; filename="analytics-${exportRunId}.csv"`,
    notification: {
      title: 'Analytics export ready',
      message: `Your analytics CSV export (${scopeLabel}) is ready — ${rowCount} rows.`,
      metadata: { scope_label: scopeLabel },
    },
  };
}

module.exports = { build };
