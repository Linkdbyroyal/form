# Linkd by Royal — Intake Backend

Kleine Node/Express-server die drie dingen doet:
1. **/api/analyze**: stuurt de intake naar Claude met jouw geheime API-key (de key staat dus nooit in de browser)
2. **/api/submit**: slaat elke inzending op als dossier in `data/` en verstuurt automatisch twee mails: een notificatie naar jou met het volledige dossier als bijlage, en een bevestiging met vervolgstappen naar de klant
3. Serveert het intake-formulier zelf op de hoofdpagina (`public/index.html`)

## Lokaal starten
```
npm install
cp .env.example .env    # vul je waarden in
npm start               # draait op http://localhost:3000
```

## Deployen (aanbevolen: Railway of Render, gratis tier volstaat om te starten)
1. Zet deze map in een GitHub-repository
2. Maak een nieuw project aan op railway.app of render.com en koppel de repo
3. Vul de environment-variabelen uit `.env.example` in via het dashboard
4. Deploy: je krijgt een URL zoals `https://intake.up.railway.app`, dat is meteen de link die je naar klanten stuurt

## E-mail
Gebruik de SMTP-gegevens van je eigen mailprovider (bijv. je zakelijke mailbox bij je hostingpartij). Zonder SMTP-configuratie werkt alles behalve de mails: inzendingen worden dan alleen opgeslagen.

## Dossiers inzien
- Overzicht: `GET /api/submissions?token=JOUW_ADMIN_TOKEN`
- Eén dossier: `GET /api/submissions/{id}?token=JOUW_ADMIN_TOKEN`

## Formulier
`public/index.html` is het intake-formulier. Bovenin het script staat `BACKEND_URL`; standaard leeg = zelfde server. Wil je het formulier los hosten, vul daar dan de volledige backend-URL in.
