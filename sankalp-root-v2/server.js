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
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// VAPID
// ─────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:shubham.forstonelam@gmail.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// ─────────────────────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────────────────────
const dataPath = (p) => path.join(__dirname, 'data', p);

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(dataPath(file), JSON.stringify(data, null, 2));
}

function ensureStatusShape(status) {
  const safe = status || {};
  if (!safe.arrivals) safe.arrivals = {};
  if (!safe.announcements) safe.announcements = [];
  if (!safe.tourGroups) safe.tourGroups = { '1': 'waiting', '2': 'waiting' };
  if (!safe.currentSession) safe.currentSession = 'Waiting...';
  if (typeof safe.feedbackOpen !== 'boolean') safe.feedbackOpen = false;
  if (typeof safe.notificationsSent !== 'number') safe.notificationsSent = 0;
  if (!safe.systemState) safe.systemState = 'Registration';
  if (!safe.group1Tour) safe.group1Tour = safe.tourGroups['1'] || 'waiting';
  if (!safe.group2Tour) safe.group2Tour = safe.tourGroups['2'] || 'waiting';
  if (!safe.lastAction) safe.lastAction = '';
  if (!safe.day) safe.day = 1;
  return safe;
}

function loadStatus() {
  return ensureStatusShape(readJSON('status.json', {}));
}

function saveStatus(status) {
  const normalized = ensureStatusShape(status);
  normalized.group1Tour = normalized.tourGroups['1'];
  normalized.group2Tour = normalized.tourGroups['2'];
  writeJSON('status.json', normalized);
}

function loadAttendees() {
  return readJSON('attendees.json', []);
}

function saveAttendees(attendees) {
  writeJSON('attendees.json', attendees);
}

function loadEvent() {
  return readJSON('event.json', {});
}

function saveEvent(event) {
  writeJSON('event.json', event);
}

function loadFeedback() {
  return readJSON('feedback.json', []);
}

function saveFeedback(feedback) {
  writeJSON('feedback.json', feedback);
}

function loadSubscriptions() {
  const raw = readJSON('subscriptions.json', []);
  if (Array.isArray(raw)) return raw;
  // Support old object-shaped subscription stores
  return Object.entries(raw).map(([attendeeId, subscription]) => ({
    attendeeId,
    subscription,
  }));
}

function saveSubscriptions(subs) {
  writeJSON('subscriptions.json', subs);
}

function upsertSubscription(attendeeId, subscription) {
  const subs = loadSubscriptions();
  const idx = subs.findIndex((s) => s.attendeeId === attendeeId);
  const entry = { attendeeId, subscription };
  if (idx >= 0) subs[idx] = entry;
  else subs.push(entry);
  saveSubscriptions(subs);
}

function findSubscription(attendeeId) {
  return loadSubscriptions().find((s) => s.attendeeId === attendeeId) || null;
}

// ─────────────────────────────────────────────────────────────
// SSE CLIENTS
// ─────────────────────────────────────────────────────────────
const sseClients = new Map(); // attendeeId -> res
let announcementLog = [];

function attachSSE(res, attendeeId) {
  sseClients.set(attendeeId, res);
}

function detachSSE(attendeeId) {
  sseClients.delete(attendeeId);
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  const eventType = data.type || 'message';
  const named = `event: ${eventType}\ndata: ${payload}\n\n`;
  const plain = `data: ${payload}\n\n`;

  sseClients.forEach((client) => {
    try {
      client.write(named);
      client.write(plain);
    } catch {}
  });
}

function sendToOne(attendeeId, data) {
  const client = sseClients.get(attendeeId);
  if (!client) return;
  const payload = JSON.stringify(data);
  const eventType = data.type || 'message';
  try {
    client.write(`event: ${eventType}\ndata: ${payload}\n\n`);
    client.write(`data: ${payload}\n\n`);
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin || req.body.pin;
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// PUSH HELPERS
// ─────────────────────────────────────────────────────────────
function cleanupDeadSubscriptions(deadIds = []) {
  if (!deadIds.length) return;
  const subs = loadSubscriptions().filter((s) => !deadIds.includes(s.attendeeId));
  saveSubscriptions(subs);
}

async function sendPushToTargets(targetIds, title, body, extra = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { sent: 0, failed: 0, note: 'VAPID not configured' };
  }

  const subs = loadSubscriptions();
  let sent = 0;
  let failed = 0;
  const deadIds = [];

  for (const id of targetIds) {
    const sub = subs.find((s) => s.attendeeId === id);
    if (!sub || !sub.subscription) continue;

    try {
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title,
          body,
          ...extra,
        })
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        deadIds.push(id);
      }
    }
  }

  cleanupDeadSubscriptions(deadIds);
  return { sent, failed };
}

function resolveTargetIds(target) {
  const attendees = loadAttendees();
  if (target === 'all') return attendees.map((a) => a.id);
  if (target === 'group1') return attendees.filter((a) => String(a.group) === '1').map((a) => a.id);
  if (target === 'group2') return attendees.filter((a) => String(a.group) === '2').map((a) => a.id);
  return [target];
}

function createAnnouncementEntry({ message, tone = 'normal', urgent = false, type }) {
  return {
    id: Date.now().toString(),
    message,
    tone,
    urgent,
    type: type || (tone === 'critical' || tone === 'urgent' ? 'urgent' : 'info'),
    time: new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

function logAnnouncement(entry) {
  const attendees = loadAttendees();
  const connectedIds = [...sseClients.keys()];
  const allIds = attendees.map((a) => a.id);
  const pendingIds = allIds.filter((id) => !connectedIds.includes(id));

  const item = {
    id: entry.id,
    message: entry.message,
    tone: entry.tone || 'normal',
    time: entry.time,
    sent: allIds.length,
    seen: connectedIds,
    pending: pendingIds,
    acked: [],
  };

  announcementLog.unshift(item);
  if (announcementLog.length > 30) {
    announcementLog = announcementLog.slice(0, 30);
  }

  return item;
}

// ─────────────────────────────────────────────────────────────
// PAGE ROUTES
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/qr-print', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr-print.html')));
app.get('/a/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'attendee.html')));

// ─────────────────────────────────────────────────────────────
// SSE ROUTES
// ─────────────────────────────────────────────────────────────
function initSSE(req, res, attendeeId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  attachSSE(res, attendeeId);

  const status = loadStatus();
  const initial = { type: 'status', status, ...status };

  try {
    res.write(`event: status\ndata: ${JSON.stringify(initial)}\n\n`);
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
  } catch {}

  req.on('close', () => detachSSE(attendeeId));
}

app.get('/api/events', (req, res) => {
  const attendeeId = req.query.id || 'unknown';
  initSSE(req, res, attendeeId);
});

app.get('/api/stream/:id', (req, res) => {
  initSSE(req, res, req.params.id);
});

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
app.get('/api/attendee/:id', (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  if (!attendee) {
    return res.status(404).json({ error: 'Not found' });
  }

  const event = loadEvent();
  const status = loadStatus();

  // Mark arrival on first fetch/scan if not already marked
  if (!attendee.arrived) {
    attendee.arrived = true;
    attendee.arrivedAt = new Date().toISOString();
    attendee.arrivalTime = attendee.arrivedAt;

    attendees[attendees.findIndex((a) => a.id === attendee.id)] = attendee;
    saveAttendees(attendees);

    status.arrivals[attendee.id] = {
      attendeeId: attendee.id,
      name: attendee.name,
      group: attendee.group || attendee.groupLabel || '',
      department: attendee.department || '',
      city: attendee.city || attendee.location || '',
      time: attendee.arrivedAt,
    };
    saveStatus(status);

    broadcast({
      type: 'arrival',
      attendeeId: attendee.id,
      name: attendee.name,
      department: attendee.department || '',
      city: attendee.city || '',
      group: attendee.group || attendee.groupLabel || '',
      time: attendee.arrivedAt,
    });
  }

  // Backward + forward compatible shape
  return res.json({
    ...attendee,
    attendee,
    event,
    status: loadStatus(),
  });
});

app.get('/api/attendees', (req, res) => {
  res.json(loadAttendees());
});

app.get('/api/event', (req, res) => {
  res.json(loadEvent());
});

app.get('/api/status', (req, res) => {
  res.json(loadStatus());
});

app.get('/api/vapid-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

app.post('/api/subscribe/:id', (req, res) => {
  upsertSubscription(req.params.id, req.body);
  res.json({ ok: true });
});

app.post('/api/arrive/:id', (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  if (!attendee) {
    return res.status(404).json({ error: 'Not found' });
  }

  attendee.arrived = true;
  attendee.arrivedAt = new Date().toISOString();
  attendee.arrivalTime = attendee.arrivedAt;
  saveAttendees(attendees);

  const status = loadStatus();
  status.arrivals[attendee.id] = {
    attendeeId: attendee.id,
    name: attendee.name,
    group: attendee.group || attendee.groupLabel || '',
    department: attendee.department || '',
    city: attendee.city || attendee.location || '',
    time: attendee.arrivedAt,
  };
  saveStatus(status);

  broadcast({
    type: 'arrival',
    attendeeId: attendee.id,
    name: attendee.name,
    department: attendee.department || '',
    city: attendee.city || '',
    group: attendee.group || attendee.groupLabel || '',
    time: attendee.arrivedAt,
  });

  res.json({ ok: true });
});

app.post('/api/feedback/:id', (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  const comment = req.body.comment || '';
  const rating = Number(req.body.rating || 0);
  const lc = comment.toLowerCase();

  const positive = ['great', 'amazing', 'excellent', 'loved', 'fantastic', 'good', 'best'];
  const negative = ['bad', 'poor', 'boring', 'delay', 'waiting', 'slow', 'issue', 'problem'];
  const keywordPool = [...positive, ...negative, 'food', 'session', 'hotel', 'transport', 'speaker', 'content', 'venue'];

  let sentiment = 'neutral';
  if (rating >= 4 || positive.some((w) => lc.includes(w))) sentiment = 'positive';
  if (rating <= 2 || negative.some((w) => lc.includes(w))) sentiment = 'negative';

  const keywords = keywordPool.filter((w) => lc.includes(w));

  const feedback = loadFeedback();
  feedback.push({
    attendeeId: req.params.id,
    name: attendee ? attendee.name : 'Unknown',
    department: attendee ? attendee.department || '' : '',
    city: attendee ? attendee.city || '' : '',
    rating,
    comment,
    sentiment,
    keywords,
    timestamp: new Date().toISOString(),
  });

  saveFeedback(feedback);
  res.json({ ok: true });
});

app.post('/api/sos/:id', (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  broadcast({
    type: 'sos',
    attendeeId: req.params.id,
    name: attendee ? attendee.name : req.params.id,
    time: new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    }),
  });

  res.json({ ok: true });
});

app.post('/api/ack/:id', (req, res) => {
  const { alertId } = req.body;
  const entry = announcementLog.find((a) => a.id === alertId);

  if (entry && !entry.acked.includes(req.params.id)) {
    entry.acked.push(req.params.id);
  }

  broadcast({
    type: 'ackUpdate',
    alertId,
    attendeeId: req.params.id,
    ackedCount: entry ? entry.acked.length : 0,
    ackedIds: entry ? entry.acked : [],
  });

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────────────────────────
app.post('/api/admin/auth', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  res.json({ ok: true });
});

app.get('/api/admin/status', adminAuth, (req, res) => {
  res.json({
    attendees: loadAttendees(),
    status: loadStatus(),
    event: loadEvent(),
  });
});

app.get('/api/admin/attendees', adminAuth, (req, res) => {
  res.json(loadAttendees());
});

app.get('/api/admin/announcements', adminAuth, (req, res) => {
  res.json(announcementLog);
});

app.get('/api/admin/online', adminAuth, (req, res) => {
  res.json({ online: [...sseClients.keys()] });
});

app.get('/api/admin/feedback', adminAuth, (req, res) => {
  const feedback = loadFeedback();
  const avg =
    feedback.length > 0
      ? Number((feedback.reduce((sum, f) => sum + (Number(f.rating) || 0), 0) / feedback.length).toFixed(1))
      : 0;

  const sentimentSummary = { positive: 0, neutral: 0, negative: 0 };
  const keywordCount = {};

  feedback.forEach((f) => {
    if (f.sentiment && sentimentSummary[f.sentiment] !== undefined) {
      sentimentSummary[f.sentiment] += 1;
    }
    (f.keywords || []).forEach((k) => {
      keywordCount[k] = (keywordCount[k] || 0) + 1;
    });
  });

  const topKeywords = Object.entries(keywordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);

  res.json({
    feedback,
    count: feedback.length,
    avgRating: avg,
    sentimentSummary,
    topKeywords,
  });
});

app.post('/api/admin/announce', adminAuth, async (req, res) => {
  const message = req.body.message || '';
  const toneInput = req.body.tone || req.body.type || (req.body.urgent ? 'urgent' : 'normal');
  const tone = toneInput === 'critical' ? 'critical' : toneInput === 'urgent' ? 'urgent' : 'normal';
  const urgent = tone === 'critical' || tone === 'urgent';

  if (!message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  const announcement = createAnnouncementEntry({ message, tone, urgent });
  const status = loadStatus();
  status.announcements.unshift(announcement);
  if (status.announcements.length > 30) status.announcements = status.announcements.slice(0, 30);
  status.notificationsSent = (status.notificationsSent || 0) + 1;
  status.lastAction = `Announced: "${message.substring(0, 40)}${message.length > 40 ? '...' : ''}"`;
  saveStatus(status);

  const logEntry = logAnnouncement(announcement);

  broadcast({
    type: 'announcement',
    announcement,
    alertId: announcement.id,
    message: announcement.message,
    tone: announcement.tone,
    urgent: announcement.urgent,
    time: announcement.time,
  });

  const targetIds = resolveTargetIds('all');
  const pushTitle =
    tone === 'critical'
      ? '🚨 CRITICAL'
      : tone === 'urgent'
      ? '⚠️ SANKALP Alert'
      : '📢 SANKALP';

  const pushResult = await sendPushToTargets(targetIds, pushTitle, announcement.message, {
    tone: announcement.tone,
    urgent: announcement.urgent,
    id: announcement.id,
  });

  res.json({ ok: true, entry: logEntry, push: pushResult });
});

app.post('/api/admin/notify', adminAuth, async (req, res) => {
  const target = req.body.target || 'all';
  const title = req.body.title || '📢 SANKALP';
  const body = req.body.body || '';
  const urgent = !!req.body.urgent;

  const targetIds = resolveTargetIds(target);
  const result = await sendPushToTargets(targetIds, title, body, {
    urgent,
    tone: urgent ? 'urgent' : 'normal',
  });

  res.json({ ok: true, ...result, total: targetIds.length });
});

app.post('/api/admin/session', adminAuth, (req, res) => {
  const session = req.body.session || 'Waiting...';
  const status = loadStatus();
  status.currentSession = session;
  status.lastAction = `Session updated: ${session}`;
  saveStatus(status);

  broadcast({ type: 'sessionUpdate', session });
  res.json({ ok: true });
});

app.post('/api/admin/tour', adminAuth, (req, res) => {
  const group = Number(req.body.group);
  const incoming = req.body.tourStatus || req.body.state || 'waiting';
  const normalized =
    incoming === 'completed' ? 'completed' :
    incoming === 'done' ? 'done' :
    incoming === 'live' ? 'live' :
    'waiting';

  const status = loadStatus();
  status.tourGroups[String(group)] = normalized;
  status.group1Tour = status.tourGroups['1'];
  status.group2Tour = status.tourGroups['2'];
  status.lastAction = `Group ${group} tour: ${normalized}`;
  saveStatus(status);

  broadcast({ type: 'tourUpdate', group, tourStatus: normalized, state: normalized });
  res.json({ ok: true, group, tourStatus: normalized });
});

app.post('/api/admin/state', adminAuth, (req, res) => {
  const systemState = req.body.systemState || 'Registration';
  const status = loadStatus();
  status.systemState = systemState;
  status.lastAction = `State: ${systemState}`;
  saveStatus(status);

  broadcast({ type: 'stateUpdate', systemState });
  res.json({ ok: true });
});

app.post('/api/admin/feedback-open', adminAuth, (req, res) => {
  const status = loadStatus();
  status.feedbackOpen = true;
  status.lastAction = 'Feedback opened';
  saveStatus(status);

  broadcast({ type: 'feedbackOpen' });
  res.json({ ok: true });
});

app.post('/api/admin/transport', adminAuth, (req, res) => {
  const { attendeeId, driverName, driverMobile, vehicleNumber } = req.body;
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === attendeeId);

  if (!attendee) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!attendee.transport) attendee.transport = {};
  if (!attendee.transport.day1) attendee.transport.day1 = {};

  if (driverName) attendee.transport.day1.driverName = driverName;
  if (driverMobile) attendee.transport.day1.driverMobile = driverMobile;
  if (vehicleNumber) attendee.transport.day1.vehicleNumber = vehicleNumber;

  saveAttendees(attendees);

  broadcast({
    type: 'transportUpdate',
    attendeeId,
    transport: attendee.transport,
  });

  res.json({ ok: true });
});

app.post('/api/admin/ping/:id', adminAuth, async (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  if (!attendee) {
    return res.status(404).json({ error: 'Not found' });
  }

  const message = req.body.message || 'The event team is looking for you. Please check your device.';
  sendToOne(req.params.id, { type: 'ping', message });

  const push = await sendPushToTargets(
    [req.params.id],
    `Hey ${attendee.name}!`,
    message,
    { urgent: false, tone: 'normal' }
  );

  res.json({ ok: true, push });
});

app.post('/api/admin/direction/:id', adminAuth, async (req, res) => {
  const attendees = loadAttendees();
  const attendee = attendees.find((a) => a.id === req.params.id);

  if (!attendee) {
    return res.status(404).json({ error: 'Not found' });
  }

  const message = req.body.message || 'Please head to the main hall immediately.';
  const announcement = createAnnouncementEntry({
    message,
    tone: 'normal',
    urgent: false,
    type: 'info',
  });

  sendToOne(req.params.id, {
    type: 'announcement',
    announcement,
    alertId: announcement.id,
    message: announcement.message,
    tone: announcement.tone,
    urgent: false,
    time: announcement.time,
  });

  const push = await sendPushToTargets(
    [req.params.id],
    `Direction for ${attendee.name}`,
    message,
    { urgent: false, tone: 'normal' }
  );

  res.json({ ok: true, push });
});

// ─────────────────────────────────────────────────────────────
// AI ROUTE
// ─────────────────────────────────────────────────────────────
app.post('/api/agent', adminAuth, async (req, res) => {
  const { message = '', history = [], mode } = req.body;

  const status = loadStatus();
  const attendees = loadAttendees();
  const arrived = attendees.filter((a) => a.arrived).length;
  const feedback = loadFeedback();
  const avgRating =
    feedback.length > 0
      ? (feedback.reduce((s, f) => s + (Number(f.rating) || 0), 0) / feedback.length).toFixed(1)
      : 'N/A';

  // Rewrite-only mode
  if (mode === 'rewrite') {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({
        reply: (message || '').trim(),
      });
    }

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

      const rewrite = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system:
          'Rewrite the announcement to be clear, concise, professional, and event-appropriate. Return only the rewritten text.',
        messages: [{ role: 'user', content: message }],
      });

      const text = rewrite.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return res.json({ reply: text || message });
    } catch {
      return res.json({ reply: message });
    }
  }

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Missing ANTHROPIC_API_KEY');
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are NAV, the AI command assistant for SANKALP 2026.
You help the event admin manage the day smoothly. You can take actions using tools.

Current status:
- Current session: ${status.currentSession}
- Arrivals: ${arrived}/${attendees.length}
- Group 1 Tour: ${status.group1Tour}
- Group 2 Tour: ${status.group2Tour}
- Feedback: ${feedback.length} submissions, avg rating: ${avgRating}
- Recent feedback: ${feedback.slice(-3).map(f => `"${f.comment}" (${f.rating}★)`).join(' | ') || 'None yet'}

Always be concise, sharp, and helpful.`;

    const tools = [
      {
        name: 'send_announcement',
        description: 'Send announcement to all attendees',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            tone: { type: 'string', enum: ['normal', 'urgent', 'critical'] }
          },
          required: ['message']
        }
      },
      {
        name: 'update_session',
        description: 'Update current session',
        input_schema: {
          type: 'object',
          properties: {
            session: { type: 'string' }
          },
          required: ['session']
        }
      },
      {
        name: 'set_tour_status',
        description: 'Set tour status for a group',
        input_schema: {
          type: 'object',
          properties: {
            group: { type: 'number' },
            state: { type: 'string', enum: ['waiting', 'live', 'done', 'completed'] }
          },
          required: ['group', 'state']
        }
      },
      {
        name: 'open_feedback',
        description: 'Open feedback for all attendees',
        input_schema: {
          type: 'object',
          properties: {}
        }
      }
    ];

    const msgs = [
      ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: msgs
    });

    let replyText = '';
    const actions = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        replyText += block.text;
      }

      if (block.type === 'tool_use') {
        const { name, input } = block;
        actions.push({ tool: name, input });

        if (name === 'send_announcement') {
          const tone = input.tone || 'normal';
          const urgent = tone === 'urgent' || tone === 'critical';
          const announcement = createAnnouncementEntry({
            message: input.message,
            tone,
            urgent
          });

          const current = loadStatus();
          current.announcements.unshift(announcement);
          if (current.announcements.length > 30) current.announcements = current.announcements.slice(0, 30);
          current.notificationsSent = (current.notificationsSent || 0) + 1;
          current.lastAction = `Announced: "${input.message.substring(0, 40)}${input.message.length > 40 ? '...' : ''}"`;
          saveStatus(current);
          logAnnouncement(announcement);

          broadcast({
            type: 'announcement',
            announcement,
            alertId: announcement.id,
            message: announcement.message,
            tone: announcement.tone,
            urgent: announcement.urgent,
            time: announcement.time,
          });

          const pushTitle =
            tone === 'critical'
              ? '🚨 CRITICAL'
              : tone === 'urgent'
              ? '⚠️ SANKALP Alert'
              : '📢 SANKALP';

          await sendPushToTargets(resolveTargetIds('all'), pushTitle, announcement.message, {
            tone: announcement.tone,
            urgent: announcement.urgent,
            id: announcement.id,
          });
        }

        if (name === 'update_session') {
          const current = loadStatus();
          current.currentSession = input.session;
          current.lastAction = `Session updated: ${input.session}`;
          saveStatus(current);
          broadcast({ type: 'sessionUpdate', session: input.session });
        }

        if (name === 'set_tour_status') {
          const current = loadStatus();
          const state =
            input.state === 'completed' ? 'completed' :
            input.state === 'done' ? 'done' :
            input.state === 'live' ? 'live' :
            'waiting';

          current.tourGroups[String(input.group)] = state;
          current.group1Tour = current.tourGroups['1'];
          current.group2Tour = current.tourGroups['2'];
          current.lastAction = `Group ${input.group} tour: ${state}`;
          saveStatus(current);

          broadcast({
            type: 'tourUpdate',
            group: input.group,
            tourStatus: state,
            state,
          });
        }

        if (name === 'open_feedback') {
          const current = loadStatus();
          current.feedbackOpen = true;
          current.lastAction = 'Feedback opened';
          saveStatus(current);
          broadcast({ type: 'feedbackOpen' });
        }
      }
    }

    if (!replyText && actions.length) {
      replyText = `Done — ${actions.map((a) => a.tool.replace(/_/g, ' ')).join(', ')}.`;
    }

    return res.json({ reply: replyText || 'Done.', actions });
  } catch {
    const m = (message || '').toLowerCase();

    if ((m.includes('g1') || m.includes('group 1')) && m.includes('live')) {
      const current = loadStatus();
      current.tourGroups['1'] = 'live';
      current.group1Tour = 'live';
      saveStatus(current);
      broadcast({ type: 'tourUpdate', group: 1, tourStatus: 'live', state: 'live' });
      return res.json({ reply: 'Group 1 tour marked LIVE.' });
    }

    if ((m.includes('g1') || m.includes('group 1')) && (m.includes('done') || m.includes('completed'))) {
      const current = loadStatus();
      current.tourGroups['1'] = 'done';
      current.group1Tour = 'done';
      saveStatus(current);
      broadcast({ type: 'tourUpdate', group: 1, tourStatus: 'done', state: 'done' });
      return res.json({ reply: 'Group 1 tour marked DONE.' });
    }

    if ((m.includes('g2') || m.includes('group 2')) && m.includes('live')) {
      const current = loadStatus();
      current.tourGroups['2'] = 'live';
      current.group2Tour = 'live';
      saveStatus(current);
      broadcast({ type: 'tourUpdate', group: 2, tourStatus: 'live', state: 'live' });
      return res.json({ reply: 'Group 2 tour marked LIVE.' });
    }

    if ((m.includes('g2') || m.includes('group 2')) && (m.includes('done') || m.includes('completed'))) {
      const current = loadStatus();
      current.tourGroups['2'] = 'done';
      current.group2Tour = 'done';
      saveStatus(current);
      broadcast({ type: 'tourUpdate', group: 2, tourStatus: 'done', state: 'done' });
      return res.json({ reply: 'Group 2 tour marked DONE.' });
    }

    if (m.includes('lunch')) {
      return res.json({ reply: 'Lunch announcement ready. Use Broadcast to send it.' });
    }

    if (m.includes('bus') || m.includes('depart')) {
      return res.json({ reply: 'Bus alert ready. Use Broadcast to send it.' });
    }

    if (m.includes('feedback')) {
      const current = loadStatus();
      current.feedbackOpen = true;
      saveStatus(current);
      broadcast({ type: 'feedbackOpen' });
      return res.json({ reply: 'Feedback widget opened for all attendees.' });
    }

    if (m.includes('status')) {
      return res.json({
        reply: `Status: ${arrived}/${attendees.length} arrived | Session: ${status.currentSession} | G1: ${status.group1Tour} | G2: ${status.group2Tour} | Feedback: ${feedback.length} (${avgRating}★)`,
      });
    }

    return res.json({
      reply: 'AI agent needs ANTHROPIC_API_KEY in .env to handle open-ended commands.',
    });
  }
});

// ─────────────────────────────────────────────────────────────
// SCHEDULED NOTIFICATIONS
// ─────────────────────────────────────────────────────────────
function checkScheduled() {
  try {
    const event = loadEvent();
    const status = loadStatus();
    const now = new Date();

    const day = now.getHours() < 4 ? status.day - 1 : status.day;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    (event.notifications || []).forEach(async (n) => {
      if (n.day === day && n.time === timeStr && !n.sent) {
        n.sent = true;

        const tone = n.type === 'urgent' ? 'urgent' : 'normal';
        const announcement = createAnnouncementEntry({
          message: n.body,
          tone,
          urgent: n.type === 'urgent',
          type: n.type === 'urgent' ? 'urgent' : 'info',
        });

        status.announcements.unshift(announcement);
        if (status.announcements.length > 30) status.announcements = status.announcements.slice(0, 30);

        if (n.triggerFeedback) status.feedbackOpen = true;

        saveStatus(status);
        saveEvent(event);
        logAnnouncement(announcement);

        broadcast({
          type: 'announcement',
          announcement,
          alertId: announcement.id,
          message: announcement.message,
          tone: announcement.tone,
          urgent: announcement.urgent,
          time: announcement.time,
        });

        if (n.triggerFeedback) {
          broadcast({ type: 'feedbackOpen' });
        }

        await sendPushToTargets(
          resolveTargetIds('all'),
          n.title || '📢 SANKALP',
          n.body,
          {
            tone: announcement.tone,
            urgent: announcement.urgent,
            id: announcement.id,
          }
        );
      }
    });
  } catch {}
}

setInterval(checkScheduled, 30000);

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌿 SANKALP running on http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin  (PIN: ${ADMIN_PIN})`);
  console.log(`   Attendee example: http://localhost:${PORT}/a/nav-001\n`);
});
