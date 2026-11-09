# Case B: Hospitality (hotel)

This case is an illustrative scenario with synthetic data. No integration is connected. Every problem below is a hypothesis until evidence is attached.

## 1. Context and synthetic company profile

Synthetic profile. "Harbour View Hotel" is an independent hotel with a restaurant and meeting rooms.

| Attribute | Value (synthetic) |
|---|---|
| Size | 84 rooms, 55 staff |
| Departments | Front office, Housekeeping, Food and beverage, Purchasing, HR and rostering, Finance, Management |
| Systems | Property management system (PMS) for bookings, channel manager, point of sale for restaurant, purchasing portal of main supplier, inventory spreadsheet, rostering tool, accounting package, shared inbox for guest questions |
| Pain reported by GM | "Daily revenue arrives from three places and never adds up on the first try. Purchasing and staffing are planned on gut feeling." |

## 2. Intake questions

### CEO or general manager (5)

| Question | Why it is needed (evidence gap) | Recipient | Answer type |
|---|---|---|---|
| Which number do you check first every morning, and where does it come from? | Identifies the current daily revenue source | GM | System name, metric |
| How many people touch a daily revenue figure before it is final? | Tests hand-off count | GM | Number, roles |
| How far ahead is the roster fixed, and what changes it? | Links staffing to occupancy forecast | GM | Days, triggers |
| Who may place a purchase order, and against what limit? | Tests purchasing control | GM | Roles, rule |
| Which guest complaints last quarter were caused by missing information between shifts? | Finds hand-off failures | GM | Examples |

### Follow-up per department (2 each)

| Question | Why it is needed | Recipient | Answer type |
|---|---|---|---|
| How is PMS revenue posted to accounting: export, manual journal, or integration? | Locates the reconciliation break | Finance lead | Choice |
| How many corrections are made to daily revenue after month end? | Tests reliability of the figure | Finance lead | Number per month |
| How does housekeeping learn about early arrivals and late check-outs? | Tests front office to housekeeping hand-off | Operations lead | Channel |
| How is restaurant stock counted and when is it reordered? | Tests inventory to purchasing link | Operations lead | Description |
| How is next week's occupancy shared with rostering? | Tests the forecast to roster hand-off | HR and rostering lead | Channel, frequency |
| How often do shifts get changed inside 48 hours, and why? | Measures roster instability | HR and rostering lead | Estimate, reasons |

## 3. AS-IS process map

| Step | Trigger | Input | Owner | System | Hand-off | Wait time | Typical exceptions | Control | Output |
|---|---|---|---|---|---|---|---|---|---|
| 1 Booking | Channel or direct | Dates, room type, guest data | Front office | Channel manager, PMS | Automatic to PMS | Minutes | Duplicate or overbooking | PMS rules | Reservation |
| 2 Guest questions | Email, phone, message | Request | Front office | Shared inbox | Note in PMS if remembered | Hours | Request not recorded | None | Answer |
| 3 Occupancy forecast | Weekly | PMS reservations | GM | PMS report, spreadsheet | Email to rostering | Weekly | Forecast outdated | None | Forecast |
| 4 Roster | Forecast | Availability, forecast | HR and rostering | Rostering tool | Published to staff | 1 to 2 weeks | Short-notice changes | Manager check | Roster |
| 5 Inventory count | Weekly or when low | Shelf count | F&B lead | Spreadsheet | Verbal to purchasing | Days | Count skipped | None | Stock figure |
| 6 Purchasing | Low stock | Count, menu plan | Purchasing | Supplier portal | Delivery note to Finance | 2 to 3 days | Order outside limit | Limit in head only | Order |
| 7 Service and sales | Guest stay | Room, F&B, meeting rooms | Front office, F&B | PMS, POS | End-of-day close | Daily | Items posted to wrong folio | Night audit | Posted revenue |
| 8 Daily revenue | Night audit | PMS, POS, meeting room sheet | Finance | Spreadsheet, accounting | Manual journal | 1 to 5 days (illustrative) | Totals do not match | Month-end check | Revenue figure |
| 9 Management | Any issue | Verbal reports | GM | None | None | Ad hoc | Late detection | None | Decision |

## 4. Discovered problem (hypothesis)

Hypothesis B1: Daily revenue is unreliable on first production because three sources (PMS, POS, meeting room sheet) are combined by hand, and corrections are made after month end.

| Confirms | Refutes |
|---|---|
| Journal entries that revise revenue for prior days | No revisions after day plus two |
| Differences between PMS night audit total and accounting revenue for the same day | Totals match for a sampled month |
| Meeting room revenue entered in a sheet with dates that differ from PMS | Meeting rooms posted in PMS |

Hypothesis B2 (secondary): Rosters are set before the latest forecast, so staffing does not follow occupancy. Confirmed by roster publish date earlier than forecast date for most weeks.

Data needed. Field availability must be verified per client.

| System | Entity | Expected fields |
|---|---|---|
| PMS | Night audit report | business_date, room_revenue, fnb_revenue, other_revenue, occupancy |
| POS | Daily close | business_date, outlet, gross_sales, payment_type |
| Spreadsheet | Meeting room sales | date, room, amount, posted_to_pms flag |
| Accounting | Journal lines | posting_date, account, amount, created_at, modified_at |
| Rostering tool | Published roster | week, publish_date, shifts, hours per role |

## 5. TO-BE process with intervention labels

| Step | Intervention | Change |
|---|---|---|
| 1 Booking | keep human | No change; PMS already controls |
| 2 Guest questions | standardize | Every request gets a PMS trace or inbox tag with a room number |
| 3 Forecast | automate | Forecast pulled from PMS each night, not typed in a sheet |
| 4 Roster | integrate | Roster tool receives the forecast; publish date must follow forecast date |
| 5 Inventory | simplify | One count template, one count day per outlet |
| 6 Purchasing | standardize | Order limit written down; orders above limit need approval |
| 7 Service and sales | keep human | Night audit stays as is |
| 8 Daily revenue | integrate, then automate | PMS and POS totals compared daily; one figure with a reconciliation status |
| 9 Management | stop ad hoc, automate | Daily briefing with revenue status and roster versus forecast |

## 6. Agent roles activated

| Agent | Why |
|---|---|
| Discovery & Interview | Runs intake and follow-up |
| CFO & Finance | Owns hypothesis B1 and revenue reconciliation |
| COO & Operations | Maps hand-offs across departments |
| HR & People | Owns hypothesis B2 and roster data |
| Procurement & Inventory | Designs count and order controls |
| IT Data & Integration | Verifies exports and APIs, runs access phases |
| CEO Intelligence & Briefing | Produces the morning briefing |
| Security & Tenant Governance | Approves guest data handling |

## 7. Required integrations with access phases

| System | Metadata | Read-only | Sandbox | Write after approval |
|---|---|---|---|---|
| PMS | Report list, API capability check | Night audit report, reservations (no guest names in MVP) | Vendor demo property if available | None |
| POS | Outlet list | Daily close totals | Test outlet | None |
| Accounting | Chart of accounts | Journal lines for revenue accounts | Test company | None |
| Rostering tool | Role list | Published rosters | Test week | Draft roster suggestion |
| Spreadsheets | Sheet list | Read meeting room sheet | Copy | None |
| Shared inbox | Folder list | Message metadata only | Test mailbox | Tag messages |

## 8. Approval gates

1. GM approves the question set and which departments are interviewed.
2. Finance lead approves read access to accounting and PMS reports.
3. Data protection owner approves that guest personal data is excluded from the MVP.
4. Each TO-BE step is approved by its step owner before any build.
5. Any write action (tag, draft roster) is approved per action type and reviewed for the first ten cases.

## 9. KPIs

| KPI | Business question | Formula | Source and field | Owner | Refresh | When data is missing |
|---|---|---|---|---|---|---|
| Revenue reconciliation status | Does yesterday add up? | PMS plus POS plus meeting room total minus accounting revenue for the same date | PMS night audit, POS daily close, accounting journal amount | Finance | Daily | "Not reconciled: source missing" with source named |
| Days to final revenue | How long until a day is closed? | Last modified_at of revenue journal minus business_date | Accounting journal modified_at | Finance | Weekly | Blank with note |
| Roster to forecast lag | Was staffing planned on current data? | Roster publish_date minus forecast date | Rostering tool publish_date, PMS forecast date | HR | Weekly | Blank with note |
| Orders above limit | Is purchasing controlled? | Count of orders above written limit without approval record | Supplier portal order total, approval log | Purchasing | Weekly | "No approval log connected" |
| Unrecorded guest requests | Do requests leave a trace? | Inbox messages tagged request without a PMS trace | Inbox tag, PMS trace | Front office | Daily | Blank with note |

## 10. Realistic MVP

Can be built now with synthetic data: question sets, process maps, a synthetic night audit, POS close and journal dataset, the reconciliation logic for B1, the roster lag calculation for B2, KPI definitions, and a dashboard that shows missing-data states.

Depends on real client access: PMS and POS export capabilities, accounting read access, confirmation that guest personal data can be excluded, true KPI values, any write action.

## 11. Management questions the system could derive

1. Which days this month are still not reconciled? Source: PMS night audit versus accounting journal.
2. How many revenue corrections were posted after month end? Source: accounting journal created_at and modified_at.
3. Which weeks had a roster published before the latest forecast? Source: rostering publish_date, PMS forecast date.
4. Which purchase orders exceeded the limit without approval? Source: supplier portal order totals, approval log.
5. How many guest requests this week left no trace in the PMS? Source: inbox tags, PMS traces.
