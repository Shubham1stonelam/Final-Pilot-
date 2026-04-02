require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || 'sankalp26';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:shubham.forstonelam@gmail.com',
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// ─── DATA ───
const dataPath = p => path.join(__dirname, 'data', p);
const readJSON = f => { try { return JSON.parse(fs.readFileSync(dataPath(f))); } catch { return null; } };
const writeJSON = (f, d) => fs.writeFileSync(dataPath(f), JSON.stringify(d, null, 2));

// ─── SSE CLIENTS (keyed by attendeeId) ───
const sseClients = new Map(); // attendeeId -> res
let announcementLog = []; // in-memory delivery tracking

const adminAuth = (req, res, next) => {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const broadcast = (data) => {
  // Named SSE events — required for addEventListener('type', ...) to fire on clients
  const eventType = data.type || 'message';
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch {} });
};

const broadcastWithTracking = (data) => {
  const connectedIds = [...sseClients.keys()];
  const attendees = readJSON('attendees.json') || [];
  const allIds = attendees.map(a => a.id);
  const seenIds = connectedIds;
  const pendingIds = allIds.filter(id => !connectedIds.includes(id));
  const entry = {
    id: Date.now().toString(),
    message: data.message,
    tone: data.tone || 'normal',
    time: data.time,
    sent: allIds.length,
    seen: seenIds,
    pending: pendingIds,
    acked: []
  };
  announcementLog.unshift(entry);
  if (announcementLog.length > 20) announcementLog = announcementLog.slice(0, 20);
  broadcast({ ...data, alertId: entry.id });
  return entry;
};

// ─── PAGE ROUTES ───
app.get('/', (req, res) => res.redirect('/admin.html'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/qr-print', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr-print.html')));
app.get('/a/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'attendee.html')));

// ─── SSE ───
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const attendeeId = req.query.id || 'unknown';
  sseClients.set(attendeeId, res);
  const status = readJSON('status.json');
  res.write(`event: status\ndata: ${JSON.stringify({ type: 'status', ...status })}\n\n`);
  req.on('close', () => sseClients.delete(attendeeId));
});

// ─── PUBLIC API ───
app.get('/api/attendee/:id', (req, res) => {
  const attendees = readJSON('attendees.json');
  const a = attendees.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json(a);
});

app.get('/api/attendees', (req, res) => res.json(readJSON('attendees.json') || []));
app.get('/api/event', (req, res) => res.json(readJSON('event.json')));
app.get('/api/status', (req, res) => res.json(readJSON('status.json')));
app.get('/api/vapid-key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));

app.post('/api/subscribe/:id', (req, res) => {
  const subs = readJSON('subscriptions.json') || [];
  const i = subs.findIndex(s => s.attendeeId === req.params.id);
  const entry = { attendeeId: req.params.id, subscription: req.body };
  if (i >= 0) subs[i] = entry; else subs.push(entry);
  writeJSON('subscriptions.json', subs);
  res.json({ ok: true });
});

app.post('/api/arrive/:id', (req, res) => {
  const attendees = readJSON('attendees.json');
  const i = attendees.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  attendees[i].arrived = true;
  attendees[i].arrivedAt = new Date().toISOString();
  writeJSON('attendees.json', attendees);
  broadcast({ type: 'arrival', attendeeId: req.params.id, name: attendees[i].name });
  res.json({ ok: true });
});

app.post('/api/feedback/:id', (req, res) => {
  let feedback = [];
  try { feedback = JSON.parse(fs.readFileSync(dataPath('feedback.json'))); } catch {}
  const attendees = readJSON('attendees.json');
  const a = attendees.find(x => x.id === req.params.id);
  const comment = req.body.comment || '';
  const rating = req.body.rating || 0;
  // Simple sentiment
  const positive = ['great', 'amazing', 'excellent', 'loved', 'fantastic', 'good', 'best'];
  const negative = ['bad', 'poor', 'boring', 'delay', 'waiting', 'slow', 'issue', 'problem'];
  const lc = comment.toLowerCase();
  let sentiment = 'neutral';
  if (rating >= 4 || positive.some(w => lc.includes(w))) sentiment = 'positive';
  if (rating <= 2 || negative.some(w => lc.includes(w))) sentiment = 'negative';
  // Keyword extraction
  const keywords = [...positive, ...negative, 'food', 'session', 'hotel', 'transport', 'speaker', 'content', 'venue']
    .filter(w => lc.includes(w));
  feedback.push({
    attendeeId: req.params.id,
    name: a ? a.name : 'Unknown',
    department: a ? a.department : '',
    city: a ? a.city : '',
    rating, comment, sentiment, keywords,
    timestamp: new Date().toISOString()
  });
  fs.writeFileSync(dataPath('feedback.json'), JSON.stringify(feedback, null, 2));
  res.json({ ok: true });
});

app.post('/api/sos/:id', (req, res) => {
  const attendees = readJSON('attendees.json');
  const a = attendees.find(x => x.id === req.params.id);
  broadcast({ type: 'sos', attendeeId: req.params.id, name: a ? a.name : req.params.id, time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) });
  res.json({ ok: true });
});

app.post('/api/ack/:id', (req, res) => {
  const { alertId } = req.body;
  const entry = announcementLog.find(a => a.id === alertId);
  if (entry && !entry.acked.includes(req.params.id)) entry.acked.push(req.params.id);
  broadcast({ type: 'ackUpdate', alertId, attendeeId: req.params.id, ackedCount: entry ? entry.acked.length : 0, ackedIds: entry ? entry.acked : [] });
  res.json({ ok: true });
});

// ─── ADMIN API ───
app.post('/api/admin/auth', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Wrong PIN' });
  res.json({ ok: true });
});

app.post('/api/admin/announce', adminAuth, (req, res) => {
  const { message, tone } = req.body;
  const urgent = tone === 'urgent' || tone === 'critical';
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const entry = broadcastWithTracking({ type: 'announcement', message, tone: tone || 'normal', urgent, time });
  // Push notifications
  const subs = readJSON('subscriptions.json') || [];
  let sent = 0;
  subs.forEach(s => {
    webpush.sendNotification(s.subscription, JSON.stringify({
      title: tone === 'critical' ? '🚨 CRITICAL' : tone === 'urgent' ? '⚠️ SANKALP Alert' : '📢 SANKALP',
      body: message, urgent, tone
    })).then(() => sent++).catch(() => {});
  });
  // Update status
  const status = readJSON('status.json');
  status.notificationsSent = (status.notificationsSent || 0) + 1;
  status.lastAction = `Announced: "${message.substring(0, 40)}..."`;
  writeJSON('status.json', status);
  res.json({ ok: true, entry });
});

app.post('/api/admin/session', adminAuth, (req, res) => {
  const status = readJSON('status.json');
  status.currentSession = req.body.session;
  status.lastAction = `Session updated: ${req.body.session}`;
  writeJSON('status.json', status);
  broadcast({ type: 'sessionUpdate', session: req.body.session });
  res.json({ ok: true });
});

app.post('/api/admin/tour', adminAuth, (req, res) => {
  const { group, state } = req.body;
  const status = readJSON('status.json');
  if (group === 1) status.group1Tour = state;
  if (group === 2) status.group2Tour = state;
  status.lastAction = `Group ${group} tour: ${state}`;
  writeJSON('status.json', status);
  broadcast({ type: 'tourUpdate', group, state });
  res.json({ ok: true });
});

app.post('/api/admin/state', adminAuth, (req, res) => {
  const { systemState } = req.body;
  const status = readJSON('status.json');
  status.systemState = systemState;
  status.lastAction = `State: ${systemState}`;
  writeJSON('status.json', status);
  broadcast({ type: 'stateUpdate', systemState });
  res.json({ ok: true });
});

app.post('/api/admin/feedback-open', adminAuth, (req, res) => {
  const status = readJSON('status.json');
  status.feedbackOpen = true;
  writeJSON('status.json', status);
  broadcast({ type: 'feedbackOpen' });
  res.json({ ok: true });
});

app.post('/api/admin/ping/:id', adminAuth, (req, res) => {
  const attendees = readJSON('attendees.json');
  const a = attendees.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const client = sseClients.get(req.params.id);
  if (client) {
    try { client.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping', message: req.body.message || 'The event team is looking for you. Please check in.' })}\n\n`); }
    catch {}
  }
  // Also push notification
  const subs = readJSON('subscriptions.json') || [];
  const sub = subs.find(s => s.attendeeId === req.params.id);
  if (sub) webpush.sendNotification(sub.subscription, JSON.stringify({ title: `Hey ${a.name}!`, body: req.body.message || 'The event team is looking for you.' })).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/admin/direction/:id', adminAuth, (req, res) => {
  const attendees = readJSON('attendees.json');
  const a = attendees.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const msg = req.body.message || 'Please head to the main hall immediately.';
  const client = sseClients.get(req.params.id);
  if (client) {
    try { client.write(`event: announcement\ndata: ${JSON.stringify({ type: 'announcement', message: msg, tone: 'normal', urgent: false, time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), alertId: Date.now().toString() })}\n\n`); }
    catch {}
  }
  res.json({ ok: true });
});

app.get('/api/admin/feedback', adminAuth, (req, res) => {
  let feedback = [];
  try { feedback = JSON.parse(fs.readFileSync(dataPath('feedback.json'))); } catch {}
  const avg = feedback.length ? (feedback.reduce((s, f) => s + (f.rating || 0), 0) / feedback.length).toFixed(1) : '0.0';
  const sentimentSummary = { positive: 0, neutral: 0, negative: 0 };
  const keywordCount = {};
  feedback.forEach(f => {
    if (f.sentiment) sentimentSummary[f.sentiment]++;
    (f.keywords || []).forEach(k => { keywordCount[k] = (keywordCount[k] || 0) + 1; });
  });
  const topKeywords = Object.entries(keywordCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  res.json({ feedback, count: feedback.length, avgRating: parseFloat(avg), sentimentSummary, topKeywords });
});

app.get('/api/admin/attendees', adminAuth, (req, res) => res.json(readJSON('attendees.json') || []));
app.get('/api/admin/announcements', adminAuth, (req, res) => res.json(announcementLog));
app.get('/api/admin/online', adminAuth, (req, res) => res.json({ online: [...sseClients.keys()] }));

// ─── AI AGENT ───
app.post('/api/agent', adminAuth, async (req, res) => {
  const { message, history = [], mode } = req.body;
  const status = readJSON('status.json');
  const attendees = readJSON('attendees.json') || [];
  const arrived = attendees.filter(a => a.arrived).length;
  let feedback = [];
  try { feedback = JSON.parse(fs.readFileSync(dataPath('feedback.json'))); } catch {}
  const avgRating = feedback.length ? (feedback.reduce((s, f) => s + (f.rating || 0), 0) / feedback.length).toFixed(1) : 'N/A';
  const online = [...sseClients.keys()].length;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Rewrite mode — just improve the announcement text
    if (mode === 'rewrite') {
      const r = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 256,
        system: 'You are a professional event communications assistant. Rewrite the given announcement to be clear, concise, and professional. Keep it under 2 sentences. Return ONLY the rewritten message, nothing else.',
        messages: [{ role: 'user', content: message }]
      });
      return res.json({ reply: r.content[0].text });
    }

    const systemPrompt = `You are NAV, the AI command assistant for SANKALP 2026 — Stonelam's annual townhall event. You are a real-time event control system.

Live status:
- System state: ${status.systemState}
- Current session: ${status.currentSession}
- Arrivals: ${arrived}/${attendees.length} | Online now: ${online}
- Group 1 Tour: ${status.group1Tour} | Group 2 Tour: ${status.group2Tour}
- Feedback: ${feedback.length} submissions, avg: ${avgRating}★
- Last action: ${status.lastAction || 'none'}

Be decisive, concise, and action-oriented. When given a command, execute it.`;

    const tools = [
      { name: 'send_announcement', description: 'Send announcement to all attendees', input_schema: { type: 'object', properties: { message: { type: 'string' }, tone: { type: 'string', enum: ['normal', 'urgent', 'critical'] } }, required: ['message'] } },
      { name: 'update_session', description: 'Update current session name', input_schema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] } },
      { name: 'set_tour_status', description: 'Update tour status for a group', input_schema: { type: 'object', properties: { group: { type: 'number' }, state: { type: 'string', enum: ['pending', 'live', 'done'] } }, required: ['group', 'state'] } },
      { name: 'set_system_state', description: 'Change the event system state', input_schema: { type: 'object', properties: { state: { type: 'string', enum: ['arrival', 'registration', 'session_live', 'transit', 'feedback'] } }, required: ['state'] } },
      { name: 'open_feedback', description: 'Open feedback for all attendees', input_schema: { type: 'object', properties: {} } },
      { name: 'ping_attendee', description: 'Send a direct ping to a specific attendee', input_schema: { type: 'object', properties: { attendeeId: { type: 'string' }, message: { type: 'string' } }, required: ['attendeeId'] } }
    ];

    const msgs = [...history.slice(-6).map(h => ({ role: h.role, content: h.content })), { role: 'user', content: message }];
    const response = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, tools, messages: msgs });

    let replyText = '';
    const actions = [];
    for (const block of response.content) {
      if (block.type === 'text') replyText += block.text;
      if (block.type === 'tool_use') {
        const { name, input } = block;
        actions.push(name);
        if (name === 'send_announcement') {
          const tone = input.tone || 'normal';
          const urgent = tone !== 'normal';
          const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          broadcastWithTracking({ type: 'announcement', message: input.message, tone, urgent, time });
          const subs = readJSON('subscriptions.json') || [];
          subs.forEach(s => webpush.sendNotification(s.subscription, JSON.stringify({ title: urgent ? '🚨 SANKALP' : '📢 SANKALP', body: input.message, urgent })).catch(() => {}));
          const st = readJSON('status.json'); st.notificationsSent = (st.notificationsSent || 0) + 1; writeJSON('status.json', st);
        }
        if (name === 'update_session') { const st = readJSON('status.json'); st.currentSession = input.session; writeJSON('status.json', st); broadcast({ type: 'sessionUpdate', session: input.session }); }
        if (name === 'set_tour_status') { const st = readJSON('status.json'); if (input.group === 1) st.group1Tour = input.state; if (input.group === 2) st.group2Tour = input.state; writeJSON('status.json', st); broadcast({ type: 'tourUpdate', group: input.group, state: input.state }); }
        if (name === 'set_system_state') { const st = readJSON('status.json'); st.systemState = input.state; writeJSON('status.json', st); broadcast({ type: 'stateUpdate', systemState: input.state }); }
        if (name === 'open_feedback') { const st = readJSON('status.json'); st.feedbackOpen = true; writeJSON('status.json', st); broadcast({ type: 'feedbackOpen' }); }
        if (name === 'ping_attendee') {
          const client2 = sseClients.get(input.attendeeId);
          if (client2) try { client2.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping', message: input.message || 'The team needs you. Please check in.' })}\n\n`); } catch {}
        }
      }
    }
    if (!replyText && actions.length) replyText = `✅ Done — ${actions.join(', ').replace(/_/g, ' ')}.`;
    return res.json({ reply: replyText, actions });

  } catch {
    // Rule-based fallback
    const m = message.toLowerCase();
    let reply = '';
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (m.includes('call all') || m.includes('lobby')) { broadcastWithTracking({ type: 'announcement', message: 'All attendees — please gather at the main lobby immediately.', tone: 'urgent', urgent: true, time }); reply = 'All-call sent to lobby.'; }
    else if (m.includes('bus') || m.includes('depart')) { broadcastWithTracking({ type: 'announcement', message: 'Bus departs in 15 minutes. Please make your way to the pickup point now.', tone: 'urgent', urgent: true, time }); reply = 'Bus alert sent.'; }
    else if (m.includes('lunch')) { broadcastWithTracking({ type: 'announcement', message: 'Lunch is served! Please head to the dining area.', tone: 'normal', urgent: false, time }); reply = 'Lunch announcement sent.'; }
    else if (m.includes('hall') || m.includes('session')) { broadcastWithTracking({ type: 'announcement', message: 'Next session is starting. Please make your way to the main hall.', tone: 'normal', urgent: false, time }); reply = 'Hall announcement sent.'; }
    else if (m.includes('feedback')) { const st = readJSON('status.json'); st.feedbackOpen = true; writeJSON('status.json', st); broadcast({ type: 'feedbackOpen' }); reply = 'Feedback opened for all attendees.'; }
    else if (m.includes('g1') && m.includes('live')) { const st = readJSON('status.json'); st.group1Tour = 'live'; writeJSON('status.json', st); broadcast({ type: 'tourUpdate', group: 1, state: 'live' }); reply = 'Group 1 tour: LIVE.'; }
    else if (m.includes('g1') && m.includes('done')) { const st = readJSON('status.json'); st.group1Tour = 'done'; writeJSON('status.json', st); broadcast({ type: 'tourUpdate', group: 1, state: 'done' }); reply = 'Group 1 tour: DONE.'; }
    else if (m.includes('g2') && m.includes('live')) { const st = readJSON('status.json'); st.group2Tour = 'live'; writeJSON('status.json', st); broadcast({ type: 'tourUpdate', group: 2, state: 'live' }); reply = 'Group 2 tour: LIVE.'; }
    else if (m.includes('g2') && m.includes('done')) { const st = readJSON('status.json'); st.group2Tour = 'done'; writeJSON('status.json', st); broadcast({ type: 'tourUpdate', group: 2, state: 'done' }); reply = 'Group 2 tour: DONE.'; }
    else if (m.includes('status')) { reply = `State: ${status.systemState} | Session: ${status.currentSession} | ${arrived}/${attendees.length} arrived | Online: ${online} | Feedback: ${feedback.length} (${avgRating}★)`; }
    else if (m.includes('emergency')) { broadcastWithTracking({ type: 'announcement', message: '🚨 EMERGENCY ALERT — All attendees stop what you are doing and await further instructions from the event team.', tone: 'critical', urgent: true, time }); reply = 'Emergency alert broadcast.'; }
    else { reply = 'Rule-based mode active. Add ANTHROPIC_API_KEY in Render environment for full AI. Try: "bus alert", "call all lobby", "lunch", "g1 live", "g2 done", "feedback", "emergency", "status".'; }
    return res.json({ reply });
  }
});

// ─── SCHEDULED NOTIFICATIONS ───
const checkScheduled = () => {
  try {
    const event = readJSON('event.json');
    const status = readJSON('status.json');
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    (event.notifications || []).forEach(n => {
      if (n.day === status.day && n.time === timeStr && !n.sent) {
        n.sent = true;
        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        broadcastWithTracking({ type: 'announcement', message: n.body, tone: n.type === 'urgent' ? 'urgent' : 'normal', urgent: n.type === 'urgent', time });
        if (n.triggerFeedback) { status.feedbackOpen = true; writeJSON('status.json', status); broadcast({ type: 'feedbackOpen' }); }
        const subs = readJSON('subscriptions.json') || [];
        subs.forEach(s => webpush.sendNotification(s.subscription, JSON.stringify({ title: n.title, body: n.body, urgent: n.type === 'urgent' })).catch(() => {}));
        writeJSON('event.json', event);
      }
    });
  } catch {}
};
setInterval(checkScheduled, 30000);

app.listen(PORT, () => {
  console.log(`\n🌿 SANKALP 2026 — Command System`);
  console.log(`   http://localhost:${PORT}/admin  (PIN: ${ADMIN_PIN})`);
  console.log(`   Attendee: http://localhost:${PORT}/a/nav-001\n`);
});
