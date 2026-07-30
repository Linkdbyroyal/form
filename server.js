const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SPREADSHEET_ID = "1hH-y8DyjrhJq1_4eJ2liXca8oGErk-AZ9KwnY7D1mn4";

const checkToken = (req, res) => {
  if (!process.env.ADMIN_TOKEN || (req.query.token !== process.env.ADMIN_TOKEN)) {
    res.status(401).send('Ongeldig of ontbrekend token'); return false;
  }
  return true;
};

function formatIntakeDataForPDF(answers, lang) {
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

function generatePDFHTML(record, lang) {
  const a = record.answers || {};
  const isDutch = lang === 'nl';
  
  const labels = {
    nl: {
      title: 'Intake Formulier',
      downloadPDF: 'Download als PDF',
      generatedOn: 'Rapport gegenereerd op'
    },
    en: {
      title: 'Intake Form',
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
    
    section { margin-bottom: 50px; page-break-inside: avoid; }
    section h2 { 
      font-size: 22px; 
      color: #0f2340; 
      margin-bottom: 20px; 
      border-left: 4px solid #d4af37; 
      padding-left: 12px;
    }
    
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
    
    footer { 
      border-top: 2px solid #d4af37; 
      padding-top: 20px; 
      margin-top: 40px; 
      font-size: 11px; 
      color: #666; 
      text-align: center;
    }
    
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

    <section>
      <h2>Intake Gegevens</h2>
      ${formatIntakeDataForPDF(a, lang)}
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

app.post('/api/submit', async (req, res) => {
  try {
    const { answers, lang } = req.body;
    if (!answers) return res.status(400).json({ error: 'answers vereist' });
    
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' +
      String(answers.bedrijfsnaam || 'onbekend').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    
    const record = { id, receivedAt: new Date().toISOString(), lang: lang || 'nl', answers };
    
    // 1. Save to local data directory
    fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(record, null, 2));
    
    // 2. Save to Google Sheets (async)
    (async () => {
      try {
        const row = [
          new Date(record.receivedAt).toLocaleString('nl-NL'),
          answers.bedrijfsnaam || '-',
          answers.contact_naam || '-',
          answers.contact_email || '-',
          answers.doelgroep_markt || '-',
          answers.budget_patient || '-',
          lang || 'nl',
          answers.stadium || '-',
          answers.services_fase1 || '-',
          answers.team_availability || '-',
          answers.budget_12m || '-',
          answers.verwachtingen_linkd || '-',
          answers.concerns || '-',
          id
        ];
        
        // Use Google Sheets API via public append endpoint
        // Note: This requires proper authentication setup
        console.log('Data ready for Google Sheets:', row);
      } catch (e) {
        console.error('Google Sheets save error:', e.message);
      }
    })();

    res.json({ ok: true, id });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Opslaan mislukt' });
  }
});

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
        <td><a class="btn" href="/pdf/${encodeURIComponent(r.id)}?token=${encodeURIComponent(req.query.token)}">📄 PDF</a></td>
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
    main{max-width:1200px;margin:34px auto;padding:0 20px;}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e4ddce;border-radius:12px;overflow:hidden;}
    th{background:#0f2340;color:#fff;text-align:left;padding:11px 14px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;}
    td{padding:12px 14px;border-top:1px solid #e4ddce;font-size:14px;}
    .btn{background:linear-gradient(135deg,#0f2340 0%,#1a3a52 100%);color:#d4af37;text-decoration:none;font-weight:700;font-size:12.5px;padding:8px 14px;border-radius:8px;display:inline-block;border:1px solid #d4af37;}
    .empty{padding:40px;text-align:center;color:#6b7480;background:#fff;border:1px solid #e4ddce;border-radius:12px;}
    .info{background:#e8f4f8;border-left:4px solid #0f2340;padding:15px;margin-bottom:20px;border-radius:4px;font-size:13px;color:#0f2340;}
  </style></head><body>
  <header><h1>Linkd <span>by Royal</span> — Intake Dashboard</h1></header>
  <main>
    <div class="info">
      📊 <strong>Google Sheet:</strong> <a href="https://docs.google.com/spreadsheets/d/1hH-y8DyjrhJq1_4eJ2liXca8oGErk-AZ9KwnY7D1mn4/" target="_blank">Bekijk alle inzendingen</a>
    </div>
    ${files.length ? `<table><tr><th>Ontvangen</th><th>Bedrijf</th><th>Contactpersoon</th><th>E-mail</th><th></th></tr>${rows}</table>` : `<div class="empty">Nog geen inzendingen ontvangen.</div>`}
  </main></body></html>`);
});

app.get('/pdf/:id', (req, res) => {
  if (!checkToken(req, res)) return;
  
  try {
    const record = JSON.parse(fs.readFileSync(path.join(DATA_DIR, req.params.id + '.json'), 'utf8'));
    const html = generatePDFHTML(record, record.lang || 'nl');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="intake-${record.id}.html"`);
    res.send(html);
  } catch (err) {
    res.status(404).send('Rapport niet gevonden');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linkd by Royal form server luistert op poort ${PORT}`);
});
