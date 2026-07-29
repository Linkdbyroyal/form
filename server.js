// server.js — Linkd by Royal Discovery Intake backend v3
// Klant vult in en verstuurt -> server slaat dossier op, genereert AI-analyse
// en mailt het volledige rapport naar de eigenaar (OWNER_EMAIL).
// De klant ziet alleen een bedankpagina. Node 18+ vereist.
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

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'd.haddocks@gmail.com';
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: (process.env.SMTP_PORT || '587') === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

const checkToken = (req, res) => {
  if (!process.env.ADMIN_TOKEN || (req.query.token !== process.env.ADMIN_TOKEN)) {
    res.status(401).send('Ongeldig of ontbrekend token'); return false;
  }
  return true;
};

/* ---------- AI-analyse ---------- */
const SYSTEM_PROMPT = `Je bent een senior strategisch consultant met 15+ jaar ervaring in bedrijfsanalyse, digitale transformatie en operationele optimalisatie voor mkb-bedrijven, werkend namens consultancybureau Linkd by Royal. Je analyseert een Discovery Intake van een nieuwe reisonderneming (Curaçao naar Venezuela, later Colombia).

Wees kritisch maar constructief, wees voorzichtig met aannames en maak ze expliciet, geef realistische tijdlijnen en marktconforme bedragen in euro's, en focus eerst op high-impact low-effort acties. Gebruik de prioriteitsmatrix-antwoorden (per onderdeel prio_*_impact en prio_*_effort, schaal 1-5) om quick wins te identificeren.

Bereken drie scores op schaal 0-100 en vergelijk met een realistisch branchegemiddelde voor kleine reisorganisaties:
- digitalMaturity: gebaseerd op aanwezigheid van website, CRM, online boeken/betalen, boekingssysteem en team-IT-niveau
- aiReadiness: gebaseerd op AI-ervaring, team-comfort, budget en helderheid van use-cases
- risk: gebaseerd op regelgeving, vergunningen, budget, teamcapaciteit en marktrisico (hoger = meer risico)

Antwoord UITSLUITEND met geldige JSON, zonder markdown-codeblokken en zonder tekst ervoor of erna, exact in dit formaat:
{
 "samenvatting":"3-5 zinnen managementsamenvatting incl. waarom nu actie nodig is",
 "knelpunten":{"operationeel":["..."],"digitaal":["..."],"regelgeving":["..."]},
 "kansen":{"groei":["..."],"automatisering":["..."]},
 "quickWins":[{"actie":"...","waarom":"...","kosten":"€...","impact":"...","tijdlijn":"..."}],
 "kostenraming":[{"onderdeel":"...","laag":"€...","gemiddeld":"€...","hoog":"€..."}],
 "kostenramingTotaal":{"laag":"€...","gemiddeld":"€...","hoog":"€..."},
 "roadmap":[{"fase":"...","tijdlijn":"Maanden X-Y","budget":"€...","acties":"...","resultaten":"..."}],
 "scores":{"digitalMaturity":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},"aiReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},"risk":{"score":0,"benchmark":0,"interpretatie":"...","mitigatie":"..."}},
 "gespreksleidraad":{"Strategie & Visie":["..."],"Operatie & Processen":["..."],"Financiën & Budget":["..."],"Risico's & Compliance":["..."]}
}
Schrijf alles in het Nederlands, zakelijk en concreet. 2-4 items per lijst, 3-4 quick wins, 4 roadmap-fasen, 2-3 vragen per gespreksleidraad-thema.`;

async function runAnalysis(answers) {
  const lines = Object.entries(answers)
    .filter(([k, v]) => v !== '' && v !== null && v !== undefined && (Array.isArray(v) ? v.length : true))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Intake-antwoorden:\n${lines || '(leeg)'}` }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
  const data = await r.json();
  const text = data.content.map(b => b.text || '').join('\n');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Geen JSON in modelantwoord');
  return JSON.parse(match[0]);
}

/* ---------- Inzending: opslaan -> analyse -> mail naar eigenaar ---------- */
app.post('/api/submit', async (req, res) => {
  try {
    const { answers, lang } = req.body;
    if (!answers) return res.status(400).json({ error: 'answers vereist' });
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' +
      String(answers.bedrijfsnaam || 'onbekend').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const record = { id, receivedAt: new Date().toISOString(), lang: lang || 'nl', answers, analysis: null };
    fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));

    // Klant krijgt direct bevestiging; analyse en mail draaien op de achtergrond
    res.json({ ok: true, id });

    (async () => {
      try {
        record.analysis = await runAnalysis(answers);
        fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));
      } catch (e) { console.error('Analyse-fout voor', id, ':', e.message); }
      await notifyOwner(record, req);
    })();
  } catch (err) {
    console.error('Submit-fout:', err.message);
    res.status(500).json({ error: 'Opslaan mislukt' });
  }
});

async function notifyOwner(record, req) {
  if (!mailer) { console.log('SMTP niet geconfigureerd; mail overgeslagen voor', record.id); return; }
  const a = record.answers || {}, an = record.analysis;
  const base = process.env.PUBLIC_URL || `https://${req.headers.host}`;
  const reportLink = `${base}/report/${encodeURIComponent(record.id)}?token=${encodeURIComponent(process.env.ADMIN_TOKEN || '')}`;
  const dashLink = `${base}/admin?token=${encodeURIComponent(process.env.ADMIN_TOKEN || '')}`;
  const body = [
    `Nieuwe Discovery Intake ontvangen.`,
    ``,
    `Bedrijf: ${a.bedrijfsnaam || 'Onbekend'}`,
    `Naam: ${a.contact_naam || '-'}`,
    `E-mail klant: ${a.contact_email || '-'}`,
    `Taal: ${record.lang}`,
    `Ontvangen: ${new Date(record.receivedAt).toLocaleString('nl-NL')}`,
    ``,
    an ? `Managementsamenvatting:\n${an.samenvatting}` : `Let op: de AI-analyse kon niet worden gegenereerd; de antwoorden zijn wel opgeslagen.`,
    ``,
    `Volledig rapport (met PDF-download): ${reportLink}`,
    `Dashboard: ${dashLink}`,
    ``,
    `Het complete dossier (alle antwoorden + analyse) zit als bijlage bij deze mail.`
  ].join('\n');
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: OWNER_EMAIL,
      subject: `Nieuwe intake: ${a.bedrijfsnaam || 'Onbekend'} — Discovery & Strategy`,
      text: body,
      attachments: [{ filename: `intake-${record.id}.json`, content: JSON.stringify(record, null, 2) }]
    });
    console.log('Eigenaar gemaild voor', record.id);
  } catch (e) { console.error('Mail-fout voor', record.id, ':', e.message); }
}

/* ---------- Dashboard ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

app.get('/admin', (req, res) => {
  if (!checkToken(req, res)) return;
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  const rows = files.map(f => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return `<tr>
        <td>${esc(new Date(r.receivedAt).toLocaleString('nl-NL'))}</td>
        <td><b>${esc(r.answers?.bedrijfsnaam || 'Onbekend')}</b></td>
        <td>${esc(r.answers?.contact_email || '')}</td>
        <td>${r.analysis ? 'Ja' : 'Nee'}</td>
        <td><a class="btn" href="/report/${encodeURIComponent(r.id)}?token=${encodeURIComponent(req.query.token)}">Rapport / PDF</a></td>
      </tr>`;
    } catch(e){ return ''; }
  }).join('');
  res.send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intake Dashboard — Linkd by Royal</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body{margin:0;font-family:'Inter',sans-serif;background:#f8f6f0;color:#1c2430;}
    header{background:#0f1b2d;color:#fff;padding:22px 28px;}
    header h1{font-family:'Playfair Display',serif;font-size:22px;margin:0;}
    header h1 span{color:#e3cd9a;}
    main{max-width:960px;margin:34px auto;padding:0 20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;border-radius:12px;overflow:hidden;}
    th{background:#0f1b2d;color:#fff;text-align:left;padding:11px 14px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;}
    td{padding:12px 14px;border-top:1px solid #e4ddce;font-size:14px;}
    .btn{background:#c6a15b;color:#0f1b2d;text-decoration:none;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:8px;display:inline-block;}
    .empty{padding:40px;text-align:center;color:#6b7480;background:#fff;border:1px solid #e4ddce;border-radius:12px;}
  </style></head><body>
  <header><h1>Linkd <span>by Royal</span> — Intake Dashboard</h1></header>
  <main>
    ${files.length ? `<table><tr><th>Ontvangen</th><th>Bedrijf</th><th>E-mail</th><th>Analyse</th><th></th></tr>${rows}</table>` : `<div class="empty">Nog geen inzendingen ontvangen.</div>`}
  </main></body></html>`);
});

/* ---------- Volledig rapport per inzending (print/PDF) ---------- */
const LABELS = {
  bedrijfsnaam:'Bedrijfsnaam', stadium:'Huidig stadium', werknemers:'Aantal werknemers',
  bedrijf_intro:'Omschrijving bedrijf', missie:'Missie', visie:'Visie 5 jaar',
  waarom_venezuela:'Waarom Venezuela', waarom_colombia:'Waarom Colombia',
  onderscheidend:'Onderscheidend vermogen', startdatum:'Beoogde startdatum',
  doelstellingen:'Doelstellingen', doelstellingen_anders:'Doelstellingen (anders)',
  ambitie_score:'Ambitie (1-10)', visie_1jaar:'Visie over 1 jaar',
  diensten:'Diensten', diensten_anders:'Diensten (anders)', usp:'Unieke propositie',
  doelgroep_markt:'Herkomstmarkten', doelgroep_segment:'Klantsegmenten', ideale_klant:'Ideale klant',
  besluitvormers:'Besluitvormers', it_niveau:'IT-vaardigheden team',
  implementatie_eigenaar:'Implementatie-eigenaar', team_beschikbaarheid:'Teambeschikbaarheid',
  omzet:'Jaarlijkse omzet', budget:'Budget 12 maanden', financiering:'Financieringsmogelijkheden',
  budget_beperkingen:'Budgetbeperkingen',
  website:'Website aanwezig', website_url:'Website-URL', crm:'CRM aanwezig', crm_naam:'CRM',
  whatsapp:'WhatsApp Business', betalingen:'Online betalingen', betalingen_provider:'Betaalprovider',
  boekingssysteem:'Boekingssysteem aanwezig', boekingssysteem_naam:'Boekingssysteem',
  leveranciers:'Vaste leveranciers', contracten:'Contracten',
  proces_huidig:'Huidig boekingsproces', proces_knelpunten:'Knelpunten', proces_tijdrovend:'Tijdrovende processen',
  vergunningen:'Vergunningen en licenties', compliance_uitdagingen:'Compliance-uitdagingen',
  juridisch_advies:'Juridisch advies', concurrenten:'Concurrenten',
  concurrenten_beter:'Beter presterende concurrenten', voorbeeldbedrijven:'Voorbeeldbedrijven',
  branding_positionering:'Gewenste positionering', branding_positionering_anders:'Positionering (anders)',
  branding_middelen:'Bestaande merkmiddelen', merkpersoonlijkheid:'Merkpersoonlijkheid',
  website_functies:'Gewenste websitefuncties', boekingsproces_wens:'Ideale boekingsflow',
  talen_wens:'Talen', communicatie_kanalen:'Communicatiekanalen',
  ai_toepassingen:'AI-toepassingen', ai_comfort:'AI-comfortniveau', ai_eerder:'Eerdere AI-ervaring',
  verwachting_lbr:'Verwachtingen van Linkd by Royal', zorgen:"Risico's en zorgen",
  risicobereidheid:'Risicobereidheid', contact_naam:'Naam contactpersoon', contact_email:'Contact e-mail'
};
const PRIO_LABELS = {
  prio_website:'Website & online boeken', prio_crm:'CRM & klantbeheer', prio_ai:'AI & automatisering',
  prio_branding:'Branding', prio_leveranciers:'Leverancierscontracten', prio_marketing:'Marketing',
  prio_compliance:'Vergunningen & compliance'
};

app.get('/report/:id', (req, res) => {
  if (!checkToken(req, res)) return;
  const file = path.join(DATA_DIR, req.params.id + '.json');
  if (!fs.existsSync(file)) return res.status(404).send('Niet gevonden');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = r.answers || {}, an = r.analysis || null;

  const answerRows = Object.entries(LABELS)
    .filter(([k]) => a[k] !== undefined && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length))
    .map(([k,lbl]) => `<tr><td class="lbl">${esc(lbl)}</td><td>${esc(Array.isArray(a[k]) ? a[k].join(', ') : a[k])}</td></tr>`).join('');

  const prioRows = Object.entries(PRIO_LABELS)
    .filter(([k]) => a[k+'_impact'] || a[k+'_effort'])
    .map(([k,lbl]) => `<tr><td class="lbl">${esc(lbl)}</td><td>Impact ${esc(a[k+'_impact'] ?? '–')} / 5 · Moeite ${esc(a[k+'_effort'] ?? '–')} / 5</td></tr>`).join('');

  const list = arr => `<ul>${(arr||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  const cat = obj => Object.entries(obj||{}).map(([k,v])=>`<h4>${esc(k)}</h4>${list(v)}`).join('');

  const analysisHtml = an ? `
    <h2>Strategische analyse</h2>
    <div class="block"><h3>Managementsamenvatting</h3><p>${esc(an.samenvatting||'')}</p></div>
    <div class="scores">
      ${[['Digital Maturity',an.scores?.digitalMaturity],['AI Readiness',an.scores?.aiReadiness],['Risicoscore',an.scores?.risk]]
        .map(([l,s])=>`<div class="score"><div class="num">${esc(s?.score ?? '–')}<small>/100</small></div><div>${l}</div><div class="bench">Branche: ${esc(s?.benchmark ?? '–')}</div></div>`).join('')}
    </div>
    <div class="block"><h3>Score-interpretatie</h3>
      <p><b>Digital Maturity:</b> ${esc(an.scores?.digitalMaturity?.interpretatie||'')}</p>
      <p><b>AI Readiness:</b> ${esc(an.scores?.aiReadiness?.interpretatie||'')}</p>
      <p><b>Risico:</b> ${esc(an.scores?.risk?.interpretatie||'')} ${an.scores?.risk?.mitigatie?('<br><b>Mitigatie:</b> '+esc(an.scores.risk.mitigatie)):''}</p>
    </div>
    <div class="block"><h3>Knelpunten</h3>${cat(an.knelpunten)}</div>
    <div class="block"><h3>Kansen</h3>${cat(an.kansen)}</div>
    <div class="block"><h3>Quick wins</h3>${(an.quickWins||[]).map(q=>`<p><b>${esc(q.actie)}</b><br>${esc(q.waarom)}<br>Kosten: ${esc(q.kosten)} · Impact: ${esc(q.impact)} · Tijdlijn: ${esc(q.tijdlijn)}</p>`).join('')}</div>
    <div class="block"><h3>Kostenraming (indicatief)</h3>
      <table><tr><th>Onderdeel</th><th>Laag</th><th>Gemiddeld</th><th>Hoog</th></tr>
      ${(an.kostenraming||[]).map(c=>`<tr><td>${esc(c.onderdeel)}</td><td>${esc(c.laag)}</td><td>${esc(c.gemiddeld)}</td><td>${esc(c.hoog)}</td></tr>`).join('')}
      ${an.kostenramingTotaal?`<tr class="tot"><td>Totaal</td><td>${esc(an.kostenramingTotaal.laag)}</td><td>${esc(an.kostenramingTotaal.gemiddeld)}</td><td>${esc(an.kostenramingTotaal.hoog)}</td></tr>`:''}</table></div>
    <div class="block"><h3>Roadmap</h3>${(an.roadmap||[]).map(p=>`<p><b>${esc(p.fase)}</b> (${esc(p.tijdlijn)}, ${esc(p.budget)})<br>${esc(p.acties)}<br><i>Resultaten:</i> ${esc(p.resultaten)}</p>`).join('')}</div>
    <div class="block"><h3>Gespreksleidraad</h3>${cat(an.gespreksleidraad)}</div>
  ` : `<h2>Strategische analyse</h2><p class="muted">De analyse wordt gegenereerd of is niet gelukt; ververs deze pagina over een minuut.</p>`;

  res.send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intake-rapport ${esc(a.bedrijfsnaam||'')}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body{margin:0;font-family:'Inter',sans-serif;background:#f8f6f0;color:#1c2430;font-size:13.5px;line-height:1.65;}
    .topbar{background:#0f1b2d;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;}
    .topbar .brand{font-family:'Playfair Display',serif;font-size:18px;}
    .topbar .brand span{color:#e3cd9a;}
    .topbar .actions a,.topbar .actions button{background:#c6a15b;color:#0f1b2d;border:none;font-family:'Inter',sans-serif;font-weight:700;font-size:12.5px;padding:9px 16px;border-radius:8px;cursor:pointer;text-decoration:none;margin-left:8px;}
    main{max-width:800px;margin:30px auto 60px;padding:0 22px;}
    h1{font-family:'Playfair Display',serif;color:#0f1b2d;font-size:28px;margin:8px 0 2px;}
    h2{font-family:'Playfair Display',serif;color:#0f1b2d;font-size:20px;margin:34px 0 12px;border-bottom:2px solid #c6a15b;padding-bottom:6px;}
    h3{font-size:14px;color:#0f1b2d;margin:0 0 8px;}
    h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7480;margin:12px 0 4px;}
    .meta{color:#6b7480;font-size:12.5px;margin-bottom:6px;}
    .block{margin-bottom:20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;}
    th{background:#0f1b2d;color:#fff;text-align:left;padding:8px 11px;font-size:11.5px;}
    td{padding:8px 11px;border-top:1px solid #e4ddce;vertical-align:top;}
    td.lbl{width:230px;font-weight:600;color:#0f1b2d;background:#fdfbf5;}
    tr.tot td{font-weight:700;color:#0f1b2d;}
    ul{margin:4px 0;padding-left:18px;}
    .scores{display:flex;gap:12px;margin:14px 0;}
    .score{flex:1;background:#0f1b2d;color:#fff;border-radius:10px;padding:14px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}
    .score .num{font-family:'Playfair Display',serif;font-size:26px;color:#e3cd9a;text-transform:none;}
    .score .num small{font-size:12px;color:#9aa7b8;}
    .score .bench{color:#9aa7b8;margin-top:5px;text-transform:none;letter-spacing:0;}
    .muted{color:#6b7480;}
    @media print{.topbar{display:none;}body{background:#fff;}main{margin:0;max-width:100%;}}
  </style></head><body>
  <div class="topbar">
    <div class="brand">Linkd <span>by Royal</span></div>
    <div class="actions">
      <a href="/admin?token=${encodeURIComponent(req.query.token)}">Dashboard</a>
      <button onclick="window.print()">Download als PDF</button>
    </div>
  </div>
  <main>
    <div class="meta">Discovery &amp; Strategy Intake · ontvangen ${esc(new Date(r.receivedAt).toLocaleString('nl-NL'))} · taal: ${esc(r.lang||'nl')}</div>
    <h1>${esc(a.bedrijfsnaam || 'Onbekend bedrijf')}</h1>
    <div class="meta">${esc(a.contact_naam || '')} ${a.contact_email?('· '+esc(a.contact_email)):''}</div>
    <h2>Intake-antwoorden</h2>
    <table>${answerRows || '<tr><td>Geen antwoorden</td></tr>'}</table>
    ${prioRows ? `<h2>Prioriteitsmatrix</h2><table>${prioRows}</table>` : ''}
    ${analysisHtml}
  </main></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Linkd by Royal intake-backend v3 draait op poort ${PORT}`));
