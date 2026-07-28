// server.js — Linkd by Royal Discovery Intake backend
// Node 18+ vereist (gebruikt ingebouwde fetch)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Mail ----------
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

const CLIENT_MAIL_TEXT = fs.existsSync(path.join(__dirname, 'klantmail-template.md'))
  ? fs.readFileSync(path.join(__dirname, 'klantmail-template.md'), 'utf8')
      .replace(/^# .*\n+/,'').replace(/^Onderwerp:.*\n+/m,'').replace(/[#*]/g,'')
  : 'Beste {{CLIENT_NAME}},\n\nDank voor het invullen van de Discovery Intake. In de bijlage vindt u uw strategische analyse. Plan uw strategiegesprek via: {{CALENDLY_LINK}}\n\nMet vriendelijke groet,\n{{CONSULTANT_NAME}}\nLinkd by Royal';

// ---------- AI-analyse (server-side, key blijft geheim) ----------
app.post('/api/analyze', async (req, res) => {
  try {
    const { intakeText, systemPrompt } = req.body;
    if (!intakeText || !systemPrompt) return res.status(400).json({ error: 'intakeText en systemPrompt vereist' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: intakeText }]
      })
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const text = data.content.map(b => b.text || '').join('\n');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Geen JSON in modelantwoord');
    res.json(JSON.parse(match[0]));
  } catch (err) {
    console.error('Analyse-fout:', err.message);
    res.status(500).json({ error: 'Analyse mislukt' });
  }
});

// ---------- Inzending opslaan + mails versturen ----------
app.post('/api/submit', async (req, res) => {
  try {
    const { answers, analysis } = req.body;
    if (!answers) return res.status(400).json({ error: 'answers vereist' });

    // 1) Opslaan als dossier
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '_' +
      String(answers.bedrijfsnaam || 'onbekend').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const record = { id, receivedAt: new Date().toISOString(), answers, analysis: analysis || null };
    fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));

    // 2) Mails (alleen als SMTP is geconfigureerd)
    let mailed = { consultant: false, client: false };
    if (mailer) {
      const vars = {
        CLIENT_NAME: answers.bedrijfsnaam || 'relatie',
        CALENDLY_LINK: process.env.CALENDLY_LINK || '',
        CONSULTANT_NAME: process.env.CONSULTANT_NAME || 'Linkd by Royal',
        CONSULTANT_EMAIL: process.env.CONSULTANT_EMAIL || process.env.SMTP_USER || '',
        CONSULTANT_PHONE: process.env.CONSULTANT_PHONE || ''
      };
      const attachments = [{ filename: `intake-${id}.json`, content: JSON.stringify(record, null, 2) }];

      // Notificatie naar consultant
      try {
        await mailer.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: process.env.CONSULTANT_EMAIL || process.env.SMTP_USER,
          subject: `Nieuwe Discovery Intake: ${vars.CLIENT_NAME}`,
          text: `Er is een nieuwe intake binnengekomen van ${vars.CLIENT_NAME} (${answers.contact_email || 'geen e-mail opgegeven'}).\n\nSamenvatting analyse:\n${analysis?.samenvatting || '(geen analyse meegestuurd)'}\n\nHet volledige dossier zit als bijlage bij deze mail en staat op de server onder data/${id}.json.`,
          attachments
        });
        mailed.consultant = true;
      } catch (e) { console.error('Consultantmail mislukt:', e.message); }

      // Bevestiging naar klant
      if (answers.contact_email) {
        try {
          await mailer.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to: answers.contact_email,
            subject: 'Uw Discovery Intake is voltooid, strategische analyse volgt',
            text: fillTemplate(CLIENT_MAIL_TEXT, vars)
          });
          mailed.client = true;
        } catch (e) { console.error('Klantmail mislukt:', e.message); }
      }
    }

    res.json({ ok: true, id, mailed });
  } catch (err) {
    console.error('Submit-fout:', err.message);
    res.status(500).json({ error: 'Opslaan mislukt' });
  }
});

// ---------- Dossiers inzien (eenvoudige beveiliging met token) ----------
app.get('/api/submissions', (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Ongeldig token' });
  }
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  res.json(files.map(f => {
    const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    return { id: r.id, receivedAt: r.receivedAt, bedrijf: r.answers?.bedrijfsnaam, email: r.answers?.contact_email };
  }));
});
app.get('/api/submissions/:id', (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Ongeldig token' });
  }
  const file = path.join(DATA_DIR, req.params.id + '.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Linkd by Royal intake-backend draait op poort ${PORT}`));
