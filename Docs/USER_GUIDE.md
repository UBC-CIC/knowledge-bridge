# User Guide

**Please ensure the application is deployed, instructions in the deployment guide here:**

- [Deployment Guide](./DEPLOYMENT_GUIDE.md)

Once you have deployed the solution, the following user guide will help you navigate the functions available.

| Index | Description |
| ----- | ----------- |
| [Getting Started](#getting-started) | Sign in and open the app |
| [User View](#user-view) | Chat with the Knowledge Base Assistant using your SharePoint content |
| [Administrator View](#administrator-view) | Manage ingestion, system settings, analytics, and chat history |

---

## Getting Started

Open the hosted Amplify URL provided during deployment. You will be taken to the login page. Click **Sign in with Microsoft** to authenticate via your organization's Microsoft Entra ID account.

![image](./media/login-page.png)

Once authenticated, you are redirected to the home page and can begin using the assistant.

---

## User View

### Home Page

After signing in, you are greeted with a welcome message and a **Start a new conversation** button. The left sidebar is visible immediately — it shows your accessible SharePoint Lists at the top and your previous chat sessions below.

![image](./media/home-page-sidebar.png)

### SharePoint Lists

The top section of the left sidebar lists the SharePoint sources you have access to. Each entry shows the source name with a folder icon. 

Use this panel to see which content the assistant can draw from when answering your questions.

### Chat Sessions

Below the SharePoint Lists, the sidebar lists all your previous chat sessions. You can:

- Start a new chat with the **+** button at the top.
- Click any session to switch to it and continue the conversation.
- Use the actions menu on a session item to **rename** or **delete** it.

### Chat Interface

Click **Start a new conversation** (or the **+** button) to open a new chat. The assistant greets you automatically and is ready for your questions.

Type your message in the input box at the bottom and press **Enter** to send (use **Shift + Enter** for a new line). The assistant streams its response token-by-token as it generates.

![image](./media/first-interaction.png)

### Sources and Citations

AI responses may include source references drawn from your SharePoint content. Click **Show sources (N)** below a message to expand the list of cited documents or pages.

![image](./media/expanded-resources.png)


### Message Rating

On the most recent assistant message, you can rate the response:

- **Thumbs up** — submits a positive rating immediately.
- **Thumbs down** — opens a reason selector. Choose one or more of: *Not helpful*, *Inaccurate*, *Off-topic*, or *Other*, and optionally add a comment before submitting.

![image](./media/message-rating.png)

---

## Administrator View

### Accessing the Admin Panel

Administrators are members of the `admin` Cognito group. Once signed in, admin users see a **Mode** dropdown in the top-right of the header. Switch between **User** and **Admin** mode at any time using this dropdown.

The admin dashboard has a left sidebar with six sections: **Dashboard & Management**, **Analytics**, **System Settings**, **Chat History**, **Export Jobs**, and **Feedback**.

Admins also see a **notification bell** icon in the header that surfaces alerts for completed export jobs.

### Dashboard & Management

The dashboard shows three platform-wide metric cards at the top: **Total Users**, **Total Chat Sessions**, and **Total Messages**.

Below the metrics is the **SharePoint Ingestion** panel.

![image](./media/admin-dashboard.png)

#### Running an Ingestion Job

- Click **Run Ingestion** to start a new ingestion job. The job pulls content from SharePoint, chunks and embeds it, and upserts it into the vector store.
- Check **Force full re-ingest** to delete all existing vectors and rebuild from scratch. A confirmation dialog appears before the job starts.
- While a job is `running`, a **Stop** button is available to cancel it.

![image](./media/ingestion-panel.png)

#### Automated Schedule

Expand the **Automated Schedule** sub-panel to configure recurring ingestion runs without manual triggering.

- Choose a preset frequency: **Daily**, **Weekly**, **Monthly**, or **Custom** (cron expression).
- Set the time (hour and minute) and, for Weekly/Monthly, the day of week or day of month.
- Select a timezone from the searchable dropdown.
- Toggle the schedule **Enabled** or **Disabled**.
- Optionally enable **Force full re-ingest** for scheduled runs (confirmation required).
- Click **Save** to activate, or **Remove schedule** to delete the recurring rule.
- The panel header shows the current schedule status, next run time, and who last updated it.

![image](./media/ingestion-schedule.png)

#### Run History and Logs

The **Run History** table below the ingestion panel lists all past and current ingestion jobs.

| Column | Description |
| ------ | ----------- |
| # | Sequential run number |
| Status | Color-coded badge: Pending, Running, Stopping, Completed, Failed |
| Started | Timestamp; tagged with "full re-ingest" if applicable |
| Duration | Elapsed time |
| Items Ingested | Counts of ingested / skipped / failed documents |
| Logs | Expand button to view log output |

The table auto-refreshes every 10 seconds while a job is in progress. Click the **Logs** button on any row to open an inline log viewer that streams CloudWatch output. The viewer has **Output** and **Error** tabs and color-codes `ERROR` and `WARNING` lines.

![image](./media/run-history-logs.png)

---

### Analytics

The Analytics page shows three time-series line charts: **Total Users**, **Total Chat Sessions**, and **Total Questions Asked**.

#### Default View

By default, the charts show activity across all users for the last 90 days. Use the **Last N days** input (1–365) or toggle **All time** to change the date range.

![image](./media/admin-analytics.png)

#### Filtering by a Single Group

Use the **Group** dropdown to filter all three charts to a specific Entra group. Only activity from users in that group is shown. This is useful for seeing how a particular team or department is using the assistant.

#### Comparing Groups

Enable **Compare groups** mode to select multiple groups and overlay them on each chart at once. Each group gets its own colour (up to 8 groups, colorblind-safe palette), so you can directly compare usage patterns side by side.

![image](./media/analytics-group-compare.png)

#### Exporting Data

Click **Export CSV** to trigger an async export of the currently filtered analytics data. A notification appears in the header bell when the file is ready — download it from the **Export Jobs** page.

---

### System Settings

The System Settings page controls global platform behaviour and AI prompt configuration.

![image](./media/admin-system-settings.png)

| Setting | Description |
| ------- | ----------- |
| Max messages per day | Daily cap on messages a user can send before being rate-limited |
| Max context chunks | Maximum number of retrieved document chunks passed to the AI |
| Max history messages | Maximum number of prior conversation turns included in each prompt |
| Max characters per user message | Character limit on user input |
| Max characters per AI message | Character limit on AI responses |
| Temperature | Controls response creativity (0.0–1.0). Lower = more consistent |

The panel shows the timestamp and email of the last admin who saved system settings.

#### System Messages — Affects Text Generation

These messages are injected into the AI prompt and directly shape how the assistant responds. This impacts how the assistant retrieves, delivers, and formats responses. Each message type has full version history — admins can save new versions, activate a previous version, or delete inactive versions. The panel also shoes the timestamp and eamil of the last admin who updated the system prompt.

![image](./media/admin-system-instructions.png)
![image](./media/admin-output-format.png)

Message types injected into the prompt:

- **System Role** — defines who the assistant is and what it specializes in.
- **Guardrails** — hard boundaries that keep the AI on-topic and block harmful content.
- **System Instructions** — formatting and behavioural rules for how the AI structures responses.
- **Output Format** — specifies the structure and style of the AI's output.
- **Initial Prompt** — the opening message sent to start each new conversation from the AI Assistant.

#### System Messages — UI Only

These messages appear in the user interface but are not sent to the AI model.

![image](./media/admin-welcome-message.png)
![image](./media/admin-disclaimer.png)

- **Welcome Message** — shown to users on the home page before they start a chat.
- **Disclaimer** — displayed below the welcome message as a caveat or usage note.

#### Message Versioning

Each system message maintains a full version history. Navigate between versions using **Prev/Next** or the version chips, activate an older version to make it live, or delete unused versions.

![image](./media/admin-message-versioning.png)

#### Prompt Stack Viewer

The **How the Prompt Is Built** card, located in System Settings, shows a visual breakdown of how the active message blocks are assembled into the final AI prompt at runtime: System Role → Guardrails → System Instructions → Output Format → Retrieved Context.

![image](./media/admin-system-settings-stack.png)

---

### Chat History

The Chat History page lets admins review all user conversations.

- The **left panel** shows a tree of Entra groups → users → sessions (all paginated). An **Unassigned** group collects users not in any group.
- Click a session to load the full transcript in the **right panel**.
- AI messages are rendered as Markdown; user messages as plain text.
- Each message shows any **source citations** (expandable inline) and any **rating** the user submitted (thumbs up/down, category, comment).
- Use the **Export** buttons at the group, user, or "Export All" level to trigger an async export job. Download the file from the **Export Jobs** page when it completes.

![image](./media/admin-chat-history.png)

---

### Export Jobs

The Export Jobs page tracks all asynchronous exports triggered from Chat History and Analytics.

| Column | Description |
| ------ | ----------- |
| Requested | When the export was triggered |
| Type | Chat or Analytics |
| Scope | What was exported (all, group name, or user) |
| Status | Pending / Processing / Completed / Failed |
| Completed | Timestamp when finished |
| Download | Presigned S3 link (valid 7 days); shows "Link expired" after expiry |

Use the **Type** filter to narrow the list, and the **Refresh** button to check for updates. The table is paginated at 10 entries per page.

![image](./media/admin-export-jobs.png)

---

### Feedback

The Feedback dashboard surfaces user ratings on AI responses.

**Summary section:**

- **Total Likes** and **Total Dislikes** count cards.
- A **Dislike Reasons** pie chart breaking down categories: Not helpful, Inaccurate, Off-topic, Other.
- A **line chart** showing likes and dislikes over time.

**Date range filter:** Last 7 days / Last 30 days / All time / Custom range (calendar date picker).

![image](./media/admin-feedback-dashboard.png)

**Feedback list:** Paginated (5 per page) with category chip filters. Each item shows:

- The user's question and the AI's response (truncated, rendered as Markdown).
- An optional comment left by the user.
- The user's identity, category badge, and timestamp.

Click any feedback item to navigate directly to that message in **Chat History**, with the conversation auto-scrolled and highlighted.

![image](./media/admin-feedback-category.png)


---

## Additional Resources

- [Deployment Guide](./DEPLOYMENT_GUIDE.md)
- [Architecture Documentation](./ARCHITECTURE_DEEP_DIVE.md)
- [API Documentation](./API_DOCUMENTATION.md)
