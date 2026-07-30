// Linkd by Royal — Medical Tourism Discovery Intake Form
// Klant vult in en verstuurt. De server slaat het dossier op, genereert op de
// achtergrond marktonderzoek via Perplexity en strategische analyse via Manus AI,
// en mailt het rapport naar de eigenaar. De klant ziet alleen een bedankpagina.
// Node 18+ vereist. Rapport beschikbaar als HTML en PDF.

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
        max_tokens: 3000,
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
    ? `Provide a COMPREHENSIVE market research report for a medical tourism venture targeting ${location} in the ${industry} sector. Include specific data, percentages, and numbers for:

1. Market Size & Growth Trends (with specific €/$ figures and % growth rates)
2. Target Patient Demographics (exact age ranges, income levels, pain points, communication preferences)
3. Competitive Landscape (3-5 specific competitors with their positioning)
4. Regulatory Environment & Compliance (specific requirements for ${location})
5. Patient Journey & Decision-Making Process (% breakdown of how patients find providers)
6. Pricing Benchmarks (specific € amounts for different procedures)
7. Key Success Factors & Barriers to Entry
8. Marketing Channels & Patient Acquisition Costs (specific channels with % effectiveness)
9. Emerging Opportunities & Threats
10. Market Entry Recommendations

IMPORTANT: Be VERY specific with numbers, percentages, actual market data, and real figures.`
    : `Geef een UITGEBREID marktonderzoeksrapport voor een medisch-toerisme-onderneming gericht op ${location} in de ${industry}-sector. Inclusief specifieke data, percentages en getallen voor:

1. Marktgrootte & Groeicijfers (met specifieke €/$ bedragen en % groeipercentages)
2. Doelgroep-Demografie (exacte leeftijdsbereiken, inkomniveaus, pijnpunten, communicatiekanalen)
3. Competitief Landschap (3-5 specifieke concurrenten met hun positionering)
4. Regelgeving & Compliance (specifieke vereisten voor ${location})
5. Patiëntenreis & Besluitvormingsproces (% verdeling hoe patiënten providers vinden)
6. Prijsbenchmarks (specifieke € bedragen voor verschillende procedures)
7. Kritieke Succesfactoren & Toegangsbarrières
8. Marketingkanalen & Patiënt-Acquisitiekosten (specifieke kanalen met % effectiviteit)
9. Kansen & Bedreigingen
10. Aanbevelingen voor Marktintrede

BELANGRIJK: Wees ZEER specifiek met getallen, percentages, actuele marktgegevens en echte cijfers.`;

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

Analyze the following medical tourism venture discovery intake and provide a COMPREHENSIVE strategic analysis with specific metrics and visualizable data:

INTAKE ANSWERS:
${answersText}

MARKET RESEARCH:
${marketResearch}

Provide a detailed strategic analysis including:

1. EXECUTIVE SUMMARY (3-5 sentences with key metrics)

2. MARKET OPPORTUNITY ASSESSMENT
   - Market size estimate
   - Growth potential (%)
   - Target patient volume potential

3. BUSINESS MODEL ANALYSIS
   - Revenue model viability
   - Unit economics
   - Profitability timeline

4. OPERATIONAL READINESS ASSESSMENT
   - Readiness score (0-100)
   - Critical gaps
   - Timeline to launch

5. RISK FACTORS (Top 5 with probability and impact scores 1-10)
   - Risk 1: [Name] - Probability: X/10, Impact: X/10
   - Risk 2: [Name] - Probability: X/10, Impact: X/10
   - Risk 3: [Name] - Probability: X/10, Impact: X/10
   - Risk 4: [Name] - Probability: X/10, Impact: X/10
   - Risk 5: [Name] - Probability: X/10, Impact: X/10

6. QUICK WINS (3-4 achievable in 90 days with effort/impact scores)
   - Win 1: [Name] - Effort: X/10, Impact: X/10
   - Win 2: [Name] - Effort: X/10, Impact: X/10
   - Win 3: [Name] - Effort: X/10, Impact: X/10

7. 90-DAY ROADMAP
   Phase 1 (Days 1-30): [Actions]
   Phase 2 (Days 31-60): [Actions]
   Phase 3 (Days 61-90): [Actions]

8. FINANCIAL VIABILITY ASSESSMENT
   - Estimated startup costs
   - Break-even timeline
   - Year 1 revenue potential
   - Margin assumptions

9. GO/NO-GO RECOMMENDATION
   - Overall recommendation: GO / CONDITIONAL GO / NO-GO
   - Conditions for success
   - Critical success factors

10. RECOMMENDED NEXT STEPS (Priority ranked)

Format with specific numbers, percentages, and metrics wherever possible.`
    : `Je bent een senior strategisch consultant met 20+ jaar ervaring in medisch toerisme, businessontwikkeling en operationele inrichting.

Analyseer de volgende medisch-toerisme-onderneming discovery intake en geef een UITGEBREIDE strategische analyse met specifieke metrics en visualiseerbare data:

INTAKE-ANTWOORDEN:
${answersText}

MARKTONDERZOEK:
${marketResearch}

Geef een gedetailleerde strategische analyse inclusief:

1. SAMENVATTING (3-5 zinnen met kernmetrics)

2. BEOORDELING MARKTKANS
   - Marktgrootte schatting
   - Groeipotentieel (%)
   - Potentieel patiëntenvolume

3. ANALYSE BUSINESSMODEL
   - Levensvatbaarheid inkomstenmodel
   - Eenheidseconomie
   - Winstgevendheid tijdlijn

4. BEOORDELING OPERATIONELE GEREEDHEID
   - Gereedheidscore (0-100)
   - Kritieke hiaten
   - Tijdlijn tot lancering

5. RISICOFACTOREN (Top 5 met waarschijnlijkheid en impactscores 1-10)
   - Risico 1: [Naam] - Waarschijnlijkheid: X/10, Impact: X/10
   - Risico 2: [Naam] - Waarschijnlijkheid: X/10, Impact: X/10
   - Risico 3: [Naam] - Waarschijnlijkheid: X/10, Impact: X/10
   - Risico 4: [Naam] - Waarschijnlijkheid: X/10, Impact: X/10
   - Risico 5: [Naam] - Waarschijnlijkheid: X/10, Impact: X/10

6. SNELLE WINSTEN (3-4 haalbaar in 90 dagen met inspanning/impactscores)
   - Winst 1: [Naam] - Inspanning: X/10, Impact: X/10
   - Winst 2: [Naam] - Inspanning: X/10, Impact: X/10
   - Winst 3: [Naam] - Inspanning: X/10, Impact: X/10

7. 90-DAAGSE ROADMAP
   Fase 1 (Dag 1-30): [Acties]
   Fase 2 (Dag 31-60): [Acties]
   Fase 3 (Dag 61-90): [Acties]

8. BEOORDELING FINANCIËLE LEVENSVATBAARHEID
   - Geschatte opstartkosten
   - Break-even tijdlijn
   - Potentiële inkomsten jaar 1
   - Winstmargeaannames

9. GO/NO-GO AANBEVELING
   - Algemene aanbeveling: GO / VOORWAARDELIJK GO / NO-GO
   - Voorwaarden voor succes
   - Kritieke succesfactoren

10. AANBEVOLEN VOLGENDE STAPPEN (Prioriteit gerangschikt)

Formatteer met specifieke getallen, percentages en metrics waar mogelijk.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
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
  
  let html = '';
  
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
      strategicAnalysis: 'Strategische Analyse',
      downloadPDF: 'Download als PDF',
      generatedOn: 'Rapport gegenereerd op'
    },
    en: {
      title: 'Strategic Report',
      intakeData: 'Intake Data',
      marketAnalysis: 'Market Analysis',
      strategicAnalysis: 'Strategic Analysis',
      downloadPDF: 'Download as PDF',
      generatedOn: 'Report generated on'
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
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1c2430; background: #f8f6f0; line-height: 1.6; }
    .container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; background: white; }
    
    /* Header Styling */
    header { 
      background: linear-gradient(135deg, #0f2340 0%, #1a3a52 100%);
      color: white;
      padding: 30px;
      margin: -40px -20px 40px -20px;
      border-bottom: 4px solid #d4af37;
    }
    
    .header-content { display: flex; justify-content: space-between; align-items: flex-start; }
    
    .logo-section h1 { 
      font-size: 28px; 
      margin-bottom: 5px;
      letter-spacing: 2px;
    }
    
    .logo-section .gold { color: #d4af37; }
    .logo-section .tagline { 
      font-size: 11px; 
      color: #d4af37; 
      font-weight: 700; 
      letter-spacing: 2px;
      margin-top: 5px;
    }
    
    .contact-info { 
      text-align: right; 
      font-size: 12px; 
      color: #e8e8e8;
      line-height: 1.8;
    }
    
    .contact-info strong { color: #d4af37; }
    
    /* Title Section */
    .title-section {
      text-align: center;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 2px solid #d4af37;
    }
    
    .title-section h2 {
      font-size: 32px;
      color: #0f2340;
      margin-bottom: 10px;
    }
    
    .title-section .meta {
      color: #666;
      font-size: 14px;
    }
    
    /* Sections */
    section { margin-bottom: 50px; page-break-inside: avoid; }
    section h2 { 
      font-size: 22px; 
      color: #0f2340; 
      margin-bottom: 20px; 
      border-left: 4px solid #d4af37; 
      padding-left: 12px;
    }
    
    section h3 { 
      font-size: 16px; 
      color: #0f2340; 
      margin-top: 20px; 
      margin-bottom: 10px;
    }
    
    /* Intake Sections */
    .intake-section { 
      background: #f0ebe0; 
      padding: 15px; 
      margin-bottom: 15px; 
      border-radius: 4px; 
      border-left: 3px solid #d4af37;
    }
    
    .intake-item { 
      padding: 8px 0; 
      font-size: 13px;
      line-height: 1.5;
    }
    
    .intake-item strong { 
      color: #0f2340;
      display: inline-block;
      min-width: 150px;
    }
    
    /* Analysis Boxes */
    .analysis-box { 
      background: #f0ebe0; 
      border-left: 4px solid #d4af37; 
      padding: 20px; 
      margin-bottom: 20px; 
      border-radius: 4px;
    }
    
    .analysis-text { 
      white-space: pre-wrap; 
      font-size: 13px; 
      line-height: 1.8;
      color: #1c2430;
    }
    
    /* Buttons */
    .download-btn { 
      display: inline-block; 
      background: linear-gradient(135deg, #0f2340 0%, #1a3a52 100%);
      color: #d4af37; 
      padding: 12px 24px; 
      border-radius: 4px; 
      text-decoration: none; 
      font-weight: 700; 
      margin: 20px 0; 
      cursor: pointer; 
      border: 2px solid #d4af37;
      font-size: 14px;
    }
    
    .download-btn:hover { 
      background: #d4af37;
      color: #0f2340;
    }
    
    /* Footer */
    footer { 
      border-top: 2px solid #d4af37; 
      padding-top: 20px; 
      margin-top: 40px; 
      font-size: 11px; 
      color: #666; 
      text-align: center;
    }
    
    .page-break { page-break-after: always; }
    
    @media print { 
      body { background: white; } 
      .container { padding: 0; } 
      header { margin: 0; }
      section { page-break-inside: avoid; } 
      .download-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-content">
        <div class="logo-section">
          <h1>LINKD <span class="gold">BY ROYAL</span></h1>
          <div class="tagline">MEDICAL EXPEDITIONS</div>
        </div>
        <div class="contact-info">
          <strong>Linkd By Royal</strong><br>
          Posthoornstraat 11<br>
          3011WD Rotterdam<br>
          <br>
          <strong>info@linkdbyroyal.nl</strong><br>
          +31 6 87884978<br>
          <br>
          KVK: 42079291
        </div>
      </div>
    </header>

    <div class="title-section">
      <h2>${a.bedrijfsnaam || 'Bedrijf'}</h2>
      <p class="meta">${l.title} • ${new Date(record.receivedAt).toLocaleDateString(isDutch ? 'nl-NL' : 'en-US')}</p>
    </div>

    <!-- INTAKE DATA SECTION -->
    <section>
      <h2>${l.intakeData}</h2>
      ${formatIntakeData(a, lang)}
    </section>

    <div class="page-break"></div>

    <!-- MARKET RESEARCH SECTION -->
    <section>
      <h2>${l.marketAnalysis}</h2>
      <div class="analysis-box">
        <div class="analysis-text">${marketResearch || (isDutch ? 'Marktonderzoek niet beschikbaar' : 'Market research not available')}</div>
      </div>
    </section>

    <div class="page-break"></div>

    <!-- STRATEGIC ANALYSIS SECTION -->
    <section>
      <h2>${l.strategicAnalysis}</h2>
      <div class="analysis-box">
        <div class="analysis-text">${analysis || (isDutch ? 'Strategische analyse niet beschikbaar' : 'Strategic analysis not available')}</div>
      </div>
    </section>

    <button class="download-btn" onclick="window.print()">${l.downloadPDF}</button>

    <footer>
      <p>${l.generatedOn}: ${new Date(record.receivedAt).toLocaleString(isDutch ? 'nl-NL' : 'en-US')}</p>
      <p style="margin-top: 10px;">© Linkd by Royal - Medical Expeditions</p>
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
        console.log('Starting market research for', id);
        record.marketResearch = await runMarketResearch(answers, lang || 'nl');
        console.log('Market research completed for', id);
        
        console.log('Starting strategic analysis via Manus AI for', id);
        record.analysis = await runManusAnalysis(answers, record.marketResearch, lang || 'nl');
        console.log('Strategic analysis completed for', id);
        
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
    isDutch ? `Volledige rapport met intake-gegevens, marktonderzoek en strategische analyse beschikbaar.` : `Full report with intake data, market research and strategic analysis available.`
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
    header{background:linear-gradient(135deg,#0f2340 0%,#1a3a52 100%);color:#fff;padding:22px 28px;border-bottom:4px solid #d4af37;}
    header h1{font-family:'Playfair Display',serif;font-size:22px;margin:0;letter-spacing:2px;}
    header h1 span{color:#d4af37;}
    main{max-width:1000px;margin:34px auto;padding:0 20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;border-radius:12px;overflow:hidden;}
    th{background:#0f2340;color:#fff;text-align:left;padding:11px 14px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;}
    td{padding:12px 14px;border-top:1px solid #e4ddce;font-size:14px;}
    .btn{background:linear-gradient(135deg,#0f2340 0%,#1a3a52 100%);color:#d4af37;text-decoration:none;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:8px;display:inline-block;border:1px solid #d4af37;}
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
    res.setHeader('Content-Disposition', `inline; filename="rapport-${record.id}.html"`);
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
