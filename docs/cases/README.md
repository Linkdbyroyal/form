# Case library

This folder holds three worked scenarios for the Second Brain Business OS. Each case shows how the agent pool would diagnose a company, ask targeted questions, map the AS-IS process, propose a TO-BE process, and monitor KPIs.

| Case | File | Archetype | Pilot status |
|---|---|---|---|
| A | [case-a-event-rental.md](./case-a-event-rental.md) | Event rental company (Rentman, Trengo, Pumble, QuickBooks, Make, Google Sheets, Dropbox) | Pilot archetype |
| B | [case-b-hospitality.md](./case-b-hospitality.md) | Hotel with bookings, purchasing, inventory, staffing and daily revenue in separate systems | Reference scenario |
| C | [case-c-professional-services.md](./case-c-professional-services.md) | Consultancy or agency with fragmented quote-to-cash | Reference scenario |

## Rules that apply to every case

1. All three cases are illustrative scenarios. Company names, sizes, volumes and amounts are synthetic. Any number is labelled "illustrative" and must not be read as a measurement.
2. No integration is connected. System names (Rentman, Trengo, QuickBooks, and others) describe the systems a company of this type typically uses. Field names are expectations, not confirmed schemas. Availability of every entity and field must be verified per client during the metadata phase.
3. Every problem listed is a hypothesis until evidence is attached. A hypothesis is only promoted to a finding when the named source data has been read and the confirming evidence is stored with the finding.
4. Agents do not change anything in a client system without an approval gate. Each case lists its gates.
5. Each case follows the same section order so that cases can be compared side by side.

## Section order used in each case

Context and synthetic company profile, intake and follow-up questions, AS-IS process map, discovered problem as hypothesis, TO-BE process with intervention labels, agent roles activated, required integrations with access phases, approval gates, KPIs, realistic MVP, management questions.
