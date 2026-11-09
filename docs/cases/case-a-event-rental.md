# Case A: Event rental company (pilot archetype)

This case is an illustrative scenario with synthetic data. No integration is connected. Every problem below is a hypothesis until evidence is attached.

## 1. Context and synthetic company profile

Synthetic profile. "Northline Events" rents audio, light, stage and furniture for corporate events and festivals.

| Attribute | Value (synthetic) |
|---|---|
| Size | 28 staff, plus 40 freelance crew in peak season |
| Departments | Sales, Project management, Warehouse, Crew planning, Finance, Management |
| Projects per year | about 600 (illustrative) |
| Systems | Rentman (projects, equipment, crew, quotes, invoices), Trengo (email and WhatsApp with customers), Pumble (team chat), QuickBooks (accounting, payments), Make and Google Sheets (glue), Dropbox (documents, signed quotes, delivery notes) |
| Pain reported by CEO | "I do not know what is invoiced, what is paid, and where margin leaks." |

## 2. Intake questions

### CEO (5)

| Question | Why it is needed (evidence gap) | Recipient | Answer type |
|---|---|---|---|
| Which three decisions do you take weekly without the data you would like? | Sets the scope of the first dashboard | CEO | Free text |
| How many projects per month go out without a signed quote? | Tests whether approval is a real control | CEO | Estimate, number |
| Who decides that an invoice may be sent, and when? | Identifies the owner of the invoicing step | CEO | Role name, rule |
| Which system is the single source of truth for project status? | Confirms whether Rentman status is trusted | CEO | System name |
| Which events this year went wrong, and how did you find out? | Reveals where exceptions surface today | CEO | Free text, examples |

### Follow-up per department (2 each)

| Question | Why it is needed | Recipient | Answer type |
|---|---|---|---|
| How is a Rentman invoice transferred to QuickBooks: export, Make scenario, or manual entry? | Determines where invoice and payment data can diverge | Finance lead | Choice plus description |
| How often do you reconcile open invoices against bank receipts? | Tests the payment check step | Finance lead | Frequency |
| How does a warehouse task reach the team: Rentman task, Pumble message, or paper? | Identifies hand-off channel and loss points | Operations lead | Choice |
| How is a shortage on a project detected before load-out day? | Tests the availability check | Operations lead | Description |
| Where does a WhatsApp request get logged as a project request? | Tests whether Trengo and Rentman are linked | Sales lead | Description |
| How many quotes are changed after the customer approved? | Tests scope-creep hypothesis | Sales lead | Estimate, number |

## 3. AS-IS process map

| Step | Trigger | Input | Owner | System | Hand-off | Wait time | Typical exceptions | Control | Output |
|---|---|---|---|---|---|---|---|---|---|
| 1 Request | Form or WhatsApp message | Event date, location, wish list | Sales | Trengo, web form | Sales copies to Rentman | 0 to 2 days (illustrative) | Request stays in Trengo, never logged | None | Project request in Rentman |
| 2 Availability and material check | New request | Equipment list, dates | Project manager | Rentman | Chat in Pumble if unclear | Same day | Subrental needed, not recorded | Visual check | Feasible or not |
| 3 Quote | Feasible | Prices, rates, discounts | Sales | Rentman quotes | PDF to customer via Trengo | 1 to 3 days (illustrative) | Discount outside policy | None | Quote sent |
| 4 Approval | Customer reply | Signed PDF or "ok" in WhatsApp | Sales | Trengo, Dropbox | Status change in Rentman | Variable | Verbal approval only | Status field | Project confirmed |
| 5 Project planning | Confirmed | Subprojects, crew functions | Project manager | Rentman | Crew requests | 1 week before event | Late changes | Planner review | Planned project |
| 6 Tasks to warehouse and crew | Planned | Pick lists, crew schedule | Warehouse lead | Rentman tasks, Pumble | Verbal | 1 to 2 days | Task posted in chat only | None | Prepared load |
| 7 Delivery and return | Event date | Packed goods, delivery note | Crew | Dropbox (photos), Rentman | Return check | Event duration | Damage, missing items | Count on return | Return registered |
| 8 Invoice and payment check | Return done | Final equipment and extra costs | Finance | Rentman invoices, QuickBooks | Export or Make | 0 to 30 days (illustrative) | Extras not invoiced, invoice not in QuickBooks | Monthly review | Paid invoice |
| 9 Management exceptions | Any issue | Chat messages | CEO | Pumble | None | Ad hoc | Issue noticed late | None | Decision |

## 4. Discovered problem (hypothesis)

Hypothesis A1: A share of confirmed projects is invoiced late or incompletely because step 8 depends on a manual transfer from Rentman to QuickBooks, and extra costs recorded after return are not carried over.

| Confirms | Refutes |
|---|---|
| Projects with status "returned" and no Rentman invoice after a set number of days | Every returned project has an invoice within policy |
| Rentman invoice totals that differ from the matching QuickBooks invoice | Totals match for a sample |
| Extra costs on projectequipment or costs that do not appear on invoice lines | Extra costs appear on invoices |

Data needed. Field availability must be verified per client; names below are expectations.

| System | Entity | Expected fields |
|---|---|---|
| Rentman | projects | id, displayname, status, customer, planperiod_start, planperiod_end, project_total_price |
| Rentman | subprojects | id, project, status, planperiod_start, planperiod_end |
| Rentman | projectequipment | id, project, equipment, quantity, quantity_returned, unit_price |
| Rentman | costs | id, project, amount, description |
| Rentman | invoices | id, project, number, date, status, total_price |
| Rentman | invoicelines | id, invoice, description, amount |
| QuickBooks | Invoice | Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef |
| QuickBooks | Payment | Id, TxnDate, TotalAmt, linked invoice Id |

## 5. TO-BE process with intervention labels

| Step | Intervention | Change |
|---|---|---|
| 1 Request | integrate | Trengo conversation creates a Rentman project request with a reference to the conversation |
| 2 Availability check | keep human | Planner decides; agent flags shortages |
| 3 Quote | standardize | Discount outside policy requires a named approver |
| 4 Approval | standardize | Approval only counts when a signed quote is stored in Dropbox and linked |
| 5 Planning | keep human | No change |
| 6 Tasks | simplify | Tasks live in Rentman only; Pumble gets a summary link, not the task |
| 7 Delivery and return | automate | Return count difference above zero creates a cost line draft for review |
| 8 Invoice and payment | integrate, then automate | Daily match of Rentman invoices with QuickBooks invoices and payments; mismatches listed |
| 9 Management | stop ad hoc, automate | Exceptions appear in a daily briefing instead of chat |

## 6. Agent roles activated

| Agent | Why |
|---|---|
| Discovery & Interview | Runs the intake and follow-up questions, stores evidence |
| COO & Operations | Owns the AS-IS and TO-BE process map |
| CFO & Finance | Owns hypothesis A1 and the invoice and payment KPIs |
| IT Data & Integration | Verifies entities and fields, runs the access phases |
| Automation Engineer | Builds the match and draft steps after approval |
| CEO Intelligence & Briefing | Produces the daily exception briefing |
| Security & Tenant Governance | Approves scopes per access phase |

## 7. Required integrations with access phases

| System | Metadata | Read-only | Sandbox | Write after approval |
|---|---|---|---|---|
| Rentman | API token with list access to describe entities | Read projects, subprojects, projectequipment, costs, invoices, invoicelines | Not offered by vendor; use a test project set | Create cost line drafts, tasks |
| QuickBooks | App connection, company info | Read Invoice, Payment | QuickBooks sandbox company | None in MVP |
| Trengo | API key, list channels | Read conversations metadata | Test inbox | Create ticket reference |
| Pumble | Bot token, list channels | Read channel names only | Test channel | Post briefing |
| Dropbox | App folder scope | List quote folder | Test folder | None |
| Make, Google Sheets | Scenario list, sheet list | Read scenario history, sheet rows | Copy of sheet | None |

## 8. Approval gates

1. CEO approves the question set before interviews start.
2. Finance lead approves read-only access scopes per system.
3. Owner of each step approves the TO-BE change for that step.
4. Each write action type (cost line draft, task, Pumble post) is approved separately; the first ten executions are reviewed one by one.
5. Any KPI shown to the CEO is signed off by the data owner.

## 9. KPIs

| KPI | Business question | Formula | Source and field | Owner | Refresh | When data is missing |
|---|---|---|---|---|---|---|
| Uninvoiced returned projects | What is finished but not billed? | Count of projects with status returned and no linked invoice | Rentman projects.status, invoices.project | Finance | Daily | "Not available: Rentman read access pending" |
| Invoice transfer gap | Do Rentman and QuickBooks agree? | Count of Rentman invoices without a QuickBooks invoice with equal total | Rentman invoices.total_price, QuickBooks Invoice.TotalAmt | Finance | Daily | Show count as "unknown" with reason |
| Days to invoice | How long after return do we bill? | Median of invoice date minus return date | Rentman invoices.date, subprojects.planperiod_end | Finance | Weekly | Blank with note |
| Open receivables over 30 days | What cash is late? | Sum of Balance where TxnDate older than 30 days | QuickBooks Invoice.Balance, TxnDate | Finance | Daily | Blank with note |
| Requests not logged | Which requests never became a project? | Trengo conversations tagged request without a project reference | Trengo conversation tag, custom field | Sales | Daily | Blank with note |

## 10. Realistic MVP

Can be built now with synthetic data: question sets, AS-IS and TO-BE maps, a synthetic Rentman and QuickBooks dataset with the fields above, the match logic for A1, KPI definitions, and a dashboard that renders "not available" states.

Depends on real client access: field verification, the metadata and read-only phases, true KPI values, any write action.

## 11. Management questions the system could derive

1. Which returned projects have no invoice after 14 days? Source: Rentman projects and invoices.
2. Which Rentman invoices have no matching QuickBooks invoice? Source: Rentman invoices, QuickBooks Invoice.
3. Which customers hold the largest overdue balance? Source: QuickBooks Invoice.Balance and CustomerRef.
4. Which projects were confirmed without a stored signed quote? Source: Rentman project status, Dropbox folder listing.
5. Which requests in Trengo this week have no project request in Rentman? Source: Trengo conversations, Rentman projectrequests.
