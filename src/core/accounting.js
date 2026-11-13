const EPSILON = 0.000001;
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}


export function filterEntriesByDate(entries, filters = {}) {
  if (!Array.isArray(entries)) throw new Error("قائمة القيود غير صالحة.");
  const fromDate = filters.fromDate || "";
  const toDate = filters.toDate || "";
  if (fromDate && !validDate(fromDate)) throw new Error("تاريخ بداية التقرير غير صالح.");
  if (toDate && !validDate(toDate)) throw new Error("تاريخ نهاية التقرير غير صالح.");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("تاريخ بداية التقرير يجب ألا يتجاوز تاريخ النهاية.");
  }
  for (const entry of entries) {
    if (entry?.status === "posted" && !validDate(entry.date)) {
      throw new Error("يوجد قيد مرحل بتاريخ غير صالح: " + String(entry.reference || ""));
    }
  }
  return entries.filter((entry) =>
    entry?.status === "posted" &&
    (!fromDate || entry.date >= fromDate) &&
    (!toDate || entry.date <= toDate)
  );
}

export function validateJournal(entry, accounts) {
  if (!entry || !validDate(entry.date)) throw new Error("تاريخ القيد غير صالح.");
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) throw new Error("يجب أن يحتوي القيد على سطرين على الأقل.");
  const byCode = new Map(accounts.map((account) => [String(account.code), account]));
  const totals = new Map();
  for (const line of entry.lines) {
    const account = byCode.get(String(line.accountCode));
    if (!account) throw new Error("الحساب " + line.accountCode + " غير موجود.");
    if (account.is_active === 0 || account.is_postable === 0) throw new Error("لا يمكن الترحيل إلى حساب غير نشط أو تجميعي: " + line.accountCode);
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) throw new Error("قيمة المدين أو الدائن غير صالحة.");
    if (debit > 0 && credit > 0) throw new Error("لا يجوز أن يكون السطر مديناً ودائناً في الوقت نفسه.");
    if (debit === 0 && credit === 0) throw new Error("لا يجوز وجود سطر بقيمة صفرية.");
    if (!line.currency || typeof line.currency !== "string") throw new Error("عملة القيد مطلوبة.");
    const total = totals.get(line.currency) || { debit: 0, credit: 0 };
    total.debit = round(total.debit + debit);
    total.credit = round(total.credit + credit);
    totals.set(line.currency, total);
  }
  for (const [currency, total] of totals) {
    if (Math.abs(total.debit - total.credit) > EPSILON) {
      throw new Error("القيد غير متوازن بعملة " + currency + ": المدين " + total.debit + " والدائن " + total.credit + ".");
    }
  }
  return { valid: true, totals: Object.fromEntries(totals) };
}

export function trialBalance(entries, accounts, currency) {
  if (!currency) throw new Error("حدد العملة لعرض ميزان المراجعة.");
  const sums = new Map(accounts.map((a) => [String(a.code), { debit: 0, credit: 0 }]));
  for (const entry of entries.filter((e) => e.status === "posted")) {
    for (const line of entry.lines) {
      if (line.currency !== currency) continue;
      const sum = sums.get(String(line.accountCode));
      if (!sum) throw new Error("يوجد قيد مرتبط بحساب غير موجود: " + line.accountCode);
      sum.debit = round(sum.debit + Number(line.debit || 0));
      sum.credit = round(sum.credit + Number(line.credit || 0));
    }
  }
  return accounts.map((a) => {
    const sum = sums.get(String(a.code));
    return { code: a.code, name: a.name, type: a.type, debit: sum.debit, credit: sum.credit, balance: round(sum.debit - sum.credit) };
  });
}

export function generalLedger(entries, accountCode, currency) {
  const rows = [];
  let balance = 0;
  const sorted = entries.filter((e) => e.status === "posted").slice().sort((a, b) =>
    a.date.localeCompare(b.date) || String(a.reference).localeCompare(String(b.reference))
  );
  for (const entry of sorted) {
    for (const line of entry.lines) {
      if (String(line.accountCode) !== String(accountCode) || line.currency !== currency) continue;
      balance = round(balance + Number(line.debit || 0) - Number(line.credit || 0));
      rows.push({ date: entry.date, reference: entry.reference, memo: line.memo || entry.memo || "", debit: Number(line.debit || 0), credit: Number(line.credit || 0), balance });
    }
  }
  return rows;
}

export function taxPosition(salesRows = [], purchaseRows = [], salesReturnRows = [], purchaseReturnRows = []) {
  if (![salesRows, purchaseRows, salesReturnRows, purchaseReturnRows].every(Array.isArray)) {
    throw new Error("بيانات ملخص الضريبة غير صالحة.");
  }
  const positions = new Map();
  const add = (rows, field, sign) => {
    for (const row of rows) {
      const currency = String(row.currency_code || row.currency || "").trim();
      const amount = Number(row.tax_total ?? row.tax ?? 0);
      if (!currency || !Number.isFinite(amount) || amount < 0) {
        throw new Error("عملة أو مبلغ ضريبة غير صالح في ملخص الضريبة.");
      }
      const position = positions.get(currency) || { currency, salesTax: 0, purchaseTax: 0 };
      position[field] = round(position[field] + sign * amount);
      positions.set(currency, position);
    }
  };
  add(salesRows, "salesTax", 1);
  add(salesReturnRows, "salesTax", -1);
  add(purchaseRows, "purchaseTax", 1);
  add(purchaseReturnRows, "purchaseTax", -1);
  return [...positions.values()].map((position) => ({
    ...position,
    netPayable: round(position.salesTax - position.purchaseTax)
  })).sort((a, b) => a.currency.localeCompare(b.currency));
}

export function incomeStatement(entries, accounts, currency) {
  const tb = trialBalance(entries, accounts, currency);
  let revenue = 0;
  let expenses = 0;
  for (const row of tb) {
    if (row.type === "revenue") revenue += row.credit - row.debit;
    if (row.type === "expense") expenses += row.debit - row.credit;
  }
  revenue = round(revenue);
  expenses = round(expenses);
  return { currency, revenue, expenses, netIncome: round(revenue - expenses) };
}

export function balanceSheet(entries, accounts, currency) {
  const tb = trialBalance(entries, accounts, currency);
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  for (const row of tb) {
    if (row.type === "asset") assets += row.debit - row.credit;
    if (row.type === "liability") liabilities += row.credit - row.debit;
    if (row.type === "equity") equity += row.credit - row.debit;
  }
  const netIncome = incomeStatement(entries, accounts, currency).netIncome;
  return {
    currency,
    assets: round(assets),
    liabilities: round(liabilities),
    equity: round(equity + netIncome),
    netIncome,
    liabilitiesAndEquity: round(liabilities + equity + netIncome),
    balanced: Math.abs(assets - liabilities - equity - netIncome) <= EPSILON
  };
}

export function cashFlow(entries, accounts, cashAccountCodes, currency) {
  const accountByCode = new Map(accounts.map((a) => [String(a.code), a]));
  const cashCodes = new Set(cashAccountCodes.map(String));
  const result = { operating: 0, investing: 0, financing: 0, netChange: 0, currency };

  for (const entry of entries.filter((e) => e.status === "posted")) {
    const lines = entry.lines.filter((line) => line.currency === currency);
    const cashDelta = lines.reduce((sum, line) => {
      if (!cashCodes.has(String(line.accountCode))) return sum;
      return sum + Number(line.debit || 0) - Number(line.credit || 0);
    }, 0);
    if (Math.abs(cashDelta) <= EPSILON) continue;

    // Allocate the journal's net cash movement across every non-cash counterpart.
    // This handles split postings (for example operating expense + fixed asset).
    const counterparts = lines
      .filter((line) => !cashCodes.has(String(line.accountCode)))
      .map((line) => ({
        line,
        weight: Math.abs(Number(line.debit || 0) - Number(line.credit || 0))
      }))
      .filter((item) => item.weight > EPSILON);
    const totalWeight = counterparts.reduce((sum, item) => sum + item.weight, 0);

    if (totalWeight <= EPSILON) {
      result.operating += cashDelta;
    } else {
      let allocated = 0;
      counterparts.forEach(({ line, weight }, index) => {
        const amount = index === counterparts.length - 1
          ? round(cashDelta - allocated)
          : round(cashDelta * weight / totalWeight);
        allocated = round(allocated + amount);
        const account = accountByCode.get(String(line.accountCode));
        const requestedCategory = account?.cashFlowCategory || account?.cash_flow_category || "operating";
        const category = ["operating", "investing", "financing"].includes(requestedCategory)
          ? requestedCategory
          : "operating";
        result[category] += amount;
      });
    }
    result.netChange += cashDelta;
  }

  result.operating = round(result.operating);
  result.investing = round(result.investing);
  result.financing = round(result.financing);
  result.netChange = round(result.netChange);
  return result;
}

export function movingAverageCost(openingQuantity, openingValue, movements) {
  let quantity = Number(openingQuantity);
  let value = Number(openingValue);
  if (!Number.isFinite(quantity) || !Number.isFinite(value) || quantity < 0 || value < 0) {
    throw new Error("رصيد المخزون الافتتاحي غير صالح.");
  }
  for (const movement of movements) {
    const incoming = Number(movement.quantityIn || 0);
    const outgoing = Number(movement.quantityOut || 0);
    const unitCost = Number(movement.unitCost || 0);
    if ([incoming, outgoing, unitCost].some((n) => !Number.isFinite(n) || n < 0) || (incoming > 0 && outgoing > 0)) {
      throw new Error("حركة مخزون غير صالحة.");
    }
    if (incoming > 0) {
      quantity += incoming;
      value += incoming * unitCost;
    }
    if (outgoing > 0) {
      if (outgoing - quantity > EPSILON) throw new Error("الكمية المطلوبة أكبر من المخزون المتاح.");
      const average = quantity > 0 ? value / quantity : 0;
      quantity -= outgoing;
      value -= outgoing * average;
    }
  }
  return { quantity: round(quantity), value: round(value), averageCost: quantity > 0 ? round(value / quantity) : 0 };
}

export function buildSalesJournal(invoice, mapping) {
  const net = round(Number(invoice.subtotal) - Number(invoice.discount || 0));
  const tax = round(Number(invoice.tax || 0));
  const total = round(net + tax);
  if (!(net >= 0) || !(tax >= 0) || !(total > 0)) throw new Error("إجمالي فاتورة البيع غير صالح.");
  const lines = [
    { accountCode: mapping.receivable, debit: total, credit: 0, currency: invoice.currency },
    { accountCode: mapping.revenue, debit: 0, credit: net, currency: invoice.currency }
  ];
  if (tax > 0) lines.push({ accountCode: mapping.taxPayable, debit: 0, credit: tax, currency: invoice.currency });
  if (Number(invoice.costOfGoods || 0) > 0) {
    lines.push({ accountCode: mapping.cogs, debit: Number(invoice.costOfGoods), credit: 0, currency: invoice.currency });
    lines.push({ accountCode: mapping.inventory, debit: 0, credit: Number(invoice.costOfGoods), currency: invoice.currency });
  }
  return { date: invoice.date, reference: invoice.reference, memo: invoice.memo || "فاتورة مبيعات", status: "draft", lines };
}

export function buildPurchaseJournal(invoice, mapping) {
  const net = round(Number(invoice.subtotal));
  const tax = round(Number(invoice.tax || 0));
  const total = round(net + tax);
  if (!(net > 0) || !(tax >= 0) || !(total > 0)) throw new Error("إجمالي فاتورة الشراء غير صالح.");
  const lines = [
    { accountCode: mapping.inventory, debit: net, credit: 0, currency: invoice.currency },
    { accountCode: mapping.payable, debit: 0, credit: total, currency: invoice.currency }
  ];
  if (tax > 0) {
    lines.splice(1, 0, { accountCode: mapping.inputTax, debit: tax, credit: 0, currency: invoice.currency });
  }
  return { date: invoice.date, reference: invoice.reference, memo: invoice.memo || "فاتورة مشتريات", status: "draft", lines };
}