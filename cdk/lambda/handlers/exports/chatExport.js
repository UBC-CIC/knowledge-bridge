async function build(exportRunId, run, { sqlConnection }) {
  let sessions;
  if (run.scope === 'all') {
    sessions = await sqlConnection`
      SELECT
        cs.id           AS session_id,
        cs.title,
        cs.created_at,
        cs.last_active_at,
        u.email         AS user_email,
        u.display_name  AS user_display_name,
        COALESCE(
          ARRAY_AGG(DISTINCT eg.display_name) FILTER (WHERE eg.display_name IS NOT NULL),
          ARRAY[]::text[]
        ) AS groups
      FROM chat_sessions cs
      JOIN users u ON u.id = cs.user_id
      LEFT JOIN user_memberships um ON um.user_id = u.id
      LEFT JOIN entra_groups eg ON eg.id = um.entra_group_id
      GROUP BY cs.id, u.email, u.display_name
      ORDER BY cs.created_at ASC
    `;
  } else if (run.scope === 'group') {
    sessions = await sqlConnection`
      SELECT
        cs.id           AS session_id,
        cs.title,
        cs.created_at,
        cs.last_active_at,
        u.email         AS user_email,
        u.display_name  AS user_display_name,
        ARRAY[eg_target.display_name] AS groups
      FROM chat_sessions cs
      JOIN users u ON u.id = cs.user_id
      JOIN user_memberships um ON um.user_id = u.id
      JOIN entra_groups eg_target ON eg_target.id = um.entra_group_id AND eg_target.id = ${run.scope_id}
      ORDER BY cs.created_at ASC
    `;
  } else if (run.scope === 'user') {
    sessions = await sqlConnection`
      SELECT
        cs.id           AS session_id,
        cs.title,
        cs.created_at,
        cs.last_active_at,
        u.email         AS user_email,
        u.display_name  AS user_display_name,
        COALESCE(
          ARRAY_AGG(DISTINCT eg.display_name) FILTER (WHERE eg.display_name IS NOT NULL),
          ARRAY[]::text[]
        ) AS groups
      FROM chat_sessions cs
      JOIN users u ON u.id = cs.user_id AND u.id = ${run.scope_id}
      LEFT JOIN user_memberships um ON um.user_id = u.id
      LEFT JOIN entra_groups eg ON eg.id = um.entra_group_id
      GROUP BY cs.id, u.email, u.display_name
      ORDER BY cs.created_at ASC
    `;
  } else {
    throw new Error(`Unsupported chat export scope: ${run.scope}`);
  }

  let scopeLabel = 'All Chats';
  if (run.scope === 'group' && sessions.length > 0) scopeLabel = sessions[0].groups[0] || 'Unknown Group';
  else if (run.scope === 'user' && sessions.length > 0) scopeLabel = sessions[0].user_email || 'Unknown User';

  let totalMessages = 0;
  const sessionObjects = [];

  for (const session of sessions) {
    const messages = await sqlConnection`
      SELECT
        cm.id           AS message_id,
        cm.sender,
        cm.content,
        cm.sources,
        cm.created_at,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'is_positive', mr.is_positive,
              'category', mr.category,
              'comment', mr.comment,
              'rated_by', ru.email,
              'created_at', mr.created_at
            )
          ) FILTER (WHERE mr.id IS NOT NULL),
          '[]'::json
        ) AS ratings
      FROM chat_messages cm
      LEFT JOIN message_ratings mr ON mr.message_id = cm.id
      LEFT JOIN users ru ON ru.id = mr.user_id
      WHERE cm.chat_session_id = ${session.session_id}
      GROUP BY cm.id
      ORDER BY cm.created_at ASC
    `;
    totalMessages += messages.length;
    sessionObjects.push({
      session_id: session.session_id,
      user_email: session.user_email,
      user_display_name: session.user_display_name,
      groups: session.groups,
      title: session.title,
      created_at: session.created_at,
      last_active_at: session.last_active_at,
      messages: messages.map(m => ({
        message_id: m.message_id,
        sender: m.sender,
        content: m.content,
        sources: m.sources,
        created_at: m.created_at,
        ratings: m.ratings,
      })),
    });
  }

  return {
    body: JSON.stringify({
      exported_at: new Date().toISOString(),
      scope: run.scope,
      scope_label: scopeLabel,
      total_sessions: sessions.length,
      total_messages: totalMessages,
      sessions: sessionObjects,
    }, null, 2),
    rowCount: totalMessages,
    contentDisposition: `attachment; filename="export-${exportRunId}.json"`,
    notification: {
      title: 'Export ready',
      message: `Your "${scopeLabel}" export is complete — ${sessions.length} sessions, ${totalMessages} messages.`,
      metadata: { scope_label: scopeLabel },
    },
  };
}

module.exports = { build };
