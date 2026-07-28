# Opdracht voor Manus AI: host de Linkd by Royal Discovery Intake

Ik upload een zip (intake-backend.zip) met een complete, geteste Node/Express-applicatie. Jouw taak: deploy deze naar een publieke URL en lever mij twee klikbare links op. Bouw niets opnieuw en wijzig de code niet, tenzij strikt nodig om te deployen.

## Wat de app doet
- Hoofdpagina: het Discovery & Strategy Intake-formulier (public/index.html), in te vullen door de klant zelf of samen tijdens een gesprek
- POST /api/analyze: stuurt intake-antwoorden server-side naar de Anthropic API (Claude) en geeft een JSON-analyse terug
- POST /api/submit: slaat elke afgeronde intake automatisch op als JSON-dossier in de map data/
- GET /admin?token=...: beveiligd dashboard met alle inzendingen, met vanuit daar per klant een volledig rapport (alle antwoorden, prioriteitsmatrix, strategische analyse) en een "Download als PDF"-knop
- Er wordt NIETS gemaild; alles komt alleen binnen in het dashboard

## Deploy-eisen
1. Node 18 of hoger, start met `npm install` en `npm start` (poort via env-variabele PORT)
2. Kies een host met een persistent Node-proces én een persistente schrijfbare disk gekoppeld aan de map data/ (bijv. Railway met volume, of Render met disk). Zonder persistente disk verdwijnen dossiers bij elke herstart; dat is onacceptabel
3. Environment-variabelen (slechts twee verplicht):
   - ANTHROPIC_API_KEY: vul ik ZELF in via het hosting-dashboard, vraag mij er niet om in de chat
   - ADMIN_TOKEN: genereer een lange willekeurige waarde (32+ tekens) en geef die aan mij door
   - Optioneel: CLAUDE_MODEL=claude-sonnet-4-6
4. Verifieer na deploy:
   - De hoofdpagina toont het intake-formulier met de vaarroute-voortgangsbalk
   - Een testinzending doorloopt het formulier en verschijnt daarna in /admin
   - Het rapport per inzending opent en de "Download als PDF"-knop werkt
   - /admin zonder geldig token geeft een 401-fout
   - Verwijder de testinzending uit data/ na verificatie

## Op te leveren
1. Formulier-link voor klanten: https://JOUW-URL/
2. Dashboard-link voor mij (direct klikbaar, inclusief token): https://JOUW-URL/admin?token=HET_GEGENEREERDE_TOKEN
3. Waar ik de environment-variabelen kan beheren om mijn ANTHROPIC_API_KEY in te vullen

## Wat je NIET moet doen
- De Anthropic-call niet naar de browser verplaatsen (de key moet server-side blijven)
- Geen wijzigingen aan design, vragen of teksten van het formulier
- Geen extra frameworks, databases of build-stappen toevoegen
- Het ADMIN_TOKEN nergens publiek opslaan (niet in code, niet in de repository)
