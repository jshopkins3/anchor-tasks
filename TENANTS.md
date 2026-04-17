# Anchor Command — Multi-Tenant Model

**Status:** Draft v1. Pending clarification from Brittni (MCM Central) on several questions. See bottom of doc.

**Purpose:** Define the tenant model that allows Anchor Command to serve all ~100 MCM LOs from one platform, while respecting the different economic and employment structures across them.

## OVERRIDING DESIGN PRINCIPLE: AUTOMATE EVERYTHING POSSIBLE

Every feature, workflow, and data flow should be evaluated against one question first:

> **"Can a human be taken out of this loop?"**

If yes, automate. If no, understand why, and revisit later as tools improve. This platform succeeds when MCM Central staff (Jordan, Tristen, Brittni) spend their time on exceptions, not routine processing. LOs spend their time originating loans, not filling in forms. The platform is successful when it's invisible — work just happens.

Automation targets to hold the line on:

- **Revenue recognition** — Arive sync auto-populates every funded loan, no manual entry
- **Comp calculation** — deterministic from loan data, surfaced before submission and validated after
- **Expense capture** — card feed auto-ingests, auto-categorizes, auto-posts to P&L
- **Fee application** — recurring fees and per-file fees auto-apply based on tenant config
- **Broker check accounting** — check received triggers variance check against expected; human only sees exceptions
- **Payroll** — runs on schedule, emails itself to MCM, posts to P&L, no button presses
- **Compliance** — agents catch ECOA, TRID, comp variance without human review; escalate only exceptions
- **Credit report allocation** — central bill auto-splits to originating LOs based on Arive loan assignment
- **Tax reserve** — auto-calculated at 30% of net profit, running balance tracked
- **Reconciliation** — system flags variance, presents to human only when action required
- **Content / marketing** — briefings generate daily, personas dialogue, auto-publish low-risk content

Human-in-the-loop by design, not by default:

- Final approval on content going public (trust tiers earn auto-publish over time)
- Exception handling (variance > threshold, edge cases in comp)
- Strategic decisions (hiring, pricing, tenant-level config changes)
- External communication that involves relationship nuance

Everything else gets scheduled, triggered, or agent-driven.

---

## The big picture

Anchor Command is the operational OS for MCM's LO network. Every LO gets the same platform, scoped to their own data, with features tuned to their tenant type. Anchor Mortgage Group is tenant #1 (dogfooding); MCM Central is the admin tier; 99 more LOs roll in over time.

---

## Tenant types

There are **4 tenant types**, with important differences in employment model, tax treatment, and what financial flows the platform needs to support.

### 1. MCM Central

**Who:** Jordan Gerrard, Tristen, Brittni, any HQ admin staff.

**Employment:** W2 employees of MCM.

**Role:** Platform admin. Sees all tenants, runs payroll for all LOs, manages corporate billing (credit reports, card program), handles compliance oversight.

**Financial flows:**
- Aggregate revenue across all tenants
- Corporate overhead (HQ rent, tech stack, centralized services)
- Pass-through of per-file / tech / processing fees collected from LOs
- Central billing for credit reports (then allocates cost to originating LO)

**Platform view:**
- Admin dashboard (all tenants, aggregate P&L)
- Per-tenant drill-down
- Payroll roll-up
- Variance alerts across the network
- Onboarding / offboarding tools

---

### 2. W2 Solo LO

**Who:** Individual loan officers who work directly for MCM, no branch, no staff.

**Employment:** W2 employee of MCM.

**Role:** Originate loans. MCM handles everything else — payroll, taxes, branding, corporate services.

**Financial flows:**
- Revenue per funded loan (gross)
- Loan costs deducted: Tech Fee ($500/mo), Per File Fee ($495/file), Processing Fee ($700/file)
- Comp calculation per loan (varies by product type and LO's comp structure)
- Take-home = comp minus withheld payroll taxes (handled by MCM)
- No own payroll, no own operating expenses (except possibly corporate card charges)
- Tax reserve is N/A (W2 withholding handles it)

**Platform view:**
- Personal P&L showing revenue, loan costs, net comp, take-home
- Loan pipeline (their loans only)
- Corporate card transaction view (their charges)
- Compensation statements (per-period)
- No payroll tab (nothing to manage)
- No expense management UI (just view their card charges)

---

### 3. W2 Branch

**Who:** A branch manager + 1-2 staff (loan officer assistant, processor).

**Employment:** All W2 employees of MCM. Branch manager is the leader but all personnel on the branch are MCM employees.

**Role:** Same as Solo LO but with a small team. Branch manager may have slightly different comp structure (e.g., override on their team's volume).

**Financial flows:**
- Same revenue/cost flow as Solo LO
- Branch team comp flows through MCM payroll (MCM is the employer)
- Branch may have dedicated operating expenses (small office, branded marketing) paid via MCM corporate card or reimbursement
- Branch manager MAY have override comp on team volume

**Platform view:**
- Branch dashboard (branch-wide P&L: all LOs in branch combined)
- Per-LO view within the branch
- Team roster (managers see their team's comp; team members see their own only)
- Shared corporate card transaction view
- No own payroll management UI (MCM runs it)

---

### 4. DBA (Independent 1099)

**Who:** Independent operators with their own brand, their own staff, their own identity. Anchor Mortgage Group is a DBA.

**Employment:** DBA owner is 1099 (independent contractor of MCM). DBA staff are employees of the DBA, NOT MCM.

**Role:** Run their own business. MCM provides the license rails, Arive access, lender relationships, and back-office (check processing, credit reports). DBA handles their own operations, payroll, branding.

**Financial flows:**
- Revenue flows same as other tenants (Arive → platform)
- Loan costs deducted same way (Tech Fee, Per File Fee, Processing Fee)
- Gross comp paid to DBA owner (1099, no withholding)
- DBA owner pays their own staff payroll
- DBA owner pays operating expenses (rent, insurance, CRM, office supplies, etc.)
- Net Profit = Revenue - Loan Costs - Expenses - Staff Payroll
- Draws and tax reserve are self-managed (30% tax reserve is the platform default)
- Own carry-over balance
- Own year-end tax prep

**Platform view:**
- Full P&L (the current Anchor Command P&L is this template)
- Payroll center for their own staff
- Expense management (both corporate card charges from MCM + DBA-specific expenses they paid from their own accounts)
- Tax reserve tracker
- Draws management
- Their own branded content (brand voice, agent database, marketing engine)
- Reconciliation tab (their actual MCM deposits vs system proforma)

---

## Tenant data model

```json
{
  "id": "tenant_001",
  "type": "dba" | "w2_solo" | "w2_branch" | "mcm_central",
  "name": "Anchor Mortgage Group",
  "legalName": "Anchor Mortgage Group DBA My Community Mortgage",
  "nmls": "2408499",
  "parentTenantId": "mcm_central",

  "employmentModel": "1099" | "w2",
  "ownsPayroll": true | false,
  "taxTreatment": "self-managed" | "withheld",
  "hasOwnExpenses": true | false,

  "arive": {
    "filterBy": "primaryLoanOfficerName",
    "filterValue": "John Hopkins III",
    "additionalFilters": []
  },

  "compStructure": {
    "nondel": { "type": "ysp_plus_points", "ysp": "from_price", "discountPoints": true, "crWvoe": true },
    "broker_lpc": { "type": "flat_percent", "percent": 2.75, "specialCases": { "rocket_refi": 1.75 } },
    "broker_bpc": { "type": "arive_originator_comp", "crWvoe": true }
  },

  "recurringFees": [
    { "name": "Tech Fee", "amount": 500, "cadence": "monthly", "startDate": "2025-08-01", "endDate": null, "active": true }
  ],

  "perFileFees": [
    { "name": "Per File Fee", "amount": 495, "appliesTo": "all_closed" },
    { "name": "Processing Fee", "amount": 700, "appliesTo": "all_closed" }
  ],

  "personnel": [
    // only for DBAs — W2 tenants have no own roster
  ],

  "branding": {
    "displayName": "Anchor Mortgage Group",
    "logo": "/tenant-logos/anchor.svg",
    "primaryColor": "#0a1628",
    "accentColor": "#d4af37",
    "showAsMCM": false
  },

  "users": [
    { "email": "john@myanchormortgage.com", "role": "owner" },
    { "email": "brenda@mychomeloans.com", "role": "staff" },
    { "email": "corey@myanchormortgage.com", "role": "staff" },
    { "email": "kat@myanchormortgage.com", "role": "staff" }
  ],

  "createdAt": "2025-08-01",
  "status": "active"
}
```

---

## Permission matrix

| Role | Scope | Can view | Can edit |
|---|---|---|---|
| **MCM Central admin** | All tenants | Everything | Everything |
| **DBA owner** | Own tenant | Full P&L, own staff, own loans | Everything within tenant |
| **DBA staff** | Own tenant | Own loans, own comp history | Nothing admin |
| **W2 Branch manager** | Own branch | Branch P&L, team comp | Nothing admin (view-only, requests go to MCM) |
| **W2 Branch staff** | Own person | Own comp, own loans | Nothing |
| **W2 Solo LO** | Own person | Own P&L, own loans | Own compensation structure? (TBD with Brittni) |

---

## The 6 basics — mapped to tenant types

From the session planning:

### Basic 1 — Revenue flows through Arive
**All tenant types.** Same Arive sync, filtered per tenant. No type differences.

### Basic 2 — Non-Del comp adjustments
**All tenant types.** `compStructure` per tenant drives the calculation. Already handled by `computeComp()` pattern from Anchor.

### Basic 3 — Broker check received validation
**All tenant types, but especially DBAs.** DBAs track this most carefully (reconciliation tab). W2 tenants still see check-received status but don't do the full variance analysis — MCM handles that on their behalf.

### Basic 4 — Payroll
**DBAs:** own roster, own payroll runs, own MCM email. W2 tenants: N/A — they're on MCM payroll directly. MCM Central: rolls up DBA payroll submissions + processes all W2 LO comp.

### Basic 5 — Correct comp entered into Arive
**All tenant types.** Compliance agent checks variance for every loan regardless of tenant. Pre-submission calculator available for all LOs.

### Basic 6 — Expenses + card integration
**All tenant types but different scope:**
- W2 tenants: see their corporate card charges. No self-paid expenses.
- DBAs: both corporate card charges AND self-paid expenses (rent, insurance, etc.)
- MCM Central: aggregate view of all spending, plus corporate overhead

---

## Data isolation strategy

**Option A — Shared database, tenant_id column on every record.**
- One file/database, filtered queries by tenant_id
- Simpler infra, easier to aggregate across tenants
- Requires disciplined query scoping (every query includes WHERE tenant_id = ...)
- Single point of failure; accidental data leak possible if a query forgets the filter

**Option B — Separate data files per tenant.**
- `data/tenants/tenant_001/loans.json`, `tenants/tenant_001/tasks.json`, etc.
- Stronger isolation by default
- MCM Central aggregation requires explicit union across files
- More files to manage, harder backup

**Recommended for v1: Option A** with strict scoping conventions + an audit log when anything is read across tenant boundaries. MCM Central is the only role allowed cross-tenant reads. Every API endpoint enforces tenant_id at the session level.

---

## Migration plan (high level)

1. Introduce tenant model and tenant registry (`data/tenants.json`)
2. Seed with tenant #1 = Anchor Mortgage Group (DBA type), tenant #2 = MCM Central (admin type)
3. Add `tenantId` to existing records (loans, personnel, expenses, payroll runs, P&L entries, briefings, content, tasks)
4. Backfill: assume everything currently in the system is Anchor's (tenant #1)
5. Add tenant scoping to every API endpoint — session carries tenantId, queries filter by it
6. Build MCM Central admin UI with cross-tenant visibility
7. Build W2 Solo/Branch simplified views
8. Pilot with one non-Anchor LO
9. Iterate on UX
10. Roll out to remaining tenants in waves

---

## Open questions (pending Brittni's input)

See `MCM_QUESTIONS_FOR_BRITTNI.md`.

---

**Last updated:** 2026-04-17 (initial draft)
**Owner:** John Hopkins
**Status:** Draft — not yet approved by MCM Central
