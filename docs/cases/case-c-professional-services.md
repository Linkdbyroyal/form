# Case C: Professional services (consultancy or agency)

This case is an illustrative scenario with synthetic data. No integration is connected. Every problem below is a hypothesis until evidence is attached.

## 1. Context and synthetic company profile

Synthetic profile. "Brightpath Consulting" delivers strategy and implementation projects on fixed price and time and material contracts.

| Attribute | Value (synthetic) |
|---|---|
| Size | 42 staff, of which 30 billable |
| Departments | Sales, Delivery, Resource planning, Finance, Management |
| Projects per year | about 120 (illustrative) |
| Systems | CRM for leads and quotes, document tool for contracts, time tracking tool, project tool for tasks, accounting package for invoicing, spreadsheets for margin and client follow-up, email for client contact |
| Pain reported by CEO | "I learn the margin months later, and invoices go out late because nobody knows which hours are approved." |

## 2. Intake questions

### CEO (5)

| Question | Why it is needed (evidence gap) | Recipient | Answer type |
|---|---|---|---|
| At which moment do you first see the margin of a project? | Locates the margin visibility gap | CEO | Milestone name |
| How long does it take from a signed contract to the first invoice? | Tests lead time hypothesis | CEO | Estimate, days |
| Who approves hours before they are invoiced, and in which system? | Identifies the hours approval control | CEO | Role, system |
| Which clients paid late last year, and did anyone see it coming? | Tests receivables monitoring | CEO | Examples |
| Which projects ran over budget, and when did you know? | Tests overrun detection | CEO | Examples, timing |

### Follow-up per department (2 each)

| Question | Why it is needed | Recipient | Answer type |
|---|---|---|---|
| How are approved hours transferred to invoices: export, integration, or manual? | Locates the hours to invoice break | Finance lead | Choice |
| How often is the receivables list reviewed and who acts on it? | Tests collection discipline | Finance lead | Frequency, role |
| How is a project budget in the quote carried into the project tool and time tracking? | Tests quote to project link | Operations or Delivery lead | Description |
| How are scope changes recorded and priced? | Tests change control | Delivery lead | Description |
| How is a quote converted into a contract, and where is the signed version stored? | Tests quote to contract hand-off | Sales lead | Description |
| How many quotes are sent without a margin calculation? | Tests pricing control | Sales lead | Estimate, number |

## 3. AS-IS process map

| Step | Trigger | Input | Owner | System | Hand-off | Wait time | Typical exceptions | Control | Output |
|---|---|---|---|---|---|---|---|---|---|
| 1 Lead | Inbound or referral | Client need | Sales | CRM | Email to consultant | Days | Lead not logged | None | Qualified lead |
| 2 Quote | Qualified lead | Scope, rates, estimate | Sales | CRM, spreadsheet | PDF by email | 3 to 10 days (illustrative) | No margin calculation | Partner glance | Quote sent |
| 3 Contract | Quote accepted | Terms, signature | Sales | Document tool, email | Signed copy in shared drive | 1 to 3 weeks | Work starts before signature | None | Signed contract |
| 4 Project setup | Signed contract | Budget, team | Delivery lead | Project tool, time tracking | Manual re-entry of budget | Days | Budget differs from quote | None | Project created |
| 5 Hours | Weekly | Time entries | Consultants | Time tracking | Approval by project lead | Weekly to monthly | Late entries, unapproved hours | Approval flag | Approved hours |
| 6 Invoicing | Month end | Approved hours, milestones | Finance | Accounting package | Manual from export | 5 to 15 days after month end (illustrative) | Hours missing, wrong rate | Finance review | Invoice sent |
| 7 Client follow-up | Due date passed | Open invoice list | Finance, account owner | Spreadsheet, email | Email to account owner | Weeks | Nobody follows up | None | Payment or dispute |
| 8 Margin review | Quarterly | Hours cost, invoices | CEO | Spreadsheet | None | Quarterly | Too late to act | None | Margin figure |

## 4. Discovered problem (hypothesis)

Hypothesis C1: Lead time from signed contract to first invoice is long because budget and hours are re-entered by hand across three systems, and hours approval is not enforced before invoicing.

Hypothesis C2: Project margin is only visible at quarter end because cost of hours and invoiced revenue live in different systems with no shared project key.

Hypothesis C3: Receivables risk is detected late because follow-up depends on a spreadsheet nobody owns.

| Hypothesis | Confirms | Refutes |
|---|---|---|
| C1 | First invoice date minus contract signed date exceeds policy for most projects; unapproved hours present on invoiced periods | First invoice within policy; all invoiced hours approved |
| C2 | No common project identifier across time tracking and accounting; margin sheet updated quarterly | Common key exists and margin is computed monthly |
| C3 | Invoices overdue more than 30 days without a logged follow-up action | Follow-up logged within days of due date |

Data needed. Field availability must be verified per client.

| System | Entity | Expected fields |
|---|---|---|
| CRM | Opportunity, Quote | id, client, stage, quote_amount, estimated_hours, sent_date, accepted_date |
| Document tool | Contract | id, opportunity_id, signed_date, value |
| Time tracking | Time entry | id, project_id, user, date, hours, cost_rate, billable, approved, approved_at |
| Project tool | Project | id, name, budget_hours, budget_amount, start_date |
| Accounting | Invoice | id, client, project_reference, issue_date, due_date, total, balance |
| Spreadsheet | Follow-up log | invoice_id, action_date, action, owner |

## 5. TO-BE process with intervention labels

| Step | Intervention | Change |
|---|---|---|
| 1 Lead | standardize | Every lead gets a CRM record before any proposal work |
| 2 Quote | standardize | Quote cannot be sent without a margin field filled in |
| 3 Contract | keep human | Partner signs; signed date recorded in CRM |
| 4 Project setup | integrate | Project created from the quote with the same identifier and budget |
| 5 Hours | automate | Weekly reminder for missing and unapproved hours; approval required before export |
| 6 Invoicing | integrate | Approved hours flow to invoice drafts; Finance reviews drafts |
| 7 Client follow-up | automate, keep human | System lists overdue invoices and drafts reminders; account owner decides |
| 8 Margin review | stop quarterly sheet, automate | Monthly margin per project from shared identifier |

## 6. Agent roles activated

| Agent | Why |
|---|---|
| Discovery & Interview | Runs intake and follow-up |
| CFO & Finance | Owns hypotheses C1 to C3, invoicing and receivables KPIs |
| Sales & Customer | Owns quote and contract steps and client follow-up |
| COO & Operations | Maps the delivery and hours steps |
| IT Data & Integration | Finds or creates the shared project key, runs access phases |
| Process Redesign | Designs the quote to project to invoice chain |
| CEO Intelligence & Briefing | Produces the monthly margin and receivables briefing |
| Security & Tenant Governance | Approves client data scopes |

## 7. Required integrations with access phases

| System | Metadata | Read-only | Sandbox | Write after approval |
|---|---|---|---|---|
| CRM | Object list, field list | Opportunities, quotes | Vendor sandbox | Set signed date, project identifier |
| Time tracking | Project and user list | Time entries with approval status | Test workspace | Send reminders |
| Project tool | Project list | Budgets | Test project | Create project from quote |
| Accounting | Chart of accounts, invoice fields | Invoices and balances | Test company | Create invoice drafts |
| Document tool | Template list | Contract signed dates | Test folder | None |
| Email | None in MVP | None | None | Draft reminder only, sent by a human |

## 8. Approval gates

1. CEO approves the question set and which clients may be analysed.
2. Finance lead approves read access to accounting and time tracking.
3. The shared project identifier scheme is approved by Finance and Delivery before any write.
4. Invoice drafts are always reviewed by Finance before sending.
5. Client reminders are drafted by the system and sent by the account owner. No automatic sending in the MVP.

## 9. KPIs

| KPI | Business question | Formula | Source and field | Owner | Refresh | When data is missing |
|---|---|---|---|---|---|---|
| Contract to first invoice | How fast do we start billing? | Median of first invoice issue_date minus contract signed_date | Accounting invoice issue_date, document tool signed_date | Finance | Monthly | Blank with "contract dates not connected" |
| Unapproved hours at month end | Can we invoice on time? | Sum of hours where approved is false and date is in closed month | Time tracking approved, hours, date | Delivery | Weekly | Blank with note |
| Project margin | Do we earn on this project? | Invoiced total minus sum of hours times cost_rate, divided by invoiced total | Accounting total, time tracking hours and cost_rate | Finance | Monthly | "Margin not computable: no shared project key" |
| Overdue receivables without action | Are we chasing late payers? | Sum of balance where due_date older than 30 days and no follow-up action logged | Accounting balance, due_date; follow-up log action_date | Finance | Weekly | Blank with note |
| Quotes without margin | Do we price with control? | Count of quotes sent with empty margin field | CRM quote margin field | Sales | Weekly | "Margin field not present in CRM" |

## 10. Realistic MVP

Can be built now with synthetic data: question sets, process maps, a synthetic dataset of opportunities, contracts, time entries and invoices with a shared project key, the three hypothesis tests, KPI definitions, and a dashboard with explicit missing-data states.

Depends on real client access: confirmation that a shared project key exists or can be introduced, approval status in time tracking, accounting read access, true KPI values, any write action.

## 11. Management questions the system could derive

1. Which projects started work before the contract was signed? Source: time tracking first entry date, document tool signed_date.
2. Which closed months still contain unapproved hours? Source: time tracking approved flag and date.
3. Which projects show a margin below the quoted margin? Source: CRM quote margin, time tracking cost, accounting invoices.
4. Which overdue invoices have had no follow-up action? Source: accounting balance and due_date, follow-up log.
5. Which quotes were sent without a margin calculation this quarter? Source: CRM quote margin field.
