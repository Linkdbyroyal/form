# @sbos/contracts

Shared, versioned JSON contracts for the Second Brain Business OS. Every record that
crosses a boundary between an agent (Mastra), the Next.js API and the UI is validated
against one of these schemas. The schemas are written with Zod 4 and consumed as
TypeScript source inside the monorepo (no build step). Field names are `snake_case`.

```ts
import { FindingSchema, type Finding, toJsonSchemas, CONTRACTS_VERSION } from "@sbos/contracts";

const finding: Finding = FindingSchema.parse(payload);
const json = toJsonSchemas(); // Record<ContractName, JSON Schema (draft 2020-12)>
```

## The agent output envelope

Every contract produced by an agent extends `AgentOutputEnvelopeSchema`. The envelope
makes provenance and trust explicit, so nothing an agent says can be shown to a user or
written to a vault without knowing where it came from and whether a human looked at it.

| Field | Required | Meaning |
| --- | --- | --- |
| `tenant_id` | yes | Client tenant the output belongs to. Never omitted, never guessed. |
| `source_ids` | yes | Evidence or source records that back the output (may be empty for pure hypotheses, which must then say so in `uncertainties`). |
| `confidence` | yes | 0..1 self-assessed confidence of the producing agent. |
| `generated_at` | yes | ISO 8601 timestamp of generation. |
| `review_status` | yes | `unreviewed`, `in_review`, `approved`, `rejected`, `superseded`. |
| `permissions_context` | yes | Who produced it and under which tenant, roles and scopes. `cross_tenant_content_authorized` defaults to `false`. |
| `agent_id`, `run_id`, `skill_version` | no | Traceability back to the run and skill version. |
| `uncertainties` | no | Plain-language list of what the agent is unsure about. |

Facts carry a separate `verification_status` that expresses epistemic standing:
`unconfirmed` (the client said it), `hypothesis` (an agent inferred it), `evidence_backed`
(data shows it), `verified` (a reviewer promoted it), `approved_policy` (formal company
policy) and `deprecated`.

## Versioning rule

`CONTRACTS_VERSION` follows semver and is exported from `src/index.ts`.

- Additive changes (new optional field, new enum value that consumers can ignore, new
  contract) bump the **minor** version. Consumers must tolerate unknown enum values and
  extra optional fields.
- Breaking changes (removed or renamed field, a field made required, a narrowed enum,
  changed semantics) bump the **major** version. The previous schemas are kept under
  `src/v1/` (and so on) so stored records can still be parsed and migrated.
- Patch versions are reserved for description text, test and documentation fixes.

## Contracts

| Contract | File | Envelope | Purpose |
| --- | --- | --- | --- |
| `QuestionRequest` | `src/question-request.ts` | no | Discovery Engine question asked of a role in a department, with the evidence gap it closes. |
| `AnswerRecord` | `src/answer-record.ts` | no | Human answer to a question, with epistemic status (defaults to `unconfirmed`). |
| `EvidenceRecord` | `src/evidence-record.ts` | no | A captured piece of evidence (document, system record, interview answer, metric, ...). |
| `Finding` | `src/finding.ts` | yes | Observed problem or fact about a process, with severity, impact and claim type. |
| `Opportunity` | `src/opportunity.ts` | yes | Proposed intervention built on findings, with business case and priority score. |
| `ApprovalRequest` | `src/approval-request.ts` | no | Human-in-the-loop gate for risky or policy-relevant actions. |
| `KpiDefinition` | `src/kpi-definition.ts` | no | Definition of a KPI: formula, source, thresholds, reliability, retention. |
| `KpiObservation` | `src/kpi-observation.ts` | no | One measured KPI value with lineage; `value` must be `null` unless `status` is `ok`. |
| `DashboardSpecification` | `src/dashboard-specification.ts` | no | Render-safe dashboard layout for a role; widget types are a whitelist. |
| `ExecutiveBriefing` | `src/executive-briefing.ts` | yes | Daily briefing with fixed sections and 1..7 top priorities. |
| `UpgradeProposal` | `src/upgrade-proposal.ts` | yes | Detected knowledge, skill or code upgrade with risk, migration and rollback plan. |
| `AgentRunResult` | `src/agent-run-result.ts` | yes | Outcome of one agent run: outputs, tools, tokens, checkpoints, errors, help requests. |
| `VaultDocument` | `src/vault-document.ts` | no | Markdown document in a client or agency vault; client scope requires `tenant_id`. |
| `KnowledgeFact` | `src/knowledge-fact.ts` | no | Atomic, sourced statement with verification status and access policy. |
| `FactVerificationRequest` | `src/fact-verification-request.ts` | no | Request to a reviewer to resolve a contested or unverified fact. |
| `AgentFeedback` | `src/agent-feedback.ts` | no | Human feedback on an agent output, optionally flagged to update the skill. |
| `MissionControlSummary` | `src/mission-control-summary.ts` | no | Cross-client operational summary; metadata only, never document content. |

Shared primitives (`UuidSchema`, `IsoDateTimeSchema`, `ConfidenceSchema`, `ReviewStatusSchema`,
`VerificationStatusSchema`, `ClassificationSchema`, `PermissionsContextSchema`, `SourceRefSchema`,
`ActorRefSchema`, `EntityRefSchema`, `MoneyEstimateSchema`, `OutputRefSchema`) live in `src/common.ts`.

## JSON Schema

`toJsonSchemas()` converts every contract with Zod 4's built-in `z.toJSONSchema()` and
returns a record keyed by contract name. Cross-field rules implemented with `.refine()`
(for example the `KpiObservation` null rule) are not expressible in JSON Schema and are
documented in the schema `description` instead; validate with the Zod schema when the rule
matters.

## Scripts

- `pnpm typecheck` / `pnpm lint`: `tsc --noEmit`
- `pnpm test`: `vitest run`
