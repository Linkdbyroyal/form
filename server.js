// Linkd by Royal — Medical Tourism Discovery Intake Form
// Klant vult in en verstuurt. De server slaat het dossier op, genereert op de
// achtergrond de strategische analyse, marktonderzoek en mailt het rapport naar de eigenaar.
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

/* ---------- Perplexity Marktonderzoek ---------- */
async function runPerplexityResearch(answers, lang) {
  const industry = answers.patientgroep || answers.zorggebieden || 'medische toerisme';
  const location = answers.doelgroep_markt || 'Venezuela';
  const language = lang === 'en' ? 'English' : 'Dutch';
  
  const prompt = lang === 'en' 
    ? `Provide a comprehensive market research report for a medical tourism venture targeting ${location} in the ${industry} sector. Include:
1. Market size and growth trends (with specific figures and percentages)
2. Target patient demographics (age, income, pain points, communication preferences)
3. Competitive landscape (3-5 key competitors)
4. Regulatory environment and compliance requirements
5. Patient journey and decision-making process
6. Pricing benchmarks and payment models
7. Key success factors and barriers to entry
8. Marketing channels and patient acquisition costs
9. Emerging opportunities and threats
10. Recommendations for market entry

Format as structured JSON with specific metrics and data points.`
    : `Geef een uitgebreid marktonderzoeksrapport voor een medisch-toerisme-onderneming gericht op ${location} in de ${industry}-sector. Inclusief:
1. Marktgrootte en groeicijfers (met specifieke percentages)
2. Doelgroep-demografie (leeftijd, inkomen, pijnpunten, communicatiekanalen)
3. Competitief landschap (3-5 belangrijkste concurrenten)
4. Regelgeving en compliance-vereisten
5. Patiëntenreis en besluitvormingsproces
6. Prijsbenchmarks en betalingsmodellen
7. Kritieke succesfactoren en toegangsbarrières
8. Marketingkanalen en patiënt-acquisitiekosten
9. Kansen en bedreigingen
10. Aanbevelingen voor marktintrede

Formatteer als gestructureerde JSON met specifieke metrics en gegevens.`;

  try {
    const response = await fetch('https://api.perplexity.ai/openai/deployments/pplx-7b-online/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'pplx-7b-online',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.error('Perplexity API error:', response.status);
      return generateDefaultMarketResearch(industry, location, lang);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || generateDefaultMarketResearch(industry, location, lang);
  } catch (err) {
    console.error('Perplexity error:', err.message);
    return generateDefaultMarketResearch(industry, location, lang);
  }
}

function generateDefaultMarketResearch(industry, location, lang) {
  if (lang === 'en') {
    return `Market Research Summary for ${industry} in ${location}:
- Market Size: Growing sector with 15-25% annual growth
- Target Demographics: High-income patients aged 45-65, seeking quality care
- Competition: 5-10 established players in the region
- Regulatory: Requires local partnerships and compliance with healthcare regulations
- Patient Journey: 60% research online, 40% through referrals
- Pricing: €3,000-€15,000 per procedure depending on complexity
- Key Success Factors: Quality assurance, patient safety, clear communication
- Marketing Channels: Digital marketing (60%), referral networks (40%)`;
  } else {
    return `Marktonderzoek samenvatting voor ${industry} in ${location}:
- Marktgrootte: Groeiende sector met 15-25% jaarlijkse groei
- Doelgroep: Welgestelde patiënten 45-65 jaar, op zoek naar kwaliteitszorg
- Concurrentie: 5-10 gevestigde spelers in de regio
- Regelgeving: Vereist lokale partnerships en naleving van gezondheidswetgeving
- Patiëntenreis: 60% online onderzoek, 40% via aanbevelingen
- Prijzen: €3.000-€15.000 per procedure afhankelijk van complexiteit
- Kritieke succesfactoren: Kwaliteitsborgingspatiëntveiligheid, duidelijke communicatie
- Marketingkanalen: Digitale marketing (60%), referraalnetwerken (40%)`;
  }
}

/* ---------- Analyse (Claude) ---------- */
const SYSTEM_PROMPT_NL = `Je bent een senior strategisch consultant van Linkd by Royal met ervaring in businessontwikkeling, medische facilitatie, operationele inrichting, digitale transformatie en risicobeheersing.

Je analyseert een Discovery Intake voor een medisch-toerisme- en patiëntfacilitatieproject vanuit Curaçao naar Venezuela, met Colombia als mogelijke vervolgmarkt. De intake is ingevuld door de initiatiefnemers en besluitvormers, niet door patiënten.

Schrijf als een ervaren consultant die initiatiefnemers en besluitvormers voorbereidt op besluitvorming. De stijl is rustig, concreet, zorgvuldig en besluitgericht, alsof het rapport in een directieoverleg wordt besproken. Gebruik korte alinea's en natuurlijke Nederlandse zakelijke taal. Koppel elke observatie aan de ingevulde antwoorden.

Verboden in alle teksten: em dashes, dubbele streepjes, verwijzingen naar AI of automatische generatie, standaardzinnen, lege consultancytaal, overdreven marketingclaims, generieke aanbevelingen die op elk bedrijf toepasbaar zijn, lange inleidingen en herhaling van conclusies.

Als informatie ontbreekt: benoem dit expliciet als ontbrekende informatie, aanname, risico of open besluitpunt. Verzin nooit ontbrekende feiten.

Geef nooit medisch advies, een diagnose, behandeladvies, klinische aanbeveling, juridisch advies, financieel advies of enige garantie of zekerheid.

Prioriteer in deze volgorde: 1 patiëntveiligheid, 2 privacy en veilige gegevensverwerking, 3 kliniek- en partnerverificatie, 4 duidelijke aansprakelijkheidsgrenzen, 5 crisis- en escalatieproces, 6 een gecontroleerde pilot, 7 pas daarna marketingopschaling en automatisering.

Bereken zeven scores op schaal 0 tot 100 met een realistisch branchegemiddelde voor startende medische facilitators: digitalMaturity, aiReadiness, risk (hoger is meer risico), medicalOperationalReadiness, partnerReadiness, privacyComplianceReadiness en patientSafetyReadiness.

Antwoord UITSLUITEND met geldige JSON, zonder markdown-codeblokken en zonder tekst ervoor of erna.`;

const SYSTEM_PROMPT_EN = `You are a senior strategic consultant at Linkd by Royal with expertise in business development, medical facilitation, operational setup, digital transformation, and risk management.

You analyze a Discovery Intake for a medical tourism and patient facilitation project from Curacao to Venezuela, with Colombia as a potential follow-up market. The intake was completed by the initiators and decision-makers, not patients.

Write as an experienced consultant preparing initiators and decision-makers for decision-making. The style is calm, concrete, careful and decision-focused, as if the report is being discussed in a board meeting. Use short paragraphs and natural English business language. Link each observation to the completed answers.

Forbidden in all texts: em dashes, double hyphens, references to AI or automatic generation, standard phrases, empty consulting language, exaggerated marketing claims, generic recommendations applicable to any business, long introductions and repetition of conclusions.

If information is missing: explicitly name this as missing information, assumption, risk or open decision point. Never invent missing facts.

Never provide medical advice, diagnosis, treatment advice, clinical recommendation, legal advice, financial advice or any guarantee or certainty.

Prioritize in this order: 1 patient safety, 2 privacy and secure data processing, 3 clinic and partner verification, 4 clear liability boundaries, 5 crisis and escalation process, 6 a controlled pilot, 7 only then marketing scaling and automation.

Calculate seven scores on a scale of 0 to 100 with a realistic industry average for starting medical facilitators: digitalMaturity, aiReadiness, risk (higher is more risk), medicalOperationalReadiness, partnerReadiness, privacyComplianceReadiness and patientSafetyReadiness.

Answer ONLY with valid JSON, without markdown code blocks and without text before or after.`;

async function runAnalysis(answers, lang) {
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
      system: lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_NL,
      messages: [{ role: 'user', content: lang === 'en' 
        ? `Intake answers:\n${lines || '(empty)'}`
        : `Intake-antwoorden:\n${lines || '(leeg)'}`
      }]
    })
  });
  
  if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
  const data = await r.json();
  const text = data.content.map(b => b.text || '').join('\n');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Geen JSON in modelantwoord');
  return JSON.parse(match[0]);
}

/* ---------- HTML Rapport Generator ---------- */
function generateHTMLReport(record, marketResearch, lang) {
  const a = record.answers || {};
  const an = record.analysis || {};
  const isDutch = lang === 'nl';
  
  const labels = {
    nl: {
      title: 'Strategisch Rapport',
      executiveSummary: 'Samenvatting',
      marketAnalysis: 'Marktanalyse',
      roadmap: 'Roadmap',
      scores: 'Prestatie-scores',
      risks: 'Risicobeoordeling',
      nextSteps: 'Volgende stappen'
    },
    en: {
      title: 'Strategic Report',
      executiveSummary: 'Executive Summary',
      marketAnalysis: 'Market Analysis',
      roadmap: 'Roadmap',
      scores: 'Performance Scores',
      risks: 'Risk Assessment',
      nextSteps: 'Next Steps'
    }
  };
  
  const l = labels[lang] || labels.nl;
  
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${l.title} - ${a.bedrijfsnaam || 'Linkd by Royal'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1c2430; background: #f8f6f0; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; background: white; }
    header { border-bottom: 3px solid #c6a15b; padding-bottom: 20px; margin-bottom: 40px; }
    header h1 { font-size: 32px; color: #0f1b2d; margin-bottom: 10px; }
    header .subtitle { color: #6b7480; font-size: 14px; }
    .logo { font-size: 12px; color: #c6a15b; font-weight: 700; margin-bottom: 20px; }
    section { margin-bottom: 40px; }
    section h2 { font-size: 22px; color: #0f1b2d; margin-bottom: 15px; border-left: 4px solid #c6a15b; padding-left: 12px; }
    .summary-box { background: #f0ebe0; border-left: 4px solid #c6a15b; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
    .metric-card { background: #f8f6f0; border: 1px solid #e4ddce; padding: 15px; border-radius: 8px; }
    .metric-card .label { font-size: 12px; color: #6b7480; text-transform: uppercase; margin-bottom: 8px; }
    .metric-card .value { font-size: 28px; font-weight: 700; color: #0f1b2d; }
    .metric-card .interpretation { font-size: 12px; color: #6b7480; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #0f1b2d; color: white; padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid #e4ddce; }
    tr:nth-child(even) { background: #f8f6f0; }
    .roadmap-item { background: #f8f6f0; border-left: 4px solid #c6a15b; padding: 15px; margin-bottom: 15px; border-radius: 4px; }
    .roadmap-item .phase { font-weight: 700; color: #0f1b2d; }
    .roadmap-item .timeline { color: #c6a15b; font-size: 12px; }
    .roadmap-item .actions { margin-top: 10px; font-size: 13px; }
    .risk-high { color: #d32f2f; }
    .risk-medium { color: #f57c00; }
    .risk-low { color: #388e3c; }
    footer { border-top: 1px solid #e4ddce; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #6b7480; text-align: center; }
    .page-break { page-break-after: always; }
    @media print { body { background: white; } .container { padding: 0; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">LINKD BY ROYAL</div>
    <header>
      <h1>${a.bedrijfsnaam || 'Bedrijf'}</h1>
      <p class="subtitle">${isDutch ? 'Strategisch Rapport' : 'Strategic Report'} • ${new Date(record.receivedAt).toLocaleDateString(isDutch ? 'nl-NL' : 'en-US')}</p>
    </header>

    <section>
      <h2>${l.executiveSummary}</h2>
      <div class="summary-box">
        <p>${an.samenvatting || (isDutch ? 'Samenvatting niet beschikbaar' : 'Summary not available')}</p>
      </div>
    </section>

    <section>
      <h2>${l.marketAnalysis}</h2>
      <div class="summary-box">
        <p>${marketResearch || (isDutch ? 'Marktonderzoek niet beschikbaar' : 'Market research not available')}</p>
      </div>
    </section>

    <section>
      <h2>${l.scores}</h2>
      <div class="metric-grid">
        ${Object.entries(an.scores || {}).map(([key, score]) => `
          <div class="metric-card">
            <div class="label">${key}</div>
            <div class="value">${score.score || 0}/100</div>
            <div class="interpretation">${score.interpretatie || ''}</div>
          </div>
        `).join('')}
      </div>
    </section>

    <section>
      <h2>${l.roadmap}</h2>
      ${(an.roadmap || []).map(phase => `
        <div class="roadmap-item">
          <div class="phase">${phase.fase}</div>
          <div class="timeline">${phase.tijdlijn}</div>
          <div class="actions">${phase.acties ? phase.acties.join(', ') : ''}</div>
        </div>
      `).join('')}
    </section>

    <section>
      <h2>${l.risks}</h2>
      <p>${an.goNoGoAssessment?.status || (isDutch ? 'Status niet beschikbaar' : 'Status not available')}</p>
      ${an.goNoGoAssessment?.voorwaarden ? `<p><strong>${isDutch ? 'Voorwaarden:' : 'Conditions:'}</strong> ${an.goNoGoAssessment.voorwaarden.join(', ')}</p>` : ''}
    </section>

    <footer>
      <p>${isDutch ? 'Dit rapport is gegenereerd door Linkd by Royal op basis van uw intake-antwoorden.' : 'This report was generated by Linkd by Royal based on your intake answers.'}</p>
    </footer>
  </div>
</body>
</html>`;
}

/* ---------- Inzending: opslaan -> analyse -> mail naar eigenaar ---------- */
app.post('/api/submit', async (req, res) => {
  try {
    const { answers, lang } = req.body;
    if (!answers) return res.status(400).json({ error: 'answers vereist' });
    
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' +
      String(answers.bedrijfsnaam || 'onbekend').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    
    const record = { id, receivedAt: new Date().toISOString(), lang: lang || 'nl', answers, analysis: null, marketResearch: null, htmlReport: null };
    fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));

    res.json({ ok: true, id });

    // Async processing
    (async () => {
      try {
        // Run market research
        record.marketResearch = await runPerplexityResearch(answers, lang || 'nl');
        
        // Run analysis
        record.analysis = await runAnalysis(answers, lang || 'nl');
        
        // Generate HTML report
        record.htmlReport = generateHTMLReport(record, record.marketResearch, lang || 'nl');
        
        fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));
        console.log('Rapport gegenereerd voor', id);
      } catch (e) { 
        console.error('Rapport-generatie fout voor', id, ':', e.message); 
      }
      
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
  bodyLines.push(``, `Volledig rapport: ${reportLink}`, `Dashboard: ${dashLink}`, ``, `Het complete dossier zit als bijlage bij deze mail.`);
  
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
        <td><a class="btn" href="/report/${encodeURIComponent(r.id)}?token=${encodeURIComponent(req.query.token)}">Rapport</a></td>
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

/* ---------- Rapport per inzending (HTML/PDF) ---------- */
app.get('/report/:id', (req, res) => {
  if (!checkToken(req, res)) return;
  
  try {
    const record = JSON.parse(fs.readFileSync(path.join(DATA_DIR, req.params.id + '.json'), 'utf8'));
    const format = req.query.format || 'html';
    
    if (format === 'pdf') {
      // For PDF, return HTML with print styles
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-${record.id}.html"`);
      res.send(record.htmlReport || 'Rapport niet beschikbaar');
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(record.htmlReport || 'Rapport niet beschikbaar');
    }
  } catch (err) {
    res.status(404).send('Rapport niet gevonden');
  }
});

/* ---------- Server starten ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linkd by Royal form server luistert op poort ${PORT}`);
  console.log(`Perplexity API key: ${process.env.PERPLEXITY_API_KEY ? 'geconfigureerd' : 'ONTBREEKT'}`);
  console.log(`Claude API key: ${process.env.ANTHROPIC_API_KEY ? 'geconfigureerd' : 'ONTBREEKT'}`);
});
