// Parses wrangler tail --format json captures (concatenated pretty-printed
// events) and prints one line per event with its logs/exceptions.
const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const events = [];
let depth = 0, start = -1, inStr = false, esc = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (esc) { esc = false; continue; }
  if (c === '\\' && inStr) { esc = true; continue; }
  if (c === '"') inStr = !inStr;
  if (inStr) continue;
  if (c === '{') { if (depth === 0) start = i; depth++; }
  else if (c === '}') { depth--; if (depth === 0 && start >= 0) { events.push(raw.slice(start, i + 1)); start = -1; } }
}
for (const ev of events) {
  try {
    const e = JSON.parse(ev);
    const logs = (e.logs || []).map((x) => (x.message ? x.message.join(' ') : JSON.stringify(x))).join(' | ');
    const exc = (e.exceptions || []).map((x) => x.message || '').join(' | ');
    const t = e.eventTimestamp ? new Date(e.eventTimestamp).toISOString().slice(11, 19) : '?';
    const isCron = e.event && e.event.cron ? '[cron]' : '';
    console.log(t, e.executionModel || '', isCron, '=>', String(logs || exc || '(no logs)').slice(0, 400));
  } catch { console.log('unparsed chunk'); }
}
console.log('events:', events.length);
