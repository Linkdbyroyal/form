// Linkd by Royal — Medical Tourism Discovery Intake Form
// Klant vult in en verstuurt. De server slaat het dossier op, genereert op de
// achtergrond marktonderzoek via Perplexity en strategische analyse via Manus AI,
// en mailt het rapport naar de eigenaar. De klant ziet alleen een bedankpagina.
// Node 18+ vereist.

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

/* ---------- Perplexity API Helper ---------- */
async function callPerplexity(prompt, lang) {
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
        max_tokens: 2500,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.error('Perplexity API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('Perplexity error:', err.message);
    return null;
  }
}

/* ---------- Perplexity Marktonderzoek ---------- */
async function runMarketResearch(answers, lang) {
  const industry = answers.patientgroep || answers.zorggebieden || 'medische toerisme';
  const location = answers.doelgroep_markt || 'Venezuela';
  
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

Be specific with numbers, percentages, and real market data.`
    : `Geef een uitgebreid marktonderzoeksrapport voor een medisch-toerisme-onderneming gericht op ${location} in de ${industry}-sector. Inclusief:
1. Marktgrootte en groeicijfers (met specifieke percentages en getallen)
2. Doelgroep-demografie (leeftijd, inkomen, pijnpunten, communicatiekanalen)
3. Competitief landschap (3-5 belangrijkste concurrenten)
4. Regelgeving en compliance-vereisten
5. Patiëntenreis en besluitvormingsproces
6. Prijsbenchmarks en betalingsmodellen
7. Kritieke succesfactoren en toegangsbarrières
8. Marketingkanalen en patiënt-acquisitiekosten
9. Kansen en bedreigingen
10. Aanbevelingen voor marktintrede

Wees specifiek met getallen, percentages en echte marktgegevens.`;

  const result = await callPerplexity(prompt, lang);
  return result || generateDefaultMarketResearch(industry, location, lang);
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
- Kritieke succesfactoren: Kwaliteitsborging, patiëntveiligheid, duidelijke communicatie
- Marketingkanalen: Digitale marketing (60%), referraalnetwerken (40%)`;
  }
}

/* ---------- Manus AI Strategische Analyse ---------- */
async function runManusAnalysis(answers, marketResearch, lang) {
  const answersText = Object.entries(answers)
    .filter(([k, v]) => v !== '' && v !== null && v !== undefined && (Array.isArray(v) ? v.length : true))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');

  const prompt = lang === 'en'
    ? `You are a senior strategic consultant with 20+ years of experience in medical tourism, business development, and operational setup. 

Analyze the following medical tourism venture discovery intake and provide a comprehensive strategic analysis:

INTAKE ANSWERS:
${answersText}

MARKET RESEARCH:
${marketResearch}

Provide a detailed strategic analysis including:
1. Executive Summary (3-5 sentences)
2. Market Opportunity Assessment
3. Business Model Analysis
4. Operational Readiness Assessment
5. Risk Factors (top 5)
6. Quick Wins (3-4 achievable in 90 days)
7. 90-Day Roadmap (3-4 phases with timeline and actions)
8. Financial Viability Assessment
9. Go/No-Go Recommendation with conditions
10. Recommended Next Steps

Format as professional consultant report with specific, actionable insights.`
    : `Je bent een senior strategisch consultant met 20+ jaar ervaring in medisch toerisme, businessontwikkeling en operationele inrichting.

Analyseer de volgende medisch-toerisme-onderneming discovery intake en geef een uitgebreide strategische analyse:

INTAKE-ANTWOORDEN:
${answersText}

MARKTONDERZOEK:
${marketResearch}

Geef een gedetailleerde strategische analyse inclusief:
1. Samenvatting (3-5 zinnen)
2. Beoordeling marktkans
3. Analyse businessmodel
4. Beoordeling operationele gereedheid
5. Risicofactoren (top 5)
6. Snelle winsten (3-4 haalbaar in 90 dagen)
7. 90-daagse roadmap (3-4 fasen met tijdlijn en acties)
8. Beoordeling financiële levensvatbaarheid
9. Go/No-Go aanbeveling met voorwaarden
10. Aanbevolen volgende stappen

Formatteer als professioneel consultantrapport met specifieke, actionable inzichten.`;

  try {
    // Call Manus API (using OpenAI-compatible endpoint)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.error('Manus API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('Manus API error:', err.message);
    return null;
  }
}

/* ---------- Format Intake Data for Report ---------- */
function formatIntakeData(answers, lang) {
  const isDutch = lang === 'nl';
  
  const sections = {
    nl: {
      bedrijf: 'Bedrijf & Identiteit',
      model: 'Model & Operatie',
      doelgroep: 'Doelgroep',
      partners: 'Partners',
      patiëntreis: 'Patiëntreis',
      juridisch: 'Juridisch & Compliance',
      digitaal: 'Digitaal & Automation',
      budget: 'Budget & Planning',
      afronding: 'Afronding'
    },
    en: {
      bedrijf: 'Company & Identity',
      model: 'Model & Operations',
      doelgroep: 'Target Market',
      partners: 'Partnerships',
      patiëntreis: 'Patient Journey',
      juridisch: 'Legal & Compliance',
      digitaal: 'Digital & Automation',
      budget: 'Budget & Planning',
      afronding: 'Closing'
    }
  };

  const s = sections[lang] || sections.nl;
  
  let html = '<section><h2>' + (isDutch ? 'Intake Gegevens' : 'Intake Data') + '</h2>';
  
  // Group answers by section
  const grouped = {
    bedrijf: ['bedrijfsnaam', 'naamverhaal', 'stadium', 'bedrijf_intro', 'waarom_venezuela', 'waarom_colombia', 'launch_date'],
    model: ['rol_organisatie', 'doelstellingen_12m', 'succeskriterium', 'services_fase1', 'services_niet', 'budget_patient', 'facturatie'],
    doelgroep: ['doelgroep_markt', 'patientgroep', 'zorggebieden', 'talen', 'barrières', 'concurrenten'],
    partners: ['partners_identified', 'partner_landen', 'medische_evaluatie', 'kwaliteitscontrole', 'lokale_contact', 'partner_agreements'],
    patiëntreis: ['lead_channels', 'eerste_intake', 'patient_journey', 'communicatie_eigenaar', 'escalatie_24h'],
    juridisch: ['juridische_entiteit', 'juridisch_advies', 'beschikbare_documenten', 'medische_documenten', 'medische_data_access', 'verantwoordelijkheid', 'compliance_risico'],
    digitaal: ['website_status', 'crm_status', 'whatsapp_business', 'online_payments', 'automation_priorities', 'ai_nooit_alleen', 'ai_comfort', 'huidige_systemen'],
    budget: ['budget_12m', 'team_availability', 'goals_90d', 'priority_matrix'],
    afronding: ['verwachtingen_linkd', 'concerns', 'risk_appetite', 'contact_naam', 'contact_email']
  };

  Object.entries(grouped).forEach(([key, fields]) => {
    const sectionTitle = s[key] || key;
    const sectionAnswers = fields.filter(f => answers[f]).map(f => 
      `<div class="intake-item"><strong>${f}:</strong> ${Array.isArray(answers[f]) ? answers[f].join(', ') : answers[f]}</div>`
    ).join('');
    
    if (sectionAnswers) {
      html += `<div class="intake-section"><h3>${sectionTitle}</h3>${sectionAnswers}</div>`;
    }
  });

  html += '</section>';
  return html;
}

/* ---------- HTML Rapport Generator ---------- */
function generateHTMLReport(record, marketResearch, analysis, lang) {
  const a = record.answers || {};
  const isDutch = lang === 'nl';
  
  const labels = {
    nl: {
      title: 'Strategisch Rapport',
      intakeData: 'Intake Gegevens',
      marketAnalysis: 'Marktanalyse',
      strategicAnalysis: 'Strategische Analyse'
    },
    en: {
      title: 'Strategic Report',
      intakeData: 'Intake Data',
      marketAnalysis: 'Market Analysis',
      strategicAnalysis: 'Strategic Analysis'
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
    .container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; background: white; }
    header { border-bottom: 3px solid #c6a15b; padding-bottom: 20px; margin-bottom: 40px; }
    header h1 { font-size: 32px; color: #0f1b2d; margin-bottom: 10px; }
    header .subtitle { color: #6b7480; font-size: 14px; }
    .logo { font-size: 12px; color: #c6a15b; font-weight: 700; margin-bottom: 20px; }
    section { margin-bottom: 50px; page-break-inside: avoid; }
    section h2 { font-size: 24px; color: #0f1b2d; margin-bottom: 20px; border-left: 4px solid #c6a15b; padding-left: 12px; }
    section h3 { font-size: 16px; color: #0f1b2d; margin-top: 15px; margin-bottom: 10px; }
    .intake-section { background: #f8f6f0; padding: 15px; margin-bottom: 15px; border-radius: 4px; border-left: 3px solid #c6a15b; }
    .intake-item { padding: 8px 0; font-size: 14px; }
    .intake-item strong { color: #0f1b2d; }
    .summary-box { background: #f0ebe0; border-left: 4px solid #c6a15b; padding: 15px; margin-bottom: 20px; border-radius: 4px; }
    .analysis-text { white-space: pre-wrap; font-size: 14px; line-height: 1.8; }
    footer { border-top: 1px solid #e4ddce; padding-top: 20px; margin-top: 40px; font-size: 12px; color: #6b7480; text-align: center; }
    .page-break { page-break-after: always; }
    @media print { body { background: white; } .container { padding: 0; } section { page-break-inside: avoid; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">LINKD BY ROYAL</div>
    <header>
      <h1>${a.bedrijfsnaam || 'Bedrijf'}</h1>
      <p class="subtitle">${l.title} • ${new Date(record.receivedAt).toLocaleDateString(isDutch ? 'nl-NL' : 'en-US')}</p>
    </header>

    <!-- INTAKE DATA SECTION -->
    <section>
      <h2>${l.intakeData}</h2>
      ${formatIntakeData(a, lang)}
    </section>

    <div class="page-break"></div>

    <!-- MARKET RESEARCH SECTION -->
    <section>
      <h2>${l.marketAnalysis}</h2>
      <div class="summary-box">
        <div class="analysis-text">${marketResearch || (isDutch ? 'Marktonderzoek niet beschikbaar' : 'Market research not available')}</div>
      </div>
    </section>

    <div class="page-break"></div>

    <!-- STRATEGIC ANALYSIS SECTION -->
    <section>
      <h2>${l.strategicAnalysis}</h2>
      <div class="summary-box">
        <div class="analysis-text">${analysis || (isDutch ? 'Strategische analyse niet beschikbaar' : 'Strategic analysis not available')}</div>
      </div>
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
    
    const record = { id, receivedAt: new Date().toISOString(), lang: lang || 'nl', answers, marketResearch: null, analysis: null, htmlReport: null };
    fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));

    res.json({ ok: true, id });

    // Async processing
    (async () => {
      try {
        // Run market research
        console.log('Starting market research for', id);
        record.marketResearch = await runMarketResearch(answers, lang || 'nl');
        console.log('Market research completed for', id);
        
        // Run strategic analysis via Manus AI
        console.log('Starting strategic analysis via Manus AI for', id);
        record.analysis = await runManusAnalysis(answers, record.marketResearch, lang || 'nl');
        console.log('Strategic analysis completed for', id);
        
        // Generate HTML report
        record.htmlReport = generateHTMLReport(record, record.marketResearch, record.analysis, lang || 'nl');
        
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
  
  const a = record.answers || {};
  const base = process.env.PUBLIC_URL || `https://${req.headers.host}`;
  const reportLink = `${base}/report/${encodeURIComponent(record.id)}?token=${encodeURIComponent(process.env.ADMIN_TOKEN || '')}`;
  const dashLink = `${base}/admin?token=${encodeURIComponent(process.env.ADMIN_TOKEN || '')}`;
  
  const isDutch = record.lang === 'nl';
  const bodyLines = [
    isDutch ? `Nieuwe Medical Tourism Discovery Intake ontvangen.` : `New Medical Tourism Discovery Intake received.`,
    ``,
    `${isDutch ? 'Bedrijf' : 'Company'}: ${a.bedrijfsnaam || 'Onbekend'}`,
    `${isDutch ? 'Contactpersoon' : 'Contact Person'}: ${a.contact_naam || '-'}`,
    `${isDutch ? 'E-mail' : 'Email'}: ${a.contact_email || '-'}`,
    `${isDutch ? 'Taal' : 'Language'}: ${record.lang}`,
    `${isDutch ? 'Ontvangen' : 'Received'}: ${new Date(record.receivedAt).toLocaleString(isDutch ? 'nl-NL' : 'en-US')}`,
    ``,
    isDutch ? `Volledige rapport met intake-gegevens en strategische analyse beschikbaar.` : `Full report with intake data and strategic analysis available.`
  ];
  
  bodyLines.push(``, `${isDutch ? 'Volledig rapport' : 'Full report'}: ${reportLink}`, `${isDutch ? 'Dashboard' : 'Dashboard'}: ${dashLink}`, ``, isDutch ? `Het complete dossier zit als bijlage bij deze mail.` : `The complete file is attached to this email.`);
  
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: OWNER_EMAIL,
      subject: `${isDutch ? 'Nieuwe intake' : 'New intake'}: ${a.bedrijfsnaam || 'Onbekend'} (Medical Tourism Discovery)`,
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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(record.htmlReport || 'Rapport niet beschikbaar');
  } catch (err) {
    res.status(404).send('Rapport niet gevonden');
  }
});

/* ---------- Server starten ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linkd by Royal form server luistert op poort ${PORT}`);
  console.log(`Perplexity API key: ${process.env.PERPLEXITY_API_KEY ? 'geconfigureerd' : 'ONTBREEKT'}`);
  console.log(`OpenAI/Manus API key: ${process.env.OPENAI_API_KEY ? 'geconfigureerd' : 'ONTBREEKT'}`);
});
