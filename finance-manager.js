// Finance Manager — Personal finance tracking, CSV import, budgeting, salary planning
// Accounts: checking, savings, credit cards
// AI-powered transaction categorization

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "data");
const FINANCE_FILE = path.join(DATA_DIR, "finance.json");
const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || "";

// ─── Default Categories ────────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { id: "housing", name: "Housing", icon: "🏠", color: "#3b82f6" },
  { id: "utilities", name: "Utilities", icon: "⚡", color: "#f59e0b" },
  { id: "groceries", name: "Groceries", icon: "🛒", color: "#22c55e" },
  { id: "dining", name: "Dining & Restaurants", icon: "🍽️", color: "#ef4444" },
  { id: "transport", name: "Transportation", icon: "🚗", color: "#8b5cf6" },
  { id: "gas", name: "Gas & Fuel", icon: "⛽", color: "#6366f1" },
  { id: "insurance", name: "Insurance", icon: "🛡️", color: "#0ea5e9" },
  { id: "healthcare", name: "Healthcare", icon: "🏥", color: "#ec4899" },
  { id: "subscriptions", name: "Subscriptions", icon: "📱", color: "#a855f7" },
  { id: "shopping", name: "Shopping", icon: "🛍️", color: "#f97316" },
  { id: "entertainment", name: "Entertainment", icon: "🎬", color: "#14b8a6" },
  { id: "education", name: "Education", icon: "📚", color: "#6366f1" },
  { id: "personal", name: "Personal Care", icon: "💇", color: "#ec4899" },
  { id: "kids", name: "Kids & Family", icon: "👶", color: "#f472b6" },
  { id: "pets", name: "Pets", icon: "🐕", color: "#a3e635" },
  { id: "gifts", name: "Gifts & Donations", icon: "🎁", color: "#fb923c" },
  { id: "travel", name: "Travel", icon: "✈️", color: "#38bdf8" },
  { id: "business", name: "Business Expense", icon: "💼", color: "#1e40af" },
  { id: "income", name: "Income", icon: "💰", color: "#16a34a" },
  { id: "transfer", name: "Transfer", icon: "🔄", color: "#6b7280" },
  { id: "debt", name: "Debt Payment", icon: "💳", color: "#dc2626" },
  { id: "savings", name: "Savings", icon: "🏦", color: "#0d9488" },
  { id: "other", name: "Other", icon: "📌", color: "#94a3b8" },
];

// ─── Data CRUD ──────────────────────────────────────────────────────

function loadFinance() {
  try { return JSON.parse(fs.readFileSync(FINANCE_FILE, "utf8")); }
  catch {
    return {
      accounts: [],
      transactions: [],
      categories: DEFAULT_CATEGORIES,
      budgets: [],
      salary: { monthly: 0, notes: "" },
    };
  }
}

function saveFinance(data) {
  fs.writeFileSync(FINANCE_FILE, JSON.stringify(data, null, 2));
}

// ─── Account Management ─────────────────────────────────────────────

function addAccount(data) {
  const fin = loadFinance();
  const account = {
    id: `acct-${Date.now().toString(36)}`,
    name: data.name,
    type: ["checking", "savings", "credit"].includes(data.type) ? data.type : "checking",
    lastFour: data.lastFour || "",
    institution: data.institution || "",
    createdAt: new Date().toISOString(),
  };
  fin.accounts.push(account);
  saveFinance(fin);
  return account;
}

function getAccounts() {
  return loadFinance().accounts;
}

// ─── CSV Parsing ────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const header = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row = {};
    header.forEach((h, j) => { row[h] = (vals[j] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// Detect column mapping from CSV headers
function detectColumnMapping(headers) {
  const lower = headers.map(h => h.toLowerCase().trim());
  const mapping = { date: null, description: null, amount: null, debit: null, credit: null, balance: null, type: null };

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (!mapping.date && (h.includes("date") || h === "posted" || h.includes("post"))) mapping.date = i;
    if (!mapping.description && (h.includes("description") || h.includes("memo") || h.includes("payee") || h.includes("merchant") || h.includes("name") || h.includes("detail"))) mapping.description = i;
    if (!mapping.amount && (h === "amount" || h.includes("transaction amount"))) mapping.amount = i;
    if (!mapping.debit && (h.includes("debit") || h.includes("withdrawal") || h.includes("charge"))) mapping.debit = i;
    if (!mapping.credit && (h.includes("credit") || h.includes("deposit") || h.includes("payment"))) mapping.credit = i;
    if (!mapping.balance && (h.includes("balance") || h.includes("running"))) mapping.balance = i;
    if (!mapping.type && (h === "type" || h.includes("transaction type"))) mapping.type = i;
  }

  return mapping;
}

function importCSV(csvText, accountId) {
  const fin = loadFinance();
  const rows = parseCSV(csvText);
  if (!rows.length) return { imported: 0, error: "No rows found" };

  const headers = Object.keys(rows[0]);
  const mapping = detectColumnMapping(headers);

  const transactions = [];
  const existingDates = new Set(fin.transactions.filter(t => t.accountId === accountId).map(t => t.date + t.description + t.amount));

  for (const row of rows) {
    const vals = Object.values(row);

    // Get date
    let date = mapping.date !== null ? vals[mapping.date] : "";
    if (!date) continue;
    // Normalize date to YYYY-MM-DD
    date = normalizeDate(date);
    if (!date) continue;

    // Get description
    const description = mapping.description !== null ? vals[mapping.description] : Object.values(row).find(v => v && v.length > 3 && !/^[\d.,\-$]+$/.test(v)) || "";

    // Get amount
    let amount = 0;
    if (mapping.amount !== null) {
      amount = parseAmount(vals[mapping.amount]);
    } else if (mapping.debit !== null || mapping.credit !== null) {
      const debit = mapping.debit !== null ? parseAmount(vals[mapping.debit]) : 0;
      const credit = mapping.credit !== null ? parseAmount(vals[mapping.credit]) : 0;
      amount = credit > 0 ? credit : -debit;
    }
    if (amount === 0) continue;

    // Dedup check
    const key = date + description + amount;
    if (existingDates.has(key)) continue;
    existingDates.add(key);

    transactions.push({
      id: `txn-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
      accountId,
      date,
      description: description.substring(0, 200),
      amount: Math.round(amount * 100) / 100,
      category: null, // Will be AI-categorized
      categoryOverride: false,
      importedAt: new Date().toISOString(),
    });
  }

  fin.transactions.push(...transactions);
  fin.transactions.sort((a, b) => b.date.localeCompare(a.date));
  saveFinance(fin);

  return { imported: transactions.length, total: fin.transactions.length };
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  // Try MM/DD/YYYY
  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  // Try MM/DD/YY
  const mdy2 = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdy2) return `20${mdy2[3]}-${mdy2[1].padStart(2, "0")}-${mdy2[2].padStart(2, "0")}`;
  // Try M-D-YYYY
  const mdy3 = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mdy3) return `${mdy3[3]}-${mdy3[1].padStart(2, "0")}-${mdy3[2].padStart(2, "0")}`;
  return null;
}

function parseAmount(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[$,\s]/g, "").replace(/\((.+)\)/, "-$1");
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : num;
}

// ─── AI Categorization ──────────────────────────────────────────────

async function categorizeTransactions(transactions) {
  const key = ANTHROPIC_API_KEY();
  if (!key) return transactions;

  const uncategorized = transactions.filter(t => !t.category && !t.categoryOverride);
  if (!uncategorized.length) return transactions;

  // Batch in groups of 50
  const batches = [];
  for (let i = 0; i < uncategorized.length; i += 50) {
    batches.push(uncategorized.slice(i, i + 50));
  }

  const categoryIds = DEFAULT_CATEGORIES.map(c => c.id).join(", ");

  for (const batch of batches) {
    const txnList = batch.map((t, i) => `${i}: "${t.description}" $${t.amount}`).join("\n");

    try {
      const body = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [{ role: "user", content: `Categorize these bank transactions. Available categories: ${categoryIds}\n\nRespond with ONLY a JSON array of category IDs in order, one per transaction. No explanation.\n\nTransactions:\n${txnList}` }],
      });

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        }, res => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const categories = JSON.parse(match[0]);
        batch.forEach((t, i) => {
          if (categories[i] && DEFAULT_CATEGORIES.some(c => c.id === categories[i])) {
            t.category = categories[i];
          } else {
            t.category = "other";
          }
        });
      }
    } catch (e) {
      console.error("[finance] AI categorization error:", e.message);
      batch.forEach(t => { if (!t.category) t.category = "other"; });
    }
  }

  return transactions;
}

// ─── Analytics ──────────────────────────────────────────────────────

function getMonthlyBreakdown(accountId, month) {
  const fin = loadFinance();
  let txns = fin.transactions;
  if (accountId) txns = txns.filter(t => t.accountId === accountId);
  if (month) txns = txns.filter(t => t.date.substring(0, 7) === month);

  const byCategory = {};
  let totalIncome = 0, totalExpenses = 0;

  for (const t of txns) {
    const cat = t.category || "other";
    if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0, transactions: [] };
    byCategory[cat].total += t.amount;
    byCategory[cat].count++;
    byCategory[cat].transactions.push({ date: t.date, description: t.description, amount: t.amount });

    if (t.amount > 0) totalIncome += t.amount;
    else totalExpenses += Math.abs(t.amount);
  }

  return {
    month: month || "all",
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    net: Math.round((totalIncome - totalExpenses) * 100) / 100,
    byCategory,
    transactionCount: txns.length,
  };
}

function getMonthlyTrends(accountId, months) {
  const fin = loadFinance();
  let txns = fin.transactions;
  if (accountId) txns = txns.filter(t => t.accountId === accountId);

  // Get unique months
  const allMonths = [...new Set(txns.map(t => t.date.substring(0, 7)))].sort().slice(-(months || 6));

  return allMonths.map(m => {
    const monthTxns = txns.filter(t => t.date.substring(0, 7) === m);
    const income = monthTxns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const expenses = monthTxns.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
    return { month: m, income: Math.round(income), expenses: Math.round(expenses), net: Math.round(income - expenses), count: monthTxns.length };
  });
}

// ─── Budget Management ──────────────────────────────────────────────

function setBudget(categoryId, monthlyLimit) {
  const fin = loadFinance();
  const idx = fin.budgets.findIndex(b => b.categoryId === categoryId);
  if (idx >= 0) {
    fin.budgets[idx].monthlyLimit = monthlyLimit;
    fin.budgets[idx].updatedAt = new Date().toISOString();
  } else {
    fin.budgets.push({ categoryId, monthlyLimit, createdAt: new Date().toISOString() });
  }
  saveFinance(fin);
}

function getBudgetStatus(month) {
  const fin = loadFinance();
  const currentMonth = month || new Date().toISOString().substring(0, 7);
  const txns = fin.transactions.filter(t => t.date.substring(0, 7) === currentMonth && t.amount < 0);

  return fin.budgets.map(b => {
    const spent = Math.abs(txns.filter(t => t.category === b.categoryId).reduce((s, t) => s + t.amount, 0));
    const cat = DEFAULT_CATEGORIES.find(c => c.id === b.categoryId);
    return {
      category: cat?.name || b.categoryId,
      icon: cat?.icon || "📌",
      limit: b.monthlyLimit,
      spent: Math.round(spent * 100) / 100,
      remaining: Math.round((b.monthlyLimit - spent) * 100) / 100,
      percent: b.monthlyLimit > 0 ? Math.round((spent / b.monthlyLimit) * 100) : 0,
      over: spent > b.monthlyLimit,
    };
  });
}

// ─── Salary Planner ─────────────────────────────────────────────────

function getSalaryPlan() {
  const fin = loadFinance();
  return fin.salary || { monthly: 0, notes: "" };
}

function setSalaryPlan(monthly, notes) {
  const fin = loadFinance();
  fin.salary = { monthly, notes: notes || "", updatedAt: new Date().toISOString() };
  saveFinance(fin);
  return fin.salary;
}

module.exports = {
  DEFAULT_CATEGORIES,
  loadFinance,
  saveFinance,
  addAccount,
  getAccounts,
  importCSV,
  categorizeTransactions,
  getMonthlyBreakdown,
  getMonthlyTrends,
  setBudget,
  getBudgetStatus,
  getSalaryPlan,
  setSalaryPlan,
};
