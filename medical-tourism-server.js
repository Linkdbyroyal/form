// server.js — Linkd by Royal Medical Tourism Venture Discovery Intake
// Klant vult in en verstuurt. De server slaat het dossier op, genereert op de
// achtergrond de strategische analyse en mailt het rapport naar de eigenaar.
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

/* ---------- Analyse ---------- */
const SYSTEM_PROMPT = `Je bent een senior strategisch consultant van Linkd by Royal met ervaring in businessontwikkeling, medische facilitatie, operationele inrichting, digitale transformatie en risicobeheersing.

Je analyseert een Discovery Intake voor een medisch-toerisme- en patiëntfacilitatieproject vanuit Curaçao naar Venezuela, met Colombia als mogelijke vervolgmarkt. De intake is ingevuld door de initiatiefnemers en besluitvormers, niet door patiënten.

Schrijf als een ervaren consultant die initiatiefnemers en besluitvormers voorbereidt op besluitvorming. De stijl is rustig, concreet, zorgvuldig en besluitgericht, alsof het rapport in een directieoverleg wordt besproken. Gebruik korte alinea's en natuurlijke Nederlandse zakelijke taal. Koppel elke observatie aan de ingevulde antwoorden.

Verboden in alle teksten: em dashes, dubbele streepjes, verwijzingen naar AI of automatische generatie, standaardzinnen, lege consultancytaal, overdreven marketingclaims, generieke aanbevelingen die op elk bedrijf toepasbaar zijn, lange inleidingen en herhaling van conclusies. Vermijd formuleringen zoals "in de huidige dynamische markt", "het is belangrijk om te benadrukken", "door middel van", "samenvattend kunnen we stellen", "de sleutel tot succes", "het is cruciaal", "het is essentieel", "een toekomstbestendige oplossing", "een holistische aanpak" en "optimaal inspelen op".

Als informatie ontbreekt: benoem dit expliciet als ontbrekende informatie, aanname, risico of open besluitpunt. Verzin nooit ontbrekende feiten.

Geef nooit medisch advies, een diagnose, behandeladvies, klinische aanbeveling, juridisch advies, financieel advies of enige garantie of zekerheid. Benoem duidelijk wanneer specialistisch juridisch, privacy-, verzekerings- of medisch advies nodig is.

Prioriteer in deze volgorde: 1 patiëntveiligheid, 2 privacy en veilige gegevensverwerking, 3 kliniek- en partnerverificatie, 4 duidelijke aansprakelijkheidsgrenzen, 5 crisis- en escalatieproces, 6 een gecontroleerde pilot, 7 pas daarna marketingopschaling en automatisering.

Gebruik de prioriteitsmatrix-antwoorden (per onderdeel prio_*_impact en prio_*_effort, schaal 1 tot 5) om quick wins te identificeren. Bedragen zijn in euro's en marktconform.

Bereken zeven scores op schaal 0 tot 100 met een realistisch branchegemiddelde voor startende medische facilitators: digitalMaturity, aiReadiness, risk (hoger is meer risico), medicalOperationalReadiness, partnerReadiness, privacyComplianceReadiness en patientSafetyReadiness.

Voor bedrijfsidentiteit: baseer je uitsluitend op bedrijfsnaam en naamverhaal uit de intake. De positioneringszin is maximaal 25 woorden, belooft geen medische resultaten en bevat geen superlatieven zoals "de beste", "marktleider" of "uniek" tenzij de intake daar aantoonbaar aanleiding toe geeft. Als het naamverhaal of de positionering onvoldoende duidelijk is, gebruik dan letterlijk: "De merkbetekenis en positionering zijn nog onvoldoende uitgewerkt. Dit vraagt om een afzonderlijke positioneringssessie voor externe lancering."

Voor goNoGoAssessment: kies status "Go", "Go met voorwaarden" of "Nog niet starten". "Go met voorwaarden" betekent dat de pilot kan starten nadat de benoemde voorwaarden aantoonbaar zijn ingevuld.

Antwoord UITSLUITEND met geldige JSON, zonder markdown-codeblokken en zonder tekst ervoor of erna, exact in deze structuur:
{
 "samenvatting":"3 tot 5 zinnen",
 "bedrijfsidentiteit":{"bedrijfsnaam":"...","naamverhaal":"...","positionering":"...","positioneringszin":"...","ontbrekendeInformatie":"..."},
 "knelpunten":{"operationeel":["..."],"digitaal":["..."],"regelgeving":["..."],"partnernetwerk":["..."],"patientveiligheid":["..."]},
 "kansen":{"groei":["..."],"automatisering":["..."],"positionering":["..."]},
 "quickWins":[{"actie":"...","waarom":"...","kosten":"...","impact":"...","tijdlijn":"..."}],
 "kostenraming":[{"onderdeel":"...","laag":"...","gemiddeld":"...","hoog":"..."}],
 "kostenramingTotaal":{"laag":"...","gemiddeld":"...","hoog":"..."},
 "roadmap":[{"fase":"...","tijdlijn":"...","budget":"...","acties":["..."],"resultaten":["..."]}],
 "scores":{
   "digitalMaturity":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},
   "aiReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},
   "risk":{"score":0,"benchmark":0,"interpretatie":"...","mitigatie":"..."},
   "medicalOperationalReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},
   "partnerReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},
   "privacyComplianceReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0},
   "patientSafetyReadiness":{"score":0,"benchmark":0,"interpretatie":"...","doel12mnd":0}
 },
 "goNoGoAssessment":{"status":"Go / Go met voorwaarden / Nog niet starten","voorwaarden":["..."],"grootsteRisico":"..."},
 "gespreksleidraad":{"Strategie & Positionering":["..."],"Operatie & Patiëntreis":["..."],"Partners & Kwaliteit":["..."],"Financiën & Budget":["..."],"Risico, Privacy & Compliance":["..."]}
}
2 tot 4 items per lijst, 3 tot 4 quick wins, 3 tot 4 roadmap-fasen, 2 tot 3 vragen per gespreksleidraad-thema.`;

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
      max_tokens: 6000,
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
  const bodyLines = [
    `Nieuwe Medical Tourism Discovery Intake ontvangen.`,
    ``,
    `Bedrijf: ${a.bedrijfsnaam || 'Onbekend'}`,
    `Contactpersoon: ${a.contact_naam || '-'}`,
    `E-mail: ${a.contact_email || '-'}`,
    `Taal: ${record.lang}`,
    `Ontvangen: ${new Date(record.receivedAt).toLocaleString('nl-NL')}`,
    ``,
    an ? `Samenvatting:\n${an.samenvatting}` : `Let op: de analyse kon niet worden gegenereerd; de antwoorden zijn wel opgeslagen.`
  ];
  if (an && an.goNoGoAssessment) bodyLines.push(``, `Pilotbeoordeling: ${an.goNoGoAssessment.status}`);
  bodyLines.push(``, `Volledig rapport (met PDF-download): ${reportLink}`, `Dashboard: ${dashLink}`, ``, `Het complete dossier zit als bijlage bij deze mail.`);
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: OWNER_EMAIL,
      subject: `Nieuwe intake: ${a.bedrijfsnaam || 'Onbekend'} (Medical Tourism Discovery)`,
      text: bodyLines.join('\n'),
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
        <td>${esc(r.answers?.contact_naam || '')}</td>
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
    main{max-width:1000px;margin:34px auto;padding:0 20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;border-radius:12px;overflow:hidden;}
    th{background:#0f1b2d;color:#fff;text-align:left;padding:11px 14px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;}
    td{padding:12px 14px;border-top:1px solid #e4ddce;font-size:14px;}
    .btn{background:#c6a15b;color:#0f1b2d;text-decoration:none;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:8px;display:inline-block;}
    .empty{padding:40px;text-align:center;color:#6b7480;background:#fff;border:1px solid #e4ddce;border-radius:12px;}
  </style></head><body>
  <header><h1>Linkd <span>by Royal</span> — Intake Dashboard</h1></header>
  <main>
    ${files.length ? `<table><tr><th>Ontvangen</th><th>Bedrijf</th><th>Contactpersoon</th><th>E-mail</th><th>Analyse</th><th></th></tr>${rows}</table>` : `<div class="empty">Nog geen inzendingen ontvangen.</div>`}
  </main></body></html>`);
});

/* ---------- Rapport per inzending (print/PDF) ---------- */
const LABELS = {
  bedrijfsnaam:'Bedrijfsnaam', naamverhaal:'Verhaal achter de bedrijfsnaam', stadium:'Huidig stadium',
  bedrijf_intro:'Omschrijving initiatief', waarom_venezuela:'Waarom Venezuela', waarom_colombia:'Waarom Colombia (fase 2)',
  startdatum:'Beoogde startdatum pilot', besluitvormers:'Belangrijkste beslissers', implementatie_eigenaar:'Verantwoordelijk voor uitvoering',
  rol_organisatie:'Primaire rol organisatie', rol_organisatie_anders:'Primaire rol (anders)',
  doelen_12mnd:'Doelen binnen 12 maanden', doelen_12mnd_anders:'Doelen 12 maanden (anders)',
  succescriteria:'Succescriteria', diensten_fase1:'Diensten fase 1', diensten_fase1_anders:'Diensten fase 1 (anders)',
  diensten_niet_fase1:'Bewust geen onderdeel van fase 1',
  besteding_per_patient:'Verwachte besteding per patiënt', facturatie:'Wie factureert de patiënt',
  doelgroep_markt:'Primaire herkomstmarkt', doelgroep_markt_anders:'Herkomstmarkt (anders)',
  patientgroep:'Primaire patiëntgroep', patientgroep_anders:'Patiëntgroep (anders)',
  zorggebieden:'Zorggebieden met prioriteit', zorggebieden_anders:'Zorggebieden (anders)',
  talen:'Ondersteunde talen', talen_anders:'Talen (anders)',
  drempels:'Grootste drempels voor patiënten', drempels_anders:'Drempels (anders)',
  concurrenten:'Concurrenten of voorbeeldbedrijven',
  partners_geidentificeerd:'Partners geïdentificeerd', partner_landen:'Landen van partners', partner_landen_anders:'Landen partners (anders)',
  partner_informatie:'Beschikbare partnerinformatie', medische_beoordeling:'Wie voert de medische beoordeling uit',
  kwaliteitscontrole:'Wie controleert kwaliteit en documentatie', lokale_contactpersoon:'Lokale contactpersoon voor spoed',
  partnerafspraken_vastgelegd:'Partnerafspraken schriftelijk vastgelegd',
  lead_kanalen:'Kanalen voor patiëntleads', lead_kanalen_anders:'Kanalen (anders)',
  eerste_intake:'Wie doet de eerste commerciële intake', patientreis:'Gewenste patiëntreis',
  communicatie_eigenaar:'Eigenaar van communicatie', escalatieplan:'24/7 contact- of escalatieplan',
  procesrisicos:'Verwachte procesrisico\u2019s', procesrisicos_anders:'Procesrisico\u2019s (anders)',
  juridische_entiteit:'Juridische entiteit en land', juridisch_advies:'Juridisch advies beschikbaar',
  documenten_aanwezig:'Aanwezige documenten', medische_documenten_aanlevering:'Veilige aanlevering medische documenten',
  toegang_medische_gegevens:'Toegang tot medische gegevens', verantwoordelijkheid_duidelijk:'Verantwoordelijkheid bij complicaties duidelijk',
  compliance_risicos:'Zelf gesignaleerde compliance-risico\u2019s',
  website:'Website', crm:'CRM', whatsapp:'WhatsApp Business', betalingen:'Online betalingen',
  automatiseringen_prioriteit:'Automatiseringen met eerste prioriteit',
  nooit_ai:'Nooit volledig door AI of automatisering', nooit_ai_anders:'Nooit door AI (anders)',
  ai_comfort:'Comfortniveau met AI', huidige_systemen:'Huidige systemen',
  budget:'Budget eerste 12 maanden', team_tijd:'Beschikbare tijd kernteam per week', doelen_90dagen:'Te realiseren binnen 90 dagen',
  verwachting_lbr:'Verwachtingen van Linkd by Royal', zorgen:'Zorgen, blokkades of risico\u2019s',
  risicobereidheid:'Risicobereidheid', contact_naam:'Naam contactpersoon', contact_email:'E-mail contactpersoon'
};
const PRIO_LABELS = {
  prio_partnerverificatie:'Kliniek- en partnerverificatie',
  prio_juridisch:'Juridische structuur en voorwaarden',
  prio_privacy:'Privacy en veilige documentverwerking',
  prio_patientreis:'Patiëntreis en crisisprotocol',
  prio_website:'Website en lead intake',
  prio_crm:'CRM en WhatsApp opvolging',
  prio_marketing:'Marketing en leadgeneratie',
  prio_ai_dashboard:'AI en rapportagedashboard'
};
const KNELPUNT_TITELS = {
  operationeel:'Operationeel', digitaal:'Digitaal', regelgeving:'Regelgeving',
  partnernetwerk:'Partnernetwerk', patientveiligheid:'Patiëntveiligheid'
};
const SCORE_TITELS = [
  ['digitalMaturity','Digital Maturity'],
  ['aiReadiness','AI Readiness'],
  ['risk','Risicoscore'],
  ['medicalOperationalReadiness','Medische operationele gereedheid'],
  ['partnerReadiness','Partnergereedheid'],
  ['privacyComplianceReadiness','Privacy & compliance gereedheid'],
  ['patientSafetyReadiness','Patiëntveiligheid gereedheid']
];

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
    .map(([k,lbl]) => `<tr><td class="lbl">${esc(lbl)}</td><td>Impact ${esc(a[k+'_impact'] ?? '-')} / 5 · Moeite ${esc(a[k+'_effort'] ?? '-')} / 5</td></tr>`).join('');

  const list = arr => `<ul>${(arr||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  const catTitled = (obj, titles) => Object.entries(obj||{})
    .map(([k,v])=>`<h4>${esc((titles&&titles[k])||k)}</h4>${list(v)}`).join('');
  const joinArr = v => Array.isArray(v) ? v.join('; ') : (v||'');

  let analysisHtml;
  if (an) {
    const bi = an.bedrijfsidentiteit || {};
    const gng = an.goNoGoAssessment || {};
    analysisHtml = `
    <h2>Strategische analyse</h2>
    <div class="block"><h3>Managementsamenvatting</h3><p>${esc(an.samenvatting||'')}</p></div>

    <div class="block ident">
      <h3>Bedrijfsidentiteit &amp; Positionering</h3>
      <p><b>Bedrijfsnaam:</b> ${esc(bi.bedrijfsnaam || a.bedrijfsnaam || '')}</p>
      <p><b>Verhaal achter de naam:</b> ${esc(bi.naamverhaal || '')}</p>
      <p><b>Gewenste positionering:</b> ${esc(bi.positionering || '')}</p>
      ${bi.positioneringszin ? `<p class="poszin">"${esc(bi.positioneringszin)}"</p>` : ''}
      ${bi.ontbrekendeInformatie ? `<p><b>Ontbrekende informatie:</b> ${esc(bi.ontbrekendeInformatie)}</p>` : ''}
    </div>

    <div class="scores">
      ${SCORE_TITELS.map(([key,lbl])=>{
        const s=(an.scores||{})[key];
        return `<div class="score"><div class="num">${esc(s?.score ?? '-')}<small>/100</small></div><div>${esc(lbl)}</div><div class="bench">Branche: ${esc(s?.benchmark ?? '-')}${s?.doel12mnd!==undefined?(' · Doel 12 mnd: '+esc(s.doel12mnd)):''}</div></div>`;
      }).join('')}
    </div>
    <div class="block"><h3>Score-interpretatie</h3>
      ${SCORE_TITELS.map(([key,lbl])=>{
        const s=(an.scores||{})[key];
        if(!s||!s.interpretatie) return '';
        return `<p><b>${esc(lbl)}:</b> ${esc(s.interpretatie)}${key==='risk'&&s.mitigatie?('<br><b>Mitigatie:</b> '+esc(s.mitigatie)):''}</p>`;
      }).join('')}
    </div>

    <div class="gonogo">
      <h3>Pilot Go / No-Go beoordeling</h3>
      <div class="status">${esc(gng.status || 'Niet beoordeeld')}</div>
      ${gng.grootsteRisico ? `<p><b>Grootste risico:</b> ${esc(gng.grootsteRisico)}</p>` : ''}
      ${(gng.voorwaarden||[]).length ? `<p><b>Voorwaarden v\u00f3\u00f3r start:</b></p>${list(gng.voorwaarden)}` : ''}
      <p class="uitleg">"Go met voorwaarden" betekent dat de pilot kan starten nadat de benoemde voorwaarden aantoonbaar zijn ingevuld.</p>
    </div>

    <div class="block"><h3>Knelpunten</h3>${catTitled(an.knelpunten, KNELPUNT_TITELS)}</div>
    <div class="block"><h3>Kansen</h3>${catTitled(an.kansen, {groei:'Groei', automatisering:'Automatisering', positionering:'Positionering'})}</div>
    <div class="block"><h3>Quick wins</h3>${(an.quickWins||[]).map(q=>`<p><b>${esc(q.actie)}</b><br>${esc(q.waarom)}<br>Kosten: ${esc(q.kosten)} · Impact: ${esc(q.impact)} · Tijdlijn: ${esc(q.tijdlijn)}</p>`).join('')}</div>
    <div class="block"><h3>Indicatieve kostenraming</h3>
      <table><tr><th>Onderdeel</th><th>Laag</th><th>Gemiddeld</th><th>Hoog</th></tr>
      ${(an.kostenraming||[]).map(c=>`<tr><td>${esc(c.onderdeel)}</td><td>${esc(c.laag)}</td><td>${esc(c.gemiddeld)}</td><td>${esc(c.hoog)}</td></tr>`).join('')}
      ${an.kostenramingTotaal?`<tr class="tot"><td>Totaal</td><td>${esc(an.kostenramingTotaal.laag)}</td><td>${esc(an.kostenramingTotaal.gemiddeld)}</td><td>${esc(an.kostenramingTotaal.hoog)}</td></tr>`:''}</table>
      <p class="muted" style="margin-top:8px;font-size:12px;">Ramingen zijn indicatief en worden na het strategiegesprek verfijnd in de projectplanning.</p></div>
    <div class="block"><h3>Roadmap</h3>${(an.roadmap||[]).map(p=>`<p><b>${esc(p.fase)}</b> (${esc(p.tijdlijn)}, ${esc(p.budget)})<br>${esc(joinArr(p.acties))}<br><i>Resultaten:</i> ${esc(joinArr(p.resultaten))}</p>`).join('')}</div>
    <div class="block"><h3>Gespreksleidraad</h3>${catTitled(an.gespreksleidraad)}</div>`;
  } else {
    analysisHtml = `<h2>Strategische analyse</h2><p class="muted">De analyse wordt gegenereerd of is niet gelukt; ververs deze pagina over een minuut.</p>`;
  }

  res.send(`<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intake-rapport ${esc(a.bedrijfsnaam||'')}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body{margin:0;font-family:'Inter',sans-serif;background:#f8f6f0;color:#1c2430;font-size:13.5px;line-height:1.65;}
    .topbar{background:#0f1b2d;color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;}
    .topbar .brand{font-family:'Playfair Display',serif;font-size:18px;}
    .topbar .brand span{color:#e3cd9a;}
    .topbar .actions a,.topbar .actions button{background:#c6a15b;color:#0f1b2d;border:none;font-family:'Inter',sans-serif;font-weight:700;font-size:12.5px;padding:9px 16px;border-radius:8px;cursor:pointer;text-decoration:none;margin-left:8px;}
    main{max-width:820px;margin:30px auto 60px;padding:0 22px;}
    h1{font-family:'Playfair Display',serif;color:#0f1b2d;font-size:28px;margin:8px 0 2px;}
    h2{font-family:'Playfair Display',serif;color:#0f1b2d;font-size:20px;margin:34px 0 12px;border-bottom:2px solid #c6a15b;padding-bottom:6px;}
    h3{font-size:14px;color:#0f1b2d;margin:0 0 8px;}
    h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7480;margin:12px 0 4px;}
    .meta{color:#6b7480;font-size:12.5px;margin-bottom:6px;}
    .block{margin-bottom:20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;}
    th{background:#0f1b2d;color:#fff;text-align:left;padding:8px 11px;font-size:11.5px;}
    td{padding:8px 11px;border-top:1px solid #e4ddce;vertical-align:top;}
    td.lbl{width:250px;font-weight:600;color:#0f1b2d;background:#fdfbf5;}
    tr.tot td{font-weight:700;color:#0f1b2d;}
    ul{margin:4px 0;padding-left:18px;}
    .scores{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0;}
    .score{flex:1 1 200px;background:#0f1b2d;color:#fff;border-radius:10px;padding:14px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}
    .score .num{font-family:'Playfair Display',serif;font-size:26px;color:#e3cd9a;text-transform:none;}
    .score .num small{font-size:12px;color:#9aa7b8;}
    .score .bench{color:#9aa7b8;margin-top:5px;text-transform:none;letter-spacing:0;}
    .ident{background:#fff;border:1px solid #e4ddce;border-radius:12px;padding:16px 18px;}
    .ident .poszin{font-family:'Playfair Display',serif;font-size:16px;color:#0f1b2d;margin:10px 0;}
    .gonogo{background:#0f1b2d;color:#fff;border-radius:12px;padding:20px 22px;margin-bottom:22px;}
    .gonogo h3{color:#fff;font-size:15px;margin-bottom:10px;}
    .gonogo .status{display:inline-block;background:#c6a15b;color:#0f1b2d;font-weight:700;font-size:14px;padding:8px 18px;border-radius:8px;margin-bottom:12px;}
    .gonogo p{color:#c9d1dc;font-size:13px;margin:6px 0;}
    .gonogo b{color:#fff;}
    .gonogo ul{color:#c9d1dc;font-size:13px;}
    .gonogo .uitleg{font-size:11.5px;color:#8b98a9;margin-top:12px;}
    .muted{color:#6b7480;}
    @media print{.topbar{display:none;}body{background:#fff;}main{margin:0;max-width:100%;}.gonogo{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
  </style></head><body>
  <div class="topbar">
    <div class="brand">Linkd <span>by Royal</span></div>
    <div class="actions">
      <a href="/admin?token=${encodeURIComponent(req.query.token)}">Dashboard</a>
      <button onclick="window.print()">Download als PDF</button>
    </div>
  </div>
  <main>
    <div class="meta">Medical Tourism Venture Discovery Intake · ontvangen ${esc(new Date(r.receivedAt).toLocaleString('nl-NL'))} · taal: ${esc(r.lang||'nl')}</div>
    <h1>${esc(a.bedrijfsnaam || 'Onbekend bedrijf')}</h1>
    <div class="meta">${esc(a.contact_naam || '')} ${a.contact_email?('· '+esc(a.contact_email)):''}</div>
    <h2>Intake-antwoorden</h2>
    <table>${answerRows || '<tr><td>Geen antwoorden</td></tr>'}</table>
    ${prioRows ? `<h2>Prioriteitsmatrix</h2><table>${prioRows}</table>` : ''}
    ${analysisHtml}
  </main></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Linkd by Royal medical intake-backend draait op poort ${PORT}`));
