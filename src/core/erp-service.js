import { validateJournal, movingAverageCost } from "./accounting.js";

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const positive = (n, label) => {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) throw new Error(label + " يجب أن يكون أكبر من صفر.");
  return value;
};
const required = (value, label) => {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(label + " مطلوب.");
  return value;
};
const validIsoDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export class ErpService {
  constructor(database) {
    this.db = database;
  }

  async optionalNumber(value, table, prefix) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    const rows = await this.db.query("SELECT COALESCE(MAX(id),0)+1 AS next_id FROM " + table);
    return prefix + "-" + String(rows[0]?.next_id || 1).padStart(6, "0");
  }

  async createParty(data) {
    data.code = await this.optionalNumber(data.code, "parties", "PTY");
    required(data.name, "اسم الطرف");
    if (!["customer", "supplier", "both"].includes(data.type)) throw new Error("نوع الطرف غير صالح.");
    return this.db.run(
      "INSERT INTO parties(party_code,name_ar,party_type,phone,address,tax_number,receivable_account_id,payable_account_id) VALUES(?,?,?,?,?,?,(SELECT id FROM accounts WHERE code='1200'),(SELECT id FROM accounts WHERE code='2100'))",
      [String(data.code).trim(), String(data.name).trim(), data.type, data.phone || "", data.address || "", data.taxNumber || ""]
    );
  }

  async createWarehouse(data) {
    data.code = await this.optionalNumber(data.code, "warehouses", "WH");
    required(data.name, "اسم المستودع");
    return this.db.run("INSERT INTO warehouses(code,name_ar,address) VALUES(?,?,?)",
      [String(data.code).trim(), String(data.name).trim(), data.address || ""]);
  }

  async createProduct(data) {
    data.sku = await this.optionalNumber(data.sku, "products", "SKU");
    required(data.name, "اسم المنتج");
    const cost = Number(data.purchaseCost || 0);
    const price = Number(data.salePrice || 0);
    const taxRate = Number(data.taxRate || 0);
    if (![cost, price, taxRate].every(Number.isFinite) || cost < 0 || price < 0 || taxRate < 0 || taxRate > 100) {
      throw new Error("بيانات تكلفة أو سعر أو ضريبة المنتج غير صالحة.");
    }
    return this.db.run(
      "INSERT INTO products(sku,name_ar,barcode,unit,purchase_cost,sale_price,tax_rate,inventory_account_id,revenue_account_id,cogs_account_id,is_service) VALUES(?,?,?,?,?,?,?,(SELECT id FROM accounts WHERE code='1300'),(SELECT id FROM accounts WHERE code='4100'),(SELECT id FROM accounts WHERE code='5100'),?)",
      [String(data.sku).trim(), String(data.name).trim(), data.barcode || "", data.unit || "قطعة", cost, price, taxRate, data.isService ? 1 : 0]
    );
  }

  async stockBalance(productId, warehouseId) {
    const movements = await this.db.query(
      "SELECT quantity_in AS quantityIn,quantity_out AS quantityOut,unit_cost AS unitCost FROM stock_movements WHERE product_id=? AND warehouse_id=? ORDER BY movement_date,id",
      [productId, warehouseId]
    );
    return movingAverageCost(0, 0, movements);
  }

  async createSalesInvoice(invoice) {
    invoice.number = await this.optionalNumber(invoice.number, "sales_invoices", "SI");
    required(invoice.date, "تاريخ الفاتورة");
    positive(invoice.partyId, "العميل");
    positive(invoice.warehouseId, "المستودع");
    required(invoice.currency, "العملة");
    if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) throw new Error("أضف صنفاً واحداً على الأقل إلى الفاتورة.");

    const parties = await this.db.query("SELECT p.*,ra.code AS receivable_code,pa.code AS payable_code FROM parties p LEFT JOIN accounts ra ON ra.id=p.receivable_account_id LEFT JOIN accounts pa ON pa.id=p.payable_account_id WHERE p.id=? AND p.is_active=1", [invoice.partyId]);
    const party = parties[0];
    if (!party || !["customer", "both"].includes(party.party_type)) throw new Error("الطرف المحدد ليس عميلاً نشطاً.");
    const currency = await this.db.query("SELECT code FROM currencies WHERE code=? AND is_active=1", [invoice.currency]);
    if (!currency.length) throw new Error("العملة غير معرفة أو غير نشطة.");

    const productRows = [];
    const stockSnapshots = new Map();
    const reservedStock = new Map();
    let subtotal = 0, discountTotal = 0, taxTotal = 0, costTotal = 0;
    for (const input of invoice.lines) {
      const quantity = positive(input.quantity, "الكمية");
      const rows = await this.db.query(
        "SELECT p.*,ia.code AS inventory_code,ra.code AS revenue_code,ca.code AS cogs_code FROM products p LEFT JOIN accounts ia ON ia.id=p.inventory_account_id LEFT JOIN accounts ra ON ra.id=p.revenue_account_id LEFT JOIN accounts ca ON ca.id=p.cogs_account_id WHERE p.id=? AND p.is_active=1",
        [input.productId]
      );
      const product = rows[0];
      if (!product) throw new Error("يوجد منتج غير موجود أو غير نشط.");
      const unitPrice = Number(input.unitPrice ?? product.sale_price);
      const discount = Number(input.discount || 0);
      const taxRate = Number(input.taxRate ?? product.tax_rate);
      if (![unitPrice, discount, taxRate].every(Number.isFinite) || unitPrice < 0 || discount < 0 || discount > quantity * unitPrice || taxRate < 0 || taxRate > 100) {
        throw new Error("سعر أو خصم أو ضريبة أحد الأصناف غير صالح.");
      }
      const lineNet = round(quantity * unitPrice - discount);
      const lineTax = round(lineNet * taxRate / 100);
      let unitCost = 0;
      if (!product.is_service) {
        let stock = stockSnapshots.get(product.id);
        if (!stock) {
          stock = await this.stockBalance(product.id, invoice.warehouseId);
          stockSnapshots.set(product.id, stock);
        }
        const reserved = round((reservedStock.get(product.id) || 0) + quantity);
        if (reserved - stock.quantity > 0.000001) {
          throw new Error("المخزون غير كافٍ للصنف " + product.name_ar + ". المطلوب في الفاتورة: " + reserved + "، المتاح: " + stock.quantity);
        }
        reservedStock.set(product.id, reserved);
        unitCost = stock.averageCost;
        costTotal += round(quantity * unitCost);
      }
      subtotal += lineNet;
      discountTotal += discount;
      taxTotal += lineTax;
      productRows.push({ product, quantity, unitPrice, discount, taxRate, lineTotal: round(lineNet + lineTax), unitCost });
    }
    subtotal = round(subtotal);
    discountTotal = round(discountTotal);
    taxTotal = round(taxTotal);
    costTotal = round(costTotal);
    const grandTotal = round(subtotal + taxTotal);

    const accounts = await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts");
    const lines = [{ accountCode: party.receivable_code || "1200", debit: grandTotal, credit: 0, currency: invoice.currency, partyId: invoice.partyId }];
    const revenueGroups = new Map();
    const cogsGroups = new Map();
    const inventoryGroups = new Map();
    for (const row of productRows) {
      const revenueCode = row.product.revenue_code || "4100";
      revenueGroups.set(revenueCode, round((revenueGroups.get(revenueCode) || 0) + row.quantity * row.unitPrice - row.discount));
      if (!row.product.is_service && row.unitCost > 0) {
        const cogsCode = row.product.cogs_code || "5100";
        const inventoryCode = row.product.inventory_code || "1300";
        const cost = round(row.quantity * row.unitCost);
        cogsGroups.set(cogsCode, round((cogsGroups.get(cogsCode) || 0) + cost));
        inventoryGroups.set(inventoryCode, round((inventoryGroups.get(inventoryCode) || 0) + cost));
      }
    }
    for (const [code, amount] of revenueGroups) if (amount > 0) lines.push({ accountCode: code, debit: 0, credit: amount, currency: invoice.currency });
    if (taxTotal > 0) lines.push({ accountCode: "2200", debit: 0, credit: taxTotal, currency: invoice.currency });
    for (const [code, amount] of cogsGroups) lines.push({ accountCode: code, debit: amount, credit: 0, currency: invoice.currency });
    for (const [code, amount] of inventoryGroups) lines.push({ accountCode: code, debit: 0, credit: amount, currency: invoice.currency });
    const journal = { date: invoice.date, reference: "JV-SI-" + invoice.number, memo: invoice.memo || "فاتورة مبيعات " + invoice.number, status: "draft", lines };
    validateJournal(journal, accounts);

    const statements = [
      { sql: "INSERT INTO sales_invoices(invoice_no,invoice_date,party_id,warehouse_id,currency_code,exchange_rate,subtotal,tax_total,discount_total,grand_total,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?)",
        params: [invoice.number, invoice.date, invoice.partyId, invoice.warehouseId, invoice.currency, Number(invoice.exchangeRate || 1), subtotal, taxTotal, discountTotal, grandTotal, invoice.memo || ""] }
    ];
    for (const row of productRows) {
      statements.push({ sql: "INSERT INTO sales_invoice_lines(invoice_id,product_id,quantity,unit_price,discount,tax_rate,line_total) VALUES((SELECT id FROM sales_invoices WHERE invoice_no=?),?,?,?,?,?,?)",
        params: [invoice.number, row.product.id, row.quantity, row.unitPrice, row.discount, row.taxRate, row.lineTotal] });
      if (!row.product.is_service) statements.push({ sql: "INSERT INTO stock_movements(movement_date,product_id,warehouse_id,source_type,source_id,quantity_out,unit_cost) VALUES(?,?,?,'sales_invoice',(SELECT id FROM sales_invoices WHERE invoice_no=?),?,?)",
        params: [invoice.date, row.product.id, invoice.warehouseId, invoice.number, row.quantity, row.unitCost] });
    }
    statements.push({ sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,source_id,status,posted_at) VALUES(?,?,?,'sales_invoice',(SELECT id FROM sales_invoices WHERE invoice_no=?),'posted',datetime('now'))",
      params: [journal.reference, journal.date, journal.memo, invoice.number] });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({ sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [journal.reference, i + 1, line.accountCode, line.partyId || null, line.currency, line.debit, line.credit, journal.memo] });
    }
    statements.push({ sql: "UPDATE sales_invoices SET status='posted',journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) WHERE invoice_no=?",
      params: [journal.reference, invoice.number] });
    await this.db.transaction(statements);
    return { number: invoice.number, subtotal, tax: taxTotal, discount: discountTotal, total: grandTotal, costOfGoods: costTotal, journalReference: journal.reference };
  }

  async createPurchaseInvoice(invoice) {
    invoice.number = await this.optionalNumber(invoice.number, "purchase_invoices", "PI");
    required(invoice.date, "تاريخ الفاتورة");
    positive(invoice.partyId, "المورد");
    positive(invoice.warehouseId, "المستودع");
    required(invoice.currency, "العملة");
    if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) throw new Error("أضف صنفاً واحداً على الأقل إلى الفاتورة.");
    const parties = await this.db.query("SELECT * FROM parties WHERE id=? AND is_active=1", [invoice.partyId]);
    if (!parties[0] || !["supplier", "both"].includes(parties[0].party_type)) throw new Error("الطرف المحدد ليس مورداً نشطاً.");
    const currency = await this.db.query("SELECT code FROM currencies WHERE code=? AND is_active=1", [invoice.currency]);
    if (!currency.length) throw new Error("العملة غير معرفة أو غير نشطة.");

    let subtotal = 0, taxTotal = 0;
    const productRows = [];
    for (const input of invoice.lines) {
      const quantity = positive(input.quantity, "الكمية");
      const rows = await this.db.query("SELECT p.*,ia.code AS inventory_code FROM products p LEFT JOIN accounts ia ON ia.id=p.inventory_account_id WHERE p.id=? AND p.is_active=1 AND p.is_service=0", [input.productId]);
      const product = rows[0];
      if (!product) throw new Error("المشتريات تتطلب منتج مخزون نشطاً وليس خدمة.");
      const unitCost = Number(input.unitCost ?? product.purchase_cost);
      const taxRate = Number(input.taxRate ?? product.tax_rate);
      if (![unitCost, taxRate].every(Number.isFinite) || unitCost < 0 || taxRate < 0 || taxRate > 100) throw new Error("تكلفة أو ضريبة أحد الأصناف غير صالحة.");
      const lineNet = round(quantity * unitCost);
      const lineTax = round(lineNet * taxRate / 100);
      subtotal += lineNet;
      taxTotal += lineTax;
      productRows.push({ product, quantity, unitCost, taxRate, lineTotal: round(lineNet + lineTax) });
    }
    subtotal = round(subtotal);
    taxTotal = round(taxTotal);
    const grandTotal = round(subtotal + taxTotal);
    const lines = [];
    const inventoryGroups = new Map();
    for (const row of productRows) {
      const code = row.product.inventory_code || "1300";
      inventoryGroups.set(code, round((inventoryGroups.get(code) || 0) + row.quantity * row.unitCost));
    }
    for (const [code, amount] of inventoryGroups) lines.push({ accountCode: code, debit: amount, credit: 0, currency: invoice.currency });
    if (taxTotal > 0) lines.push({ accountCode: "1250", debit: taxTotal, credit: 0, currency: invoice.currency });
    lines.push({ accountCode: parties[0].payable_code || "2100", debit: 0, credit: grandTotal, currency: invoice.currency, partyId: invoice.partyId });
    const journal = { date: invoice.date, reference: "JV-PI-" + invoice.number, memo: invoice.memo || "فاتورة مشتريات " + invoice.number, status: "draft", lines };
    validateJournal(journal, await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts"));

    const statements = [
      { sql: "INSERT INTO purchase_invoices(invoice_no,invoice_date,party_id,warehouse_id,currency_code,exchange_rate,subtotal,tax_total,grand_total,status,notes) VALUES(?,?,?,?,?,?,?,?,?,'draft',?)",
        params: [invoice.number, invoice.date, invoice.partyId, invoice.warehouseId, invoice.currency, Number(invoice.exchangeRate || 1), subtotal, taxTotal, grandTotal, invoice.memo || ""] }
    ];
    for (const row of productRows) {
      statements.push({ sql: "INSERT INTO purchase_invoice_lines(invoice_id,product_id,quantity,unit_cost,tax_rate,line_total) VALUES((SELECT id FROM purchase_invoices WHERE invoice_no=?),?,?,?,?,?)",
        params: [invoice.number, row.product.id, row.quantity, row.unitCost, row.taxRate, row.lineTotal] });
      statements.push({ sql: "INSERT INTO stock_movements(movement_date,product_id,warehouse_id,source_type,source_id,quantity_in,unit_cost) VALUES(?,?,?,'purchase_invoice',(SELECT id FROM purchase_invoices WHERE invoice_no=?),?,?)",
        params: [invoice.date, row.product.id, invoice.warehouseId, invoice.number, row.quantity, row.unitCost] });
    }
    statements.push({ sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,source_id,status,posted_at) VALUES(?,?,?,'purchase_invoice',(SELECT id FROM purchase_invoices WHERE invoice_no=?),'posted',datetime('now'))",
      params: [journal.reference, journal.date, journal.memo, invoice.number] });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({ sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [journal.reference, i + 1, line.accountCode, line.partyId || null, line.currency, line.debit, line.credit, journal.memo] });
    }
    statements.push({ sql: "UPDATE purchase_invoices SET status='posted',journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) WHERE invoice_no=?",
      params: [journal.reference, invoice.number] });
    await this.db.transaction(statements);
    return { number: invoice.number, subtotal, tax: taxTotal, total: grandTotal, journalReference: journal.reference };
  }

  async createSalesReturn(data) {
    data.number = await this.optionalNumber(data.number, "sales_returns", "SR");
    required(data.date, "تاريخ المرتجع");
    if (!validIsoDate(data.date)) throw new Error("تاريخ المرتجع غير صالح.");
    if (!Array.isArray(data.lines) || !data.lines.length) throw new Error("أضف صنفاً واحداً على الأقل إلى المرتجع.");

    const invoiceRows = await this.db.query(
      "SELECT s.*,p.receivable_account_id,a.code AS receivable_code FROM sales_invoices s JOIN parties p ON p.id=s.party_id LEFT JOIN accounts a ON a.id=p.receivable_account_id WHERE s.invoice_no=? AND s.status='posted'",
      [data.originalInvoice]
    );
    const invoice = invoiceRows[0];
    if (!invoice) throw new Error("فاتورة البيع الأصلية غير موجودة أو غير مرحلة.");

    const requested = new Map();
    for (const input of data.lines) {
      const productId = positive(input.productId, "الصنف");
      const quantity = positive(input.quantity, "كمية المرتجع");
      requested.set(productId, (requested.get(productId) || 0) + quantity);
    }

    let subtotal = 0, taxTotal = 0, costTotal = 0;
    const returnRows = [];
    for (const [productId, quantity] of requested) {
      const originalRows = await this.db.query(
        "SELECT l.*,p.is_service,p.inventory_account_id,ia.code AS inventory_code,p.cogs_account_id,ca.code AS cogs_code FROM sales_invoice_lines l JOIN products p ON p.id=l.product_id LEFT JOIN accounts ia ON ia.id=p.inventory_account_id LEFT JOIN accounts ca ON ca.id=p.cogs_account_id WHERE l.invoice_id=? AND l.product_id=? ORDER BY l.id",
        [invoice.id, productId]
      );
      if (!originalRows.length) throw new Error("الصنف غير موجود في فاتورة البيع الأصلية.");

      const originalQuantity = originalRows.reduce((sum, row) => sum + Number(row.quantity), 0);
      const originalGross = originalRows.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unit_price), 0);
      const originalDiscount = originalRows.reduce((sum, row) => sum + Number(row.discount || 0), 0);
      const originalTax = originalRows.reduce((sum, row) => {
        const lineNet = Number(row.quantity) * Number(row.unit_price) - Number(row.discount || 0);
        return sum + Number(row.line_total) - lineNet;
      }, 0);
      const returnedRows = await this.db.query(
        "SELECT COALESCE(SUM(rl.quantity),0) AS quantity FROM sales_return_lines rl JOIN sales_returns r ON r.id=rl.return_id WHERE r.original_invoice_id=? AND rl.product_id=? AND r.status='posted'",
        [invoice.id, productId]
      );
      const remaining = originalQuantity - Number(returnedRows[0].quantity);
      if (quantity - remaining > 0.000001) throw new Error("كمية المرتجع أكبر من الكمية المتبقية من الفاتورة الأصلية.");

      const gross = round(originalGross * quantity / originalQuantity);
      const discount = round(originalDiscount * quantity / originalQuantity);
      const net = round(gross - discount);
      const tax = round(originalTax * quantity / originalQuantity);
      const unitPrice = gross / quantity;
      const taxRate = net > 0 ? tax / net * 100 : 0;
      const original = originalRows[0];
      let unitCost = 0;
      let cost = 0;
      if (!original.is_service) {
        const movements = await this.db.query(
          "SELECT COALESCE(SUM(quantity_out),0) AS quantity,COALESCE(SUM(quantity_out * unit_cost),0) AS total_cost FROM stock_movements WHERE source_type='sales_invoice' AND source_id=? AND product_id=?",
          [invoice.id, productId]
        );
        const soldQuantity = Number(movements[0]?.quantity || 0);
        unitCost = soldQuantity > 0 ? Number(movements[0].total_cost) / soldQuantity : 0;
        const stock = await this.stockBalance(productId, invoice.warehouse_id);
        if (quantity - stock.quantity > 0.000001) throw new Error("لا توجد كمية كافية في المخزون لقبول هذا المرتجع.");
        cost = round(quantity * unitCost);
        costTotal += cost;
      }

      subtotal += net;
      taxTotal += tax;
      returnRows.push({
        productId, quantity, unitPrice, discount, taxRate,
        lineTotal: round(net + tax), unitCost, cost, net, original
      });
    }

    subtotal = round(subtotal);
    taxTotal = round(taxTotal);
    costTotal = round(costTotal);
    const grandTotal = round(subtotal + taxTotal);
    const lines = [
      { accountCode: "4190", debit: subtotal, credit: 0, currency: invoice.currency_code },
      { accountCode: invoice.receivable_code || "1200", debit: 0, credit: grandTotal, currency: invoice.currency_code, partyId: invoice.party_id }
    ];
    if (taxTotal > 0) lines.push({ accountCode: "2200", debit: taxTotal, credit: 0, currency: invoice.currency_code });
    const stockGroups = new Map();
    const cogsGroups = new Map();
    for (const row of returnRows) {
      if (row.original.is_service || row.cost <= 0) continue;
      const inventoryCode = row.original.inventory_code || "1300";
      const cogsCode = row.original.cogs_code || "5100";
      stockGroups.set(inventoryCode, round((stockGroups.get(inventoryCode) || 0) + row.cost));
      cogsGroups.set(cogsCode, round((cogsGroups.get(cogsCode) || 0) + row.cost));
    }
    for (const [code, amount] of stockGroups) lines.push({ accountCode: code, debit: amount, credit: 0, currency: invoice.currency_code });
    for (const [code, amount] of cogsGroups) lines.push({ accountCode: code, debit: 0, credit: amount, currency: invoice.currency_code });
    const journal = { date: data.date, reference: "JV-SR-" + data.number, memo: data.memo || "مرتجع مبيعات " + data.number, status: "draft", lines };
    validateJournal(journal, await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts"));

    const statements = [
      { sql: "INSERT INTO sales_returns(return_no,return_date,original_invoice_id,party_id,warehouse_id,currency_code,subtotal,tax_total,grand_total,status,notes) VALUES(?,?,(SELECT id FROM sales_invoices WHERE invoice_no=?),?,?,?,?,?,?,'draft',?)",
        params: [data.number, data.date, data.originalInvoice, invoice.party_id, invoice.warehouse_id, invoice.currency_code, subtotal, taxTotal, grandTotal, data.memo || ""] }
    ];
    for (const row of returnRows) {
      statements.push({ sql: "INSERT INTO sales_return_lines(return_id,product_id,quantity,unit_price,discount,tax_rate,line_total) VALUES((SELECT id FROM sales_returns WHERE return_no=?),?,?,?,?,?,?)",
        params: [data.number, row.productId, row.quantity, row.unitPrice, row.discount, row.taxRate, row.lineTotal] });
      if (!row.original.is_service) statements.push({ sql: "INSERT INTO stock_movements(movement_date,product_id,warehouse_id,source_type,source_id,quantity_in,unit_cost) VALUES(?,?,?,'sales_return',(SELECT id FROM sales_returns WHERE return_no=?),?,?)",
        params: [data.date, row.productId, invoice.warehouse_id, data.number, row.quantity, row.unitCost] });
    }
    statements.push({ sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,source_id,status,posted_at) VALUES(?,?,?,'sales_return',(SELECT id FROM sales_returns WHERE return_no=?),'posted',datetime('now'))",
      params: [journal.reference, journal.date, journal.memo, data.number] });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({ sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [journal.reference, i + 1, line.accountCode, line.partyId || null, line.currency, line.debit, line.credit, journal.memo] });
    }
    statements.push({ sql: "UPDATE sales_returns SET status='posted',journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) WHERE return_no=?",
      params: [journal.reference, data.number] });
    await this.db.transaction(statements);
    return { number: data.number, subtotal, tax: taxTotal, total: grandTotal, costReversed: costTotal, journalReference: journal.reference };
  }
  async createPurchaseReturn(data) {
    data.number = await this.optionalNumber(data.number, "purchase_returns", "PR");
    required(data.date, "تاريخ المرتجع");
    if (!validIsoDate(data.date)) throw new Error("تاريخ المرتجع غير صالح.");
    if (!Array.isArray(data.lines) || !data.lines.length) throw new Error("أضف صنفاً واحداً على الأقل إلى المرتجع.");

    const invoiceRows = await this.db.query(
      "SELECT s.*,p.payable_account_id,a.code AS payable_code FROM purchase_invoices s JOIN parties p ON p.id=s.party_id LEFT JOIN accounts a ON a.id=p.payable_account_id WHERE s.invoice_no=? AND s.status='posted'",
      [data.originalInvoice]
    );
    const invoice = invoiceRows[0];
    if (!invoice) throw new Error("فاتورة الشراء الأصلية غير موجودة أو غير مرحلة.");

    const requested = new Map();
    for (const input of data.lines) {
      const productId = positive(input.productId, "الصنف");
      const quantity = positive(input.quantity, "كمية المرتجع");
      requested.set(productId, (requested.get(productId) || 0) + quantity);
    }

    let subtotal = 0, taxTotal = 0;
    const returnRows = [];
    for (const [productId, quantity] of requested) {
      const originalRows = await this.db.query(
        "SELECT l.*,p.inventory_account_id,a.code AS inventory_code FROM purchase_invoice_lines l JOIN products p ON p.id=l.product_id LEFT JOIN accounts a ON a.id=p.inventory_account_id WHERE l.invoice_id=? AND l.product_id=? ORDER BY l.id",
        [invoice.id, productId]
      );
      if (!originalRows.length) throw new Error("الصنف غير موجود في فاتورة الشراء الأصلية.");

      const originalQuantity = originalRows.reduce((sum, row) => sum + Number(row.quantity), 0);
      const originalNet = originalRows.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unit_cost), 0);
      const originalTax = originalRows.reduce((sum, row) => {
        const lineNet = Number(row.quantity) * Number(row.unit_cost);
        return sum + Number(row.line_total) - lineNet;
      }, 0);
      const returnedRows = await this.db.query(
        "SELECT COALESCE(SUM(rl.quantity),0) AS quantity FROM purchase_return_lines rl JOIN purchase_returns r ON r.id=rl.return_id WHERE r.original_invoice_id=? AND rl.product_id=? AND r.status='posted'",
        [invoice.id, productId]
      );
      const remaining = originalQuantity - Number(returnedRows[0].quantity);
      if (quantity - remaining > 0.000001) throw new Error("كمية المرتجع أكبر من الكمية المتبقية من الفاتورة الأصلية.");

      const net = round(originalNet * quantity / originalQuantity);
      const tax = round(originalTax * quantity / originalQuantity);
      const unitCost = net / quantity;
      const taxRate = net > 0 ? tax / net * 100 : 0;
      const stock = await this.stockBalance(productId, invoice.warehouse_id);
      if (quantity - stock.quantity > 0.000001) throw new Error("لا توجد كمية كافية في المخزون لإرجاعها للمورد.");
      subtotal += net;
      taxTotal += tax;
      returnRows.push({
        productId, quantity, unitCost, taxRate, net,
        lineTotal: round(net + tax),
        inventoryCode: originalRows[0].inventory_code || "1300"
      });
    }

    subtotal = round(subtotal);
    taxTotal = round(taxTotal);
    const grandTotal = round(subtotal + taxTotal);
    const lines = [
      { accountCode: invoice.payable_code || "2100", debit: grandTotal, credit: 0, currency: invoice.currency_code, partyId: invoice.party_id }
    ];
    if (taxTotal > 0) lines.push({ accountCode: "1250", debit: 0, credit: taxTotal, currency: invoice.currency_code });
    const inventoryGroups = new Map();
    for (const row of returnRows) {
      inventoryGroups.set(row.inventoryCode, round((inventoryGroups.get(row.inventoryCode) || 0) + row.net));
    }
    for (const [code, amount] of inventoryGroups) {
      if (amount > 0) lines.push({ accountCode: code, debit: 0, credit: amount, currency: invoice.currency_code });
    }
    const journal = { date: data.date, reference: "JV-PR-" + data.number, memo: data.memo || "مرتجع مشتريات " + data.number, status: "draft", lines };
    validateJournal(journal, await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts"));

    const statements = [
      { sql: "INSERT INTO purchase_returns(return_no,return_date,original_invoice_id,party_id,warehouse_id,currency_code,subtotal,tax_total,grand_total,status,notes) VALUES(?,?,(SELECT id FROM purchase_invoices WHERE invoice_no=?),?,?,?,?,?,?,'draft',?)",
        params: [data.number, data.date, data.originalInvoice, invoice.party_id, invoice.warehouse_id, invoice.currency_code, subtotal, taxTotal, grandTotal, data.memo || ""] }
    ];
    for (const row of returnRows) {
      statements.push({ sql: "INSERT INTO purchase_return_lines(return_id,product_id,quantity,unit_cost,tax_rate,line_total) VALUES((SELECT id FROM purchase_returns WHERE return_no=?),?,?,?,?,?)",
        params: [data.number, row.productId, row.quantity, row.unitCost, row.taxRate, row.lineTotal] });
      statements.push({ sql: "INSERT INTO stock_movements(movement_date,product_id,warehouse_id,source_type,source_id,quantity_out,unit_cost) VALUES(?,?,?,'purchase_return',(SELECT id FROM purchase_returns WHERE return_no=?),?,?)",
        params: [data.date, row.productId, invoice.warehouse_id, data.number, row.quantity, row.unitCost] });
    }
    statements.push({ sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,source_id,status,posted_at) VALUES(?,?,?,'purchase_return',(SELECT id FROM purchase_returns WHERE return_no=?),'posted',datetime('now'))",
      params: [journal.reference, journal.date, journal.memo, data.number] });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({ sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [journal.reference, i + 1, line.accountCode, line.partyId || null, line.currency, line.debit, line.credit, journal.memo] });
    }
    statements.push({ sql: "UPDATE purchase_returns SET status='posted',journal_id=(SELECT id FROM journal_entries WHERE entry_no=?) WHERE return_no=?",
      params: [journal.reference, data.number] });
    await this.db.transaction(statements);
    return { number: data.number, subtotal, tax: taxTotal, total: grandTotal, journalReference: journal.reference };
  }
  async postExpense(data) {
    return this.postCashOffset(data, "expense");
  }

  async postRevenue(data) {
    return this.postCashOffset(data, "revenue");
  }

  async createDebtInstallment(data) {
    required(data.dueDate, "تاريخ استحقاق القسط");
    required(data.currency, "عملة القسط");
    const partyId = positive(data.partyId, "الطرف");
    const amount = round(positive(data.amount, "مبلغ القسط"));
    const sourceType = data.sourceType;
    if (!["receivable", "payable"].includes(sourceType)) throw new Error("نوع الدين غير صالح.");
    if (!validIsoDate(data.dueDate)) throw new Error("تاريخ استحقاق القسط غير صالح.");
    const parties = await this.db.query("SELECT party_type FROM parties WHERE id=? AND is_active=1", [partyId]);
    const party = parties[0];
    if (!party) throw new Error("الطرف غير موجود أو غير نشط.");
    if (sourceType === "receivable" && !["customer", "both"].includes(party.party_type)) throw new Error("قسط الذمم المدينة يجب أن يرتبط بعميل.");
    if (sourceType === "payable" && !["supplier", "both"].includes(party.party_type)) throw new Error("قسط الذمم الدائنة يجب أن يرتبط بمورد.");
    const currencies = await this.db.query("SELECT code FROM currencies WHERE code=? AND is_active=1", [data.currency]);
    if (!currencies.length) throw new Error("عملة القسط غير معرفة أو غير نشطة.");
    return this.db.run(
      "INSERT INTO debt_installments(party_id,due_date,amount,paid_amount,currency_code,source_type,source_id) VALUES(?,?,?,0,?,?,?)",
      [partyId, data.dueDate, amount, data.currency, sourceType, data.sourceId ? positive(data.sourceId, "مرجع المصدر") : null]
    );
  }

  async postPartySettlement(data) {
    data.number = await this.optionalNumber(data.number, "cash_transactions", "RC");
    required(data.date, "تاريخ السند");
    required(data.currency, "العملة");
    const type = data.type;
    if (!["receipt", "payment"].includes(type)) throw new Error("نوع السند يجب أن يكون قبضاً أو صرفاً.");
    const partyId = positive(data.partyId, "الطرف");
    const amount = round(positive(data.amount, "المبلغ"));
    const parties = await this.db.query(
      "SELECT p.*,ra.code AS receivable_code,pa.code AS payable_code FROM parties p LEFT JOIN accounts ra ON ra.id=p.receivable_account_id LEFT JOIN accounts pa ON pa.id=p.payable_account_id WHERE p.id=? AND p.is_active=1",
      [partyId]
    );
    const party = parties[0];
    if (!party) throw new Error("الطرف غير موجود أو غير نشط.");
    if (type === "receipt" && !["customer", "both"].includes(party.party_type)) throw new Error("سند القبض يتطلب عميلاً.");
    if (type === "payment" && !["supplier", "both"].includes(party.party_type)) throw new Error("سند الصرف يتطلب مورداً.");

    const cashBoxId = data.cashBoxId ? positive(data.cashBoxId, "الصندوق") : null;
    const bankAccountId = data.bankAccountId ? positive(data.bankAccountId, "الحساب البنكي") : null;
    if (Boolean(cashBoxId) === Boolean(bankAccountId)) throw new Error("اختر صندوقاً نقدياً واحداً أو حساباً بنكياً واحداً.");
    const accountRows = cashBoxId
      ? await this.db.query("SELECT c.currency_code,a.code AS account_code,a.account_type FROM cash_boxes c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND c.is_active=1", [cashBoxId])
      : await this.db.query("SELECT b.currency_code,a.code AS account_code,a.account_type FROM bank_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.id=? AND b.is_active=1", [bankAccountId]);
    const cashAccount = accountRows[0];
    if (!cashAccount) throw new Error("الصندوق أو الحساب البنكي غير موجود أو غير نشط.");
    if (cashAccount.account_type !== "asset") throw new Error("يجب ربط الصندوق أو البنك بحساب من نوع الأصول.");
    if (cashAccount.currency_code !== data.currency) throw new Error("عملة الصندوق أو البنك لا تطابق عملة السند.");
    const partyAccountCode = type === "receipt" ? party.receivable_code : party.payable_code;
    if (!partyAccountCode) throw new Error("لم يتم ربط الطرف بحساب الذمم المناسب.");

    const memo = data.memo || (type === "receipt" ? "سند قبض من " : "سند صرف إلى ") + party.name_ar;
    const reference = "JV-" + (type === "receipt" ? "RC-" : "SP-") + data.number;
    const lines = type === "receipt"
      ? [
          { accountCode: cashAccount.account_code, debit: amount, credit: 0, currency: data.currency },
          { accountCode: partyAccountCode, debit: 0, credit: amount, currency: data.currency, partyId }
        ]
      : [
          { accountCode: partyAccountCode, debit: amount, credit: 0, currency: data.currency, partyId },
          { accountCode: cashAccount.account_code, debit: 0, credit: amount, currency: data.currency }
        ];
    const journal = { date: data.date, reference, memo, status: "draft", lines };
    const accounts = await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts");
    validateJournal(journal, accounts);
    const sourceType = type === "receipt" ? "receivable" : "payable";
    const installments = await this.db.query(
      "SELECT id,amount,paid_amount FROM debt_installments WHERE party_id=? AND currency_code=? AND source_type=? AND paid_amount<amount ORDER BY due_date,id",
      [partyId, data.currency, sourceType]
    );
    let unappliedAmount = amount;
    const installmentUpdates = [];
    for (const installment of installments) {
      const outstanding = round(Number(installment.amount) - Number(installment.paid_amount));
      const applied = round(Math.min(unappliedAmount, outstanding));
      if (applied <= 0) continue;
      installmentUpdates.push({
        sql: "UPDATE debt_installments SET paid_amount=paid_amount+? WHERE id=? AND paid_amount+?<=amount",
        params: [applied, installment.id, applied]
      });
      unappliedAmount = round(unappliedAmount - applied);
      if (unappliedAmount <= 0) break;
    }
    const statements = [{
      sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,status,posted_at) VALUES(?,?,?,?, 'posted',datetime('now'))",
      params: [reference, data.date, memo, type === "receipt" ? "cash_receipt" : "supplier_payment"]
    }];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({
        sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [reference, i + 1, line.accountCode, line.partyId || null, line.currency, line.debit, line.credit, memo]
      });
    }
    statements.push(...installmentUpdates);
    statements.push({
      sql: "INSERT INTO cash_transactions(transaction_no,transaction_date,transaction_type,cash_box_id,bank_account_id,party_id,currency_code,amount,journal_id,memo) VALUES(?,?,?,?,?,?,?,?,(SELECT id FROM journal_entries WHERE entry_no=?),?)",
      params: [data.number, data.date, type, cashBoxId, bankAccountId, partyId, data.currency, amount, reference, memo]
    });
    await this.db.transaction(statements);
    return { number: data.number, amount, journalReference: reference };
  }

  async postCashTransfer(data) {
    data.number = await this.optionalNumber(data.number, "cash_transfers", "TR");
    required(data.date, "تاريخ التحويل");
    required(data.currency, "عملة التحويل");
    if (!validIsoDate(data.date)) throw new Error("تاريخ التحويل غير صالح.");
    const fromType = data.fromType;
    const toType = data.toType;
    if (!["cash", "bank"].includes(fromType) || !["cash", "bank"].includes(toType)) throw new Error("حدد مصدر التحويل ووجهته من صندوق أو حساب بنكي.");
    const fromId = positive(data.fromId, "حساب المصدر");
    const toId = positive(data.toId, "حساب الوجهة");
    if (fromType === toType && fromId === toId) throw new Error("لا يمكن التحويل من الحساب إلى نفسه.");
    const loadAccount = async (type, id) => {
      const rows = type === "cash"
        ? await this.db.query("SELECT c.currency_code,a.code AS account_code,a.account_type FROM cash_boxes c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND c.is_active=1", [id])
        : await this.db.query("SELECT b.currency_code,a.code AS account_code,a.account_type FROM bank_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.id=? AND b.is_active=1", [id]);
      return rows[0];
    };
    const [source, destination] = await Promise.all([loadAccount(fromType, fromId), loadAccount(toType, toId)]);
    if (!source || !destination) throw new Error("حساب مصدر التحويل أو وجهته غير موجود أو غير نشط.");
    if (source.account_type !== "asset" || destination.account_type !== "asset") throw new Error("يجب ربط حسابات الصناديق والبنوك بحسابات من نوع الأصول.");
    if (source.currency_code !== data.currency || destination.currency_code !== data.currency) throw new Error("يجب أن تتطابق عملة المصدر والوجهة مع عملة التحويل.");
    if (source.account_code === destination.account_code) throw new Error("اربط المصدر والوجهة بحسابي أستاذ مختلفين لتسجيل التحويل بصورة صحيحة.");
    const amount = round(positive(data.amount, "مبلغ التحويل"));
    const reference = "JV-TR-" + data.number;
    const memo = data.memo || "تحويل داخلي بين الصناديق والبنوك";
    const journal = { date: data.date, reference, memo, status: "draft", lines: [
      { accountCode: destination.account_code, debit: amount, credit: 0, currency: data.currency },
      { accountCode: source.account_code, debit: 0, credit: amount, currency: data.currency }
    ] };
    validateJournal(journal, await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts"));
    await this.db.transaction([
      { sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,status,posted_at) VALUES(?,?,?,'cash_transfer','posted',datetime('now'))", params: [reference, data.date, memo] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),1,(SELECT id FROM accounts WHERE code=?),?,?,0,?)", params: [reference, destination.account_code, data.currency, amount, memo] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),2,(SELECT id FROM accounts WHERE code=?),?,0,?,?)", params: [reference, source.account_code, data.currency, amount, memo] },
      { sql: "INSERT INTO cash_transfers(transfer_no,transfer_date,from_cash_box_id,from_bank_account_id,to_cash_box_id,to_bank_account_id,currency_code,amount,journal_id,memo) VALUES(?,?,?,?,?,?,?,?,(SELECT id FROM journal_entries WHERE entry_no=?),?)", params: [data.number, data.date, fromType === "cash" ? fromId : null, fromType === "bank" ? fromId : null, toType === "cash" ? toId : null, toType === "bank" ? toId : null, data.currency, amount, reference, memo] }
    ]);
    return { number: data.number, amount, currency: data.currency, journalReference: reference };
  }

  async createBankReconciliation(data) {
    data.number = await this.optionalNumber(data.number, "bank_reconciliations", "BR");
    required(data.startDate, "بداية فترة التسوية");
    required(data.endDate, "نهاية فترة التسوية");
    if (!validIsoDate(data.startDate) || !validIsoDate(data.endDate) || data.startDate > data.endDate) {
      throw new Error("فترة التسوية البنكية غير صالحة.");
    }
    const bankAccountId = positive(data.bankAccountId, "الحساب البنكي");
    const banks = await this.db.query(
      "SELECT b.id,b.currency_code,b.account_id,a.account_type,a.is_active,a.is_postable FROM bank_accounts b JOIN accounts a ON a.id=b.account_id JOIN currencies c ON c.code=b.currency_code AND c.is_active=1 WHERE b.id=? AND b.is_active=1",
      [bankAccountId]
    );
    const bank = banks[0];
    if (!bank) throw new Error("الحساب البنكي غير موجود أو غير نشط.");
    if (bank.account_type !== "asset" || bank.is_active !== 1 || bank.is_postable !== 1) {
      throw new Error("يجب ربط الحساب البنكي بحساب أصول نشط وقابل للترحيل.");
    }
    const shared = await this.db.query(
      "SELECT id FROM bank_accounts WHERE account_id=? AND is_active=1 AND id<>?",
      [bank.account_id, bankAccountId]
    );
    if (shared.length) throw new Error("خصص حساب أستاذ مستقلاً لكل حساب بنكي قبل إجراء التسوية.");
    const openingBalance = Number(data.openingBalance);
    const closingBalance = Number(data.closingBalance);
    if (![openingBalance, closingBalance].every(Number.isFinite)) {
      throw new Error("أرصدة كشف البنك غير صالحة.");
    }
    const overlap = await this.db.query(
      "SELECT id FROM bank_reconciliations WHERE bank_account_id=? AND NOT(period_end<? OR period_start>?)",
      [bankAccountId, data.startDate, data.endDate]
    );
    if (overlap.length) throw new Error("توجد تسوية أخرى متداخلة مع هذه الفترة لهذا الحساب البنكي.");
    const result = await this.db.run(
      "INSERT INTO bank_reconciliations(reconciliation_no,bank_account_id,period_start,period_end,opening_balance,closing_balance,memo) VALUES(?,?,?,?,?,?,?)",
      [data.number, bankAccountId, data.startDate, data.endDate, openingBalance, closingBalance, data.memo || ""]
    );
    return { id: Number(result.lastInsertRowid), number: data.number, currency: bank.currency_code };
  }

  async addBankStatementLine(data) {
    required(data.statementDate, "تاريخ حركة كشف البنك");
    if (!validIsoDate(data.statementDate)) throw new Error("تاريخ حركة كشف البنك غير صالح.");
    const reconciliationId = positive(data.reconciliationId, "التسوية البنكية");
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.000001) {
      throw new Error("مبلغ حركة كشف البنك يجب أن يكون رقماً غير صفري.");
    }
    const rows = await this.db.query(
      "SELECT id,period_start,period_end,status FROM bank_reconciliations WHERE id=?",
      [reconciliationId]
    );
    const reconciliation = rows[0];
    if (!reconciliation) throw new Error("التسوية البنكية غير موجودة.");
    if (reconciliation.status !== "draft") throw new Error("لا يمكن تعديل تسوية بنكية مقفلة.");
    if (data.statementDate < reconciliation.period_start || data.statementDate > reconciliation.period_end) {
      throw new Error("تاريخ حركة كشف البنك خارج فترة التسوية.");
    }
    const result = await this.db.run(
      "INSERT INTO bank_reconciliation_lines(reconciliation_id,statement_date,reference,description,amount) VALUES(?,?,?,?,?)",
      [reconciliationId, data.statementDate, String(data.reference || "").trim(), String(data.description || "").trim(), round(amount)]
    );
    return { id: Number(result.lastInsertRowid), amount: round(amount) };
  }

  async matchBankStatementLine(data) {
    const lineId = positive(data.lineId, "حركة كشف البنك");
    const journalLineId = positive(data.journalLineId, "سطر القيد");
    const rows = await this.db.query(
      "SELECT l.id,l.amount,l.matched_journal_line_id,r.id AS reconciliation_id,r.status,r.period_start,r.period_end,b.id AS bank_account_id,b.account_id,b.currency_code FROM bank_reconciliation_lines l JOIN bank_reconciliations r ON r.id=l.reconciliation_id JOIN bank_accounts b ON b.id=r.bank_account_id WHERE l.id=?",
      [lineId]
    );
    const line = rows[0];
    if (!line) throw new Error("حركة كشف البنك غير موجودة.");
    if (line.status !== "draft") throw new Error("لا يمكن تعديل تسوية بنكية مقفلة.");
    if (line.matched_journal_line_id) throw new Error("تمت مطابقة حركة كشف البنك مسبقاً.");
    const candidates = await this.db.query(
      "SELECT jl.id,jl.debit,jl.credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id LEFT JOIN bank_reconciliation_outstanding o ON o.journal_line_id=jl.id AND o.bank_account_id=? AND o.status='pending' LEFT JOIN bank_reconciliations origin ON origin.id=o.origin_reconciliation_id WHERE jl.id=? AND jl.account_id=? AND jl.currency_code=? AND je.status='posted' AND (je.entry_date BETWEEN ? AND ? OR (o.id IS NOT NULL AND origin.period_end<?))",
      [line.bank_account_id, journalLineId, line.account_id, line.currency_code, line.period_start, line.period_end, line.period_start]
    );
    const candidate = candidates[0];
    if (!candidate) throw new Error("سطر القيد ليس حركة مرحلة للحساب البنكي والعملة والفترة المحددة.");
    const signedBookAmount = Number(candidate.debit) - Number(candidate.credit);
    if (Math.abs(signedBookAmount - Number(line.amount)) > 0.000001) {
      throw new Error("مبلغ حركة كشف البنك لا يطابق مبلغ سطر القيد؛ راجع اتجاه الإيداع أو السحب.");
    }
    const used = await this.db.query(
      "SELECT id FROM bank_reconciliation_lines WHERE matched_journal_line_id=? AND id<>?",
      [journalLineId, lineId]
    );
    if (used.length) throw new Error("تمت مطابقة سطر القيد هذا في تسوية بنكية أخرى.");
    const results = await this.db.transaction([{
      sql: "UPDATE bank_reconciliation_lines SET matched_journal_line_id=?,matched_at=datetime('now') WHERE id=? AND matched_journal_line_id IS NULL AND reconciliation_id IN (SELECT id FROM bank_reconciliations WHERE status='draft')",
      params: [journalLineId, lineId]
    }]);
    if (!results?.[0]?.changes) throw new Error("تعذر حفظ المطابقة؛ ربما تمت العملية من نافذة أخرى.");
    return { lineId, journalLineId, matched: true };
  }

  async completeBankReconciliation(reconciliationId) {
    const id = positive(reconciliationId, "التسوية البنكية");
    const rows = await this.db.query(
      "SELECT r.*,b.account_id,b.currency_code FROM bank_reconciliations r JOIN bank_accounts b ON b.id=r.bank_account_id WHERE r.id=?",
      [id]
    );
    const reconciliation = rows[0];
    if (!reconciliation) throw new Error("التسوية البنكية غير موجودة.");
    if (reconciliation.status !== "draft") throw new Error("التسوية البنكية مقفلة مسبقاً.");
    const lines = await this.db.query(
      "SELECT id,amount,matched_journal_line_id FROM bank_reconciliation_lines WHERE reconciliation_id=? ORDER BY statement_date,id",
      [id]
    );
    if (!lines.length) throw new Error("أضف حركات كشف البنك قبل إتمام التسوية.");
    const unmatchedStatement = lines.filter((line) => !line.matched_journal_line_id);
    if (unmatchedStatement.length) {
      throw new Error("لا يمكن إتمام التسوية قبل مطابقة جميع حركات كشف البنك. الحركات غير المطابقة: " + unmatchedStatement.length);
    }
    const statementMovement = round(lines.reduce((sum, line) => sum + Number(line.amount), 0));
    const calculatedStatementClosing = round(Number(reconciliation.opening_balance) + statementMovement);
    if (Math.abs(calculatedStatementClosing - Number(reconciliation.closing_balance)) > 0.01) {
      throw new Error("رصيد الإقفال المدخل لا يساوي الرصيد الافتتاحي مضافاً إليه حركات كشف البنك.");
    }

    const priorOutstanding = await this.db.query(
      "SELECT o.journal_line_id,jl.debit-jl.credit AS amount FROM bank_reconciliation_outstanding o JOIN journal_lines jl ON jl.id=o.journal_line_id JOIN bank_reconciliations origin ON origin.id=o.origin_reconciliation_id WHERE o.bank_account_id=? AND o.status='pending' AND origin.period_end<? ORDER BY origin.period_end,o.id",
      [reconciliation.bank_account_id, reconciliation.period_start]
    );
    const priorOutstandingNet = round(priorOutstanding.reduce((sum, item) => sum + Number(item.amount), 0));
    const openingRows = await this.db.query(
      "SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id WHERE jl.account_id=? AND jl.currency_code=? AND je.status='posted' AND je.entry_date<?",
      [reconciliation.account_id, reconciliation.currency_code, reconciliation.period_start]
    );
    const bookOpening = round(Number(openingRows[0]?.balance || 0));
    const adjustedOpening = round(bookOpening - priorOutstandingNet);
    if (Math.abs(adjustedOpening - Number(reconciliation.opening_balance)) > 0.01) {
      throw new Error("رصيد كشف البنك الافتتاحي بعد مراعاة الحركات المعلقة من الفترات السابقة لا يطابق رصيد حساب الأستاذ. عالج فرق الرصيد الافتتاحي أولاً.");
    }

    const bookRows = await this.db.query(
      "SELECT jl.id,jl.debit-jl.credit AS amount FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_id WHERE jl.account_id=? AND jl.currency_code=? AND je.status='posted' AND je.entry_date BETWEEN ? AND ?",
      [reconciliation.account_id, reconciliation.currency_code, reconciliation.period_start, reconciliation.period_end]
    );
    const matchedIds = new Set(lines.map((line) => Number(line.matched_journal_line_id)));
    const matchedPrior = priorOutstanding.filter((item) => matchedIds.has(Number(item.journal_line_id)));
    const remainingPrior = priorOutstanding.filter((item) => !matchedIds.has(Number(item.journal_line_id)));
    const unmatchedCurrent = bookRows.filter((line) => !matchedIds.has(Number(line.id)));
    const bookMovement = round(bookRows.reduce((sum, line) => sum + Number(line.amount), 0));
    const outstandingAfter = [...remainingPrior, ...unmatchedCurrent];
    const outstandingNet = round(outstandingAfter.reduce((sum, item) => sum + Number(item.amount), 0));
    const bookClosing = round(bookOpening + bookMovement);
    const adjustedBookBalance = round(bookClosing - outstandingNet);
    if (Math.abs(adjustedBookBalance - Number(reconciliation.closing_balance)) > 0.01) {
      throw new Error("الرصيد المعدل لحساب البنك لا يطابق كشف البنك؛ راجع الحركات والمطابقات.");
    }

    const completionToken = new Date().toISOString() + "-" + Math.random().toString(36).slice(2);
    const auditDetails = {
      bankAccountId: reconciliation.bank_account_id,
      periodStart: reconciliation.period_start,
      periodEnd: reconciliation.period_end,
      statementOpening: Number(reconciliation.opening_balance),
      statementClosing: Number(reconciliation.closing_balance),
      bookOpening,
      adjustedOpening,
      bookClosing,
      priorOutstandingCleared: matchedPrior.length,
      outstandingCount: outstandingAfter.length,
      outstandingNet
    };
    const statements = [{
      sql: "UPDATE bank_reconciliations SET status='closed',completed_at=? WHERE id=? AND status='draft'",
      params: [completionToken, id]
    }];
    for (const item of matchedPrior) {
      statements.push({
        sql: "UPDATE bank_reconciliation_outstanding SET status='cleared',cleared_reconciliation_id=?,cleared_at=? WHERE journal_line_id=? AND bank_account_id=? AND status='pending' AND EXISTS (SELECT 1 FROM bank_reconciliations WHERE id=? AND status='closed' AND completed_at=?)",
        params: [id, completionToken, item.journal_line_id, reconciliation.bank_account_id, id, completionToken]
      });
    }
    for (const item of unmatchedCurrent) {
      statements.push({
        sql: "INSERT OR IGNORE INTO bank_reconciliation_outstanding(bank_account_id,journal_line_id,origin_reconciliation_id) SELECT ?,?,?, WHERE EXISTS (SELECT 1 FROM bank_reconciliations WHERE id=? AND status='closed' AND completed_at=?)",
        params: [reconciliation.bank_account_id, item.id, id, id, completionToken]
      });
    }
    statements.push({
      sql: "INSERT INTO audit_log(action,entity_type,entity_id,details_json) SELECT 'reconcile','bank_reconciliation',?,? WHERE EXISTS (SELECT 1 FROM bank_reconciliations WHERE id=? AND status='closed' AND completed_at=?)",
      params: [String(id), JSON.stringify(auditDetails), id, completionToken]
    });
    const results = await this.db.transaction(statements);
    if (!results?.[0]?.changes) throw new Error("تعذر إقفال التسوية البنكية؛ ربما أُقفلت من نافذة أخرى.");
    return {
      number: reconciliation.reconciliation_no,
      statementClosingBalance: Number(reconciliation.closing_balance),
      bookClosingBalance: bookClosing,
      adjustedBookBalance,
      priorOutstandingCleared: matchedPrior.length,
      outstandingCount: outstandingAfter.length,
      outstandingNet
    };
  }

  async postCashOffset(data, kind) {
    const expense = kind === "expense";
    data.number = await this.optionalNumber(data.number, expense ? "expenses" : "revenues", expense ? "EX" : "RV");
    required(data.date, "التاريخ");
    required(data.currency, "العملة");
    const amount = round(positive(data.amount, "المبلغ"));
    const accountCode = data.accountCode || (expense ? "5200" : "4200");
    const cashCode = data.cashAccountCode || "1100";
    const lines = expense
      ? [{ accountCode, debit: amount, credit: 0, currency: data.currency }, { accountCode: cashCode, debit: 0, credit: amount, currency: data.currency }]
      : [{ accountCode: cashCode, debit: amount, credit: 0, currency: data.currency }, { accountCode, debit: 0, credit: amount, currency: data.currency }];
    const accounts = await this.db.query("SELECT code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts");
    const journal = { date: data.date, reference: "JV-" + (expense ? "EX-" : "RV-") + data.number, memo: data.memo || (expense ? "مصروف" : "إيراد"), status: "draft", lines };
    validateJournal(journal, accounts);
    const table = expense ? "expenses" : "revenues";
    const dateColumn = expense ? "expense_date" : "revenue_date";
    const noColumn = expense ? "expense_no" : "revenue_no";
    const statements = [
      { sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,status,posted_at) VALUES(?,?,?,?, 'posted',datetime('now'))",
        params: [journal.reference, journal.date, journal.memo, expense ? "expense" : "revenue"] }
    ];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      statements.push({ sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,party_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),?,(SELECT id FROM accounts WHERE code=?),?,?,?,?,?)",
        params: [journal.reference, i + 1, line.accountCode, line.partyId || null, data.currency, line.debit, line.credit, journal.memo] });
    }
    statements.push({ sql: "INSERT INTO " + table + "(" + noColumn + "," + dateColumn + ",account_id,party_id,currency_code,amount,journal_id,memo) VALUES(?,?,(SELECT id FROM accounts WHERE code=?),?,?,?,(SELECT id FROM journal_entries WHERE entry_no=?),?)",
      params: [data.number, data.date, accountCode, data.partyId || null, data.currency, amount, journal.reference, data.memo || ""] });
    await this.db.transaction(statements);
    return { number: data.number, amount, journalReference: journal.reference };
  }

  async runDepreciation(assetId, period) {
    required(period, "فترة الإهلاك");
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period));
    if (!match) throw new Error("فترة الإهلاك يجب أن تكون بصيغة YYYY-MM وبشهر صالح.");
    const periodEnd = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
    const rows = await this.db.query("SELECT * FROM fixed_assets WHERE id=? AND status='active'", [assetId]);
    const asset = rows[0];
    if (!asset) throw new Error("الأصل غير موجود أو غير نشط.");
    if (!validIsoDate(asset.acquisition_date)) throw new Error("تاريخ اقتناء الأصل غير صالح.");
    if (asset.acquisition_date > periodEnd) throw new Error("لا يمكن إهلاك أصل قبل تاريخ اقتنائه.");
    const duplicate = await this.db.query("SELECT id FROM depreciation_runs WHERE asset_id=? AND period=?", [assetId, period]);
    if (duplicate.length) throw new Error("تم تسجيل إهلاك هذا الأصل لهذه الفترة مسبقاً.");
    const prior = await this.db.query("SELECT COALESCE(SUM(amount),0) AS amount FROM depreciation_runs WHERE asset_id=?", [assetId]);
    const monthly = round((asset.cost - asset.residual_value) / asset.useful_life_months);
    const remaining = round(asset.cost - asset.residual_value - Number(prior[0].amount));
    const amount = round(Math.min(monthly, remaining));
    if (amount <= 0) throw new Error("تم استهلاك كامل القيمة القابلة للإهلاك.");
    const accounts = await this.db.query("SELECT id,code,name_ar AS name,account_type AS type,is_active,is_postable FROM accounts");
    const depCode = accounts.find((a) => a.id === asset.depreciation_expense_account_id)?.code;
    const accumCode = accounts.find((a) => a.id === asset.accumulated_depreciation_account_id)?.code;
    const baseRows = await this.db.query("SELECT base_currency FROM company_settings WHERE id=1");
    const baseCurrency = baseRows[0]?.base_currency || "YER";
    const journal = { date: period + "-01", reference: "JV-DEP-" + asset.asset_code + "-" + period, memo: "إهلاك الأصل " + asset.name_ar, status: "draft", lines: [
      { accountCode: depCode, debit: amount, credit: 0, currency: baseCurrency },
      { accountCode: accumCode, debit: 0, credit: amount, currency: baseCurrency }
    ] };
    validateJournal(journal, accounts);
    await this.db.transaction([
      { sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,source_type,source_id,status,posted_at) VALUES(?,?,?,'depreciation',?,'posted',datetime('now'))",
        params: [journal.reference, journal.date, journal.memo, assetId] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),1,?,?,?,0,?)",
        params: [journal.reference, asset.depreciation_expense_account_id, baseCurrency, amount, journal.memo] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),2,?,?,0,?,?)",
        params: [journal.reference, asset.accumulated_depreciation_account_id, baseCurrency, amount, journal.memo] },
      { sql: "INSERT INTO depreciation_runs(asset_id,period,amount,journal_id) VALUES(?,?,?,(SELECT id FROM journal_entries WHERE entry_no=?))",
        params: [assetId, period, amount, journal.reference] }
    ]);
    return { assetId, period, amount, journalReference: journal.reference };
  }
}