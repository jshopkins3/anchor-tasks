# Questions for Brittni — MCM Platform Scoping

Date: 2026-04-17
Purpose: Clarify how MCM runs today so we can design the platform to match. These drive the data model and the build sequence.

**Overriding design goal:** Automate as much as possible. Every question below should be read with a follow-up in mind — *"and how could this be eliminated or reduced to an exception-handling workflow?"* Where possible, Brittni's answers should include what she spends time on today that she'd happily never do again.

**Format suggestion:** email the questions, then schedule a 30-min call to review answers + any follow-ups that surface.

---

## Section 1 — P&L and expense model

1. **Does MCM maintain a P&L for every LO, regardless of tenant type (W2 solo, W2 branch, DBA)?** Or only for DBAs?

2. If yes for everyone — is the goal primarily tax reporting, expense oversight, or operational visibility?

3. Are there any LO types that DON'T get a P&L or expense tracking?

4. Today, who prepares each LO's P&L — MCM Central, the LO themselves, or outsourced accountant?

5. On what cadence — monthly, bi-monthly (15th + last day like Anchor), quarterly?

---

## Section 2 — Corporate credit card program

6. **Which card provider does MCM use?** (Brex, Ramp, Divvy, Amex, Chase, multiple?)

7. Do all LOs get a corporate card, or only certain tenant types?

8. How are cards assigned — one per person, one per branch, shared?

9. What's the current process for expense categorization — does the provider auto-categorize, or does MCM do it manually?

10. Is there an approval workflow for charges over a threshold?

11. How do LOs submit receipts today — email, upload, physical?

12. Are any LOs expected to submit expenses outside the corporate card (e.g., mileage, home office, pre-paid items)?

13. Does the card provider offer API access? If so, who has the credentials?

---

## Section 3 — Arive access and data

14. **Is there one master Arive account that contains all 100 LOs' loans, or does each LO have their own Arive login?**

15. If one master — is filtering by Primary Loan Officer Name reliable, or do LOs sometimes share loans / get assigned wrong?

16. If separate logins — how is that managed today, and would MCM be willing to grant a platform-level API key?

17. Does MCM use Arive's team hierarchy feature (branches, divisions, roles)?

18. Are there any LOs not using Arive at all?

---

## Section 4 — Comp and payroll

19. **How are LO comp structures defined today — per LO, per branch, or standardized by role?**

20. Is there a master document or database of each LO's comp agreement, or is it tribal knowledge / HR files?

21. For W2 LOs, what's the pay flow — commission per file, salary + per file, draw against commission, straight salary?

22. For DBAs, does MCM pay gross comp with no withholding, or is anything withheld (e.g., loan costs, tech fees, CR costs netted out at payout)?

23. How often does payroll actually run — 15th + last day always, or other cadences for other tenants?

24. Today, how do LOs know their expected comp before a check arrives?

25. Has MCM ever had an issue with comp entered incorrectly into Arive causing downstream accounting problems? If yes — roughly how often, and how is it handled today?

---

## Section 5 — Per-file fees and centralized costs

26. **Are the per-file fees (Per File $495, Processing $700, Tech $500/mo) uniform across all LOs**, or do they vary by tenant type / agreement?

27. Are there any LOs who pay reduced or waived fees? Who decides?

28. For credit reports billed centrally — is the cost allocated to the originating LO, or absorbed by MCM HQ?

29. Same question for WVOE, CR services — centrally billed or LO-billed?

30. Are there any other recurring charges we should know about (E&O insurance, LOS license per-seat, ongoing compliance fees)?

---

## Section 6 — Broker check processing

31. **Today, what's the process when a title company sends a broker check to MCM?** (Who receives it, who logs it, where it's recorded)

32. How does MCM currently reconcile expected comp vs check received — spreadsheet, QuickBooks, by hand?

33. What's the typical variance rate? (% of checks that need investigation)

34. When checks don't match expected, what's the resolution process?

35. How long between check received and LO seeing the funds / being paid?

---

## Section 7 — Roles, access, and data privacy

36. **Who at MCM Central needs access to what?** (Jordan, Tristen, Brittni, others?)

37. Should W2 Branch managers see their whole branch's P&L, or just their own personal?

38. Should staff at a DBA see anything besides their own pay?

39. Are there any confidentiality concerns about one LO seeing another LO's data (even aggregate)?

40. Would DBA tenants want their platform view branded as their own DBA (Anchor Mortgage Group) or as MCM with their logo alongside?

---

## Section 8 — Onboarding and rollout

41. **If this platform existed today, which LOs would be first to roll out to?** (Simplest case, willing pilot, tech-friendly)

42. What's the onboarding process currently for a new LO joining MCM? How would the platform fit into that?

43. Are there any LOs who are actively unhappy with current tools we should prioritize for the pilot?

44. Timeline expectations — when does Jordan want to see a working prototype? When does he want it rolled out to the full network?

45. Is there budget allocated for this, or is it part of an existing platform investment?

---

## Section 9 — Ownership and commercial structure

46. **Who owns this platform architecturally** — is it being built AS Anchor's internal tool that MCM licenses, or AS MCM's platform that Anchor (tenant 1) happens to use?

47. How does the business relationship work — flat fee from MCM, per-LO per-month, built into existing per-file fees, equity / partnership?

48. If MCM ever separates from a DBA or LO, what happens to their data?

49. Are there any existing tools or vendors we should integrate with vs replace (QuickBooks, ADP, a CRM)?

50. What's Jordan's biggest operational pain point right now — the thing that if this platform solved, it'd justify everything else?

---

## Section 10 — Automation wish list

**This section matters most. The #1 design goal is to eliminate repetitive work wherever possible.**

51. **If you could delete 3 tasks from your calendar tomorrow, which 3?**

52. What do you currently do manually every day/week/month that you wish was automated?

53. Where do errors or rework happen today? (e.g., "LO enters comp wrong, I fix it on the back end" — those are automation targets)

54. What's a process that only works because you're the one doing it — and if you were out for a week, would fall apart?

55. What tools do you use beyond Arive — and would you prefer fewer tools with more automation, or keeping current tools but connected?

56. For each of these, how much time per week — rough estimate:
    - Processing broker checks received from title companies
    - Reconciling comp vs check amounts
    - Entering expenses / reviewing corporate card charges
    - Running / processing payroll
    - Responding to LO questions about their numbers
    - Generating reports for Jordan
    - Fixing data entry errors in Arive
    - Anything else that eats hours

## Section 11 — Anything else

57. What haven't we asked that you think matters?

58. Is there a specific LO profile or tenant case that's unusual that would break our assumptions?

59. Are there legal, compliance, or state-licensing constraints that affect how data can be shared across LOs?

---

## Suggested email framing

> *Hey Brittni,*
>
> *John here. Jordan and I have been talking about modernizing MCM's back-office platform — making things like P&L, payroll, expense tracking, and Arive integration cleaner across all our LOs. Before we go too far down a build path, I want to make sure we understand how things actually run today so we don't design around the wrong model.*
>
> *I've put together some questions below. Don't feel like you need to answer everything — skip what doesn't apply or isn't your area, and flag where we should loop Jordan or Tristen in. Once we have your initial thoughts, let's schedule a 30-minute call to review.*
>
> *Appreciate your time on this.*
>
> *— John*

---

**Priority questions** (if Brittni is short on time, start here):
- #1, #6, #14, #19, #26, #31, #36, #44, #46, #50, #51, #56

These give us enough to make the first round of design decisions — and #51 + #56 are the automation-target gold.
