import "./styles.css";
import { initDatabase, query, run, transaction, backupDatabase, restoreDatabase } from "./db/index.js";
import { validateJournal, trialBalance, incomeStatement, balanceSheet, cashFlow } from "./core/accounting.js";
import { ErpService } from "./core/erp-service.js";

const $ = (selector) => document.querySelector(selector);
const contentRoot = $("#content");
const service = new ErpService({ query, run, transaction });
let currentPage = "dashboard";
let accounts = [];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function money(value) { return Number(value || 0).toLocaleString("ar-YE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function message(text, kind = "") { return '<div class="notice ' + kind + '">' + esc(text) + "</div>"; }
function heading(title, subtitle = "") { return "<h2>" + title + "</h2>" + (subtitle ? '<p class="muted">' + subtitle + "</p>" : ""); }
function field(label, name, type = "text", required = true, extra = "") {
  return '<label>' + label + '<input name="' + name + '" type="' + type + '" ' + (required ? "required" : "") + " " + extra + "></label>";
}
function selectField(label, name, options, required = true) {
  return '<label>' + label + '<select name="' + name + '" ' + (required ? "required" : "") + ">" +
    options.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>").join("") + "</select></label>";
}
async function loadAccounts() {
  accounts = await query("SELECT id,code,name_ar AS name,account_type AS type,normal_side,is_postable,is_active,cash_flow_category AS cashFlowCategory FROM accounts ORDER BY code");
  return accounts;
}
async function getCurrencies() {
  return query("SELECT code,name_ar FROM currencies WHERE is_active=1 ORDER BY code");
}
async function getParties(type) {
  if (!type) return query("SELECT id,party_code,name_ar,party_type FROM parties WHERE is_active=1 ORDER BY name_ar");
  return query("SELECT id,party_code,name_ar,party_type FROM parties WHERE is_active=1 AND (party_type=? OR party_type='both') ORDER BY name_ar", [type]);
}
async function getProducts() {
  return query("SELECT id,sku,name_ar,is_service,sale_price,purchase_cost,tax_rate FROM products WHERE is_active=1 ORDER BY name_ar");
}
async function getWarehouses() {
  return query("SELECT id,code,name_ar FROM warehouses WHERE is_active=1 ORDER BY name_ar");
}
function options(rows, valueKey, labelFn) {
  return rows.map((r) => ({ value: r[valueKey], label: labelFn(r) }));
}

async function dashboard() {
  const [a, j, p, products, sales, purchases] = await Promise.all([
    query("SELECT COUNT(*) AS n FROM accounts"),
    query("SELECT COUNT(*) AS n FROM journal_entries WHERE status='posted'"),
    query("SELECT COUNT(*) AS n FROM parties WHERE is_active=1"),
    query("SELECT COUNT(*) AS n FROM products WHERE is_active=1"),
    query("SELECT COUNT(*) AS n FROM sales_invoices WHERE status='posted'"),
    query("SELECT COUNT(*) AS n FROM purchase_invoices WHERE status='posted'")
  ]);
  return heading("لوحة التحكم", "نظرة عامة على قاعدة بيانات SQLite المحلية") +
    '<section class="grid">' +
    metric("الحسابات", a[0].n) + metric("القيود المرحلة", j[0].n) +
    metric("العملاء والموردون", p[0].n) + metric("المنتجات", products[0].n) +
    metric("فواتير المبيعات", sales[0].n) + metric("فواتير المشتريات", purchases[0].n) +
    "</section>" +
    '<div class="card"><h3>حالة النظام</h3><p class="success">قاعدة البيانات المحلية متصلة. لا يحتاج تشغيل المحاسبة الأساسية إلى اتصال بالإنترنت.</p><p class="muted">بعض الوظائف المتقدمة مثل المرتجعات، التسويات البنكية ونقل البيانات بين أجهزة Android ما زالت قيد التنفيذ.</p></div>';
}
function metric(label, value) {
  return '<div class="card"><div class="muted">' + label + '</div><div class="metric">' + esc(value) + "</div></div>";
}

async function accountsPage() {
  await loadAccounts();
  return heading("دليل الحسابات", "إضافة الحسابات وتصنيفها وربطها بدليل محاسبي") +
    '<div class="card"><form id="account-form" class="row">' +
    field("رمز الحساب", "code") + field("اسم الحساب", "name") +
    selectField("نوع الحساب", "type", [
      { value: "asset", label: "أصول" }, { value: "liability", label: "التزامات" },
      { value: "equity", label: "حقوق ملكية" }, { value: "revenue", label: "إيرادات" }, { value: "expense", label: "مصروفات" }
    ]) +
    selectField("طبيعة الرصيد", "side", [{ value: "debit", label: "مدين" }, { value: "credit", label: "دائن" }]) +
    selectField("قابل للترحيل", "postable", [{ value: "1", label: "نعم" }, { value: "0", label: "لا - حساب تجميعي" }]) +
    '<button class="primary" type="submit">إضافة الحساب</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>الرمز</th><th>اسم الحساب</th><th>النوع</th><th>طبيعة الرصيد</th><th>الترحيل</th></tr></thead><tbody>' +
    accounts.map((a) => "<tr><td>" + esc(a.code) + "</td><td>" + esc(a.name) + "</td><td>" + esc(a.type) + "</td><td>" + (a.normal_side === "debit" ? "مدين" : "دائن") + "</td><td>" + (a.is_postable ? "مسموح" : "تجميعي") + "</td></tr>").join("") +
    "</tbody></table></div>";
}
async function journalPage() {
  await loadAccounts();
  const selectable = accounts.filter((a) => a.is_active && a.is_postable);
  const accountOptions = options(selectable, "code", (a) => a.code + " - " + a.name);
  const currencies = await getCurrencies();
  return heading("قيود اليومية", "ترحيل القيد المزدوج؛ يتحقق النظام من توازن المدين والدائن قبل الحفظ") +
    '<div class="card"><form id="journal-form" class="row">' +
    field("رقم القيد", "reference") + field("التاريخ", "date", "date") + field("البيان", "memo", "text", false) +
    selectField("الحساب المدين", "debit", accountOptions) + selectField("الحساب الدائن", "credit", accountOptions) +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    field("المبلغ", "amount", "number", true, 'min="0.01" step="0.01"') +
    '<button class="primary" type="submit">ترحيل القيد</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>رقم القيد</th><th>التاريخ</th><th>البيان</th><th>الحالة</th></tr></thead><tbody>' +
    (await query("SELECT entry_no,entry_date,memo,status FROM journal_entries ORDER BY entry_date DESC,id DESC LIMIT 100")).map((j) => "<tr><td>" + esc(j.entry_no) + "</td><td>" + esc(j.entry_date) + "</td><td>" + esc(j.memo) + "</td><td>" + esc(j.status) + "</td></tr>").join("") +
    "</tbody></table></div>";
}
async function trialPage() {
  const currencies = await getCurrencies();
  const base = await query("SELECT base_currency FROM company_settings WHERE id=1");
  const currency = base[0]?.base_currency || "YER";
  const rows = await query("SELECT a.code,a.name_ar,COALESCE(SUM(CASE WHEN j.status='posted' THEN l.debit ELSE 0 END),0) AS debit,COALESCE(SUM(CASE WHEN j.status='posted' THEN l.credit ELSE 0 END),0) AS credit FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id AND l.currency_code=? LEFT JOIN journal_entries j ON j.id=l.journal_id GROUP BY a.id ORDER BY a.code", [currency]);
  const totalDebit = rows.reduce((n, r) => n + Number(r.debit), 0);
  const totalCredit = rows.reduce((n, r) => n + Number(r.credit), 0);
  return heading("ميزان المراجعة", "أرصدة القيود المرحلة بالعملة: " + currency) +
    '<div class="card table-wrap"><table><thead><tr><th>الحساب</th><th>الاسم</th><th>مدين</th><th>دائن</th><th>الفرق</th></tr></thead><tbody>' +
    rows.map((r) => "<tr><td>" + esc(r.code) + "</td><td>" + esc(r.name_ar) + "</td><td>" + money(r.debit) + "</td><td>" + money(r.credit) + "</td><td>" + money(Number(r.debit)-Number(r.credit)) + "</td></tr>").join("") +
    "</tbody><tfoot><tr><th colspan=2>الإجمالي</th><th>" + money(totalDebit) + "</th><th>" + money(totalCredit) + "</th><th>" + money(totalDebit-totalCredit) + "</th></tr></tfoot></table></div>" +
    message(Math.abs(totalDebit-totalCredit) < 0.00001 ? "ميزان المراجعة متوازن." : "تنبيه: يوجد فرق في ميزان المراجعة.", Math.abs(totalDebit-totalCredit) < 0.00001 ? "success" : "");
}

async function partiesPage() {
  const rows = await query("SELECT p.party_code,p.name_ar,p.party_type,p.phone FROM parties p WHERE p.is_active=1 ORDER BY p.name_ar");
  return heading("العملاء والموردون", "سجل موحد للأطراف مع ربط حسابات الذمم المدينة والدائنة") +
    '<div class="card"><form id="party-form" class="row">' +
    field("رمز الطرف", "code") + field("الاسم", "name") +
    selectField("نوع الطرف", "type", [{ value: "customer", label: "عميل" }, { value: "supplier", label: "مورد" }, { value: "both", label: "عميل ومورد" }]) +
    field("الهاتف", "phone", "tel", false) + field("العنوان", "address", "text", false) + field("الرقم الضريبي", "taxNumber", "text", false) +
    '<button class="primary" type="submit">حفظ الطرف</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>الرمز</th><th>الاسم</th><th>النوع</th><th>الهاتف</th></tr></thead><tbody>' +
    rows.map((p) => "<tr><td>" + esc(p.party_code) + "</td><td>" + esc(p.name_ar) + "</td><td>" + esc(p.party_type) + "</td><td>" + esc(p.phone) + "</td></tr>").join("") +
    "</tbody></table></div>";
}

async function productsPage() {
  const [products, warehouses, stock] = await Promise.all([
    getProducts(), getWarehouses(),
    query("SELECT p.sku,p.name_ar,w.name_ar AS warehouse,COALESCE(SUM(s.quantity_in-s.quantity_out),0) AS quantity FROM products p CROSS JOIN warehouses w LEFT JOIN stock_movements s ON s.product_id=p.id AND s.warehouse_id=w.id GROUP BY p.id,w.id ORDER BY p.name_ar,w.name_ar")
  ]);
  return heading("المنتجات والمخازن", "تعريف الأصناف والمستودعات وعرض رصيد الكميات المسجلة بحركات المخزون") +
    '<div class="card"><h3>إضافة منتج</h3><form id="product-form" class="row">' +
    field("رمز الصنف", "sku") + field("اسم الصنف", "name") + field("الوحدة", "unit", "text", false) +
    field("باركود", "barcode", "text", false) + field("تكلفة الشراء", "purchaseCost", "number", false, 'min="0" step="0.01"') +
    field("سعر البيع", "salePrice", "number", false, 'min="0" step="0.01"') + field("نسبة الضريبة %", "taxRate", "number", false, 'min="0" max="100" step="0.01"') +
    selectField("نوع الصنف", "isService", [{ value: "0", label: "مخزني" }, { value: "1", label: "خدمة" }]) +
    '<button class="primary" type="submit">حفظ المنتج</button></form></div>' +
    '<div class="card"><h3>إضافة مستودع</h3><form id="warehouse-form" class="row">' +
    field("رمز المستودع", "code") + field("اسم المستودع", "name") + field("العنوان", "address", "text", false) +
    '<button class="primary" type="submit">حفظ المستودع</button></form></div>' +
    '<div class="card table-wrap"><h3>المنتجات</h3><table><thead><tr><th>الرمز</th><th>المنتج</th><th>الوحدة</th><th>تكلفة الشراء</th><th>سعر البيع</th><th>الضريبة %</th></tr></thead><tbody>' +
    products.map((p) => "<tr><td>" + esc(p.sku) + "</td><td>" + esc(p.name_ar) + "</td><td>" + esc(p.unit || "قطعة") + "</td><td>" + money(p.purchase_cost) + "</td><td>" + money(p.sale_price) + "</td><td>" + money(p.tax_rate) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card table-wrap"><h3>أرصدة المخزون حسب المستودع</h3><table><thead><tr><th>الرمز</th><th>الصنف</th><th>المستودع</th><th>الكمية</th></tr></thead><tbody>' +
    stock.map((s) => "<tr><td>" + esc(s.sku) + "</td><td>" + esc(s.name_ar) + "</td><td>" + esc(s.warehouse) + "</td><td>" + money(s.quantity) + "</td></tr>").join("") +
    "</tbody></table><p class=\"muted\">رصيد الكمية لا يغني عن تقييم المخزون بالتكلفة المتحركة؛ تقييم التكلفة يُحسب عند ترحيل الفواتير.</p></div>";
}

async function salesPage() {
  const [customers, products, warehouses, currencies, invoices, returns] = await Promise.all([
    getParties("customer"), getProducts(), getWarehouses(), getCurrencies(),
    query("SELECT s.invoice_no,s.invoice_date,p.name_ar AS customer,s.currency_code,s.grand_total,s.status FROM sales_invoices s JOIN parties p ON p.id=s.party_id ORDER BY s.invoice_date DESC,s.id DESC"),
    query("SELECT r.return_no,r.return_date,i.invoice_no,p.name_ar AS customer,r.currency_code,r.grand_total,r.status FROM sales_returns r JOIN sales_invoices i ON i.id=r.original_invoice_id JOIN parties p ON p.id=r.party_id ORDER BY r.return_date DESC,r.id DESC")
  ]);
  const postedInvoices = invoices.filter((invoice) => invoice.status === "posted");
  return heading("المبيعات", "ترحيل فواتير البيع والمرتجعات إلى المخزون والذمم والإيرادات والضرائب") +
    '<div class="card"><h3>فاتورة بيع</h3><form id="sales-form" class="row">' +
    field("رقم الفاتورة", "number") + field("التاريخ", "date", "date") +
    selectField("العميل", "partyId", options(customers, "id", (p) => p.name_ar + " (" + p.party_code + ")")) +
    selectField("المستودع", "warehouseId", options(warehouses, "id", (w) => w.name_ar)) +
    '<div id="sales-lines" class="invoice-lines"><div class="invoice-line row">' +
    selectField("المنتج", "productId", options(products, "id", (p) => p.name_ar + " (" + p.sku + ")")) +
    field("الكمية", "quantity", "number", true, 'min="0.0001" step="0.0001"') +
    field("سعر الوحدة", "unitPrice", "number", true, 'min="0" step="0.01"') +
    field("الخصم", "discount", "number", false, 'min="0" step="0.01"') +
    field("الضريبة %", "taxRate", "number", false, 'min="0" max="100" step="0.01"') +
    '<button type="button" class="secondary remove-invoice-line">حذف السطر</button></div></div>' +
    '<button type="button" class="secondary" data-add-line="sales-lines">إضافة صنف آخر</button>' +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">ترحيل فاتورة البيع</button></form></div>' +
    '<div class="card table-wrap"><h3>فواتير المبيعات</h3><table><thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>العميل</th><th>العملة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>' +
    invoices.map((i) => "<tr><td>" + esc(i.invoice_no) + "</td><td>" + esc(i.invoice_date) + "</td><td>" + esc(i.customer) + "</td><td>" + esc(i.currency_code) + "</td><td>" + money(i.grand_total) + "</td><td>" + esc(i.status) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card"><h3>مرتجع مبيعات مرتبط بفاتورة أصلية</h3><form id="sales-return-form" class="row">' +
    field("رقم المرتجع", "number") + field("تاريخ المرتجع", "date", "date") +
    selectField("فاتورة البيع الأصلية", "originalInvoice", options(postedInvoices, "invoice_no", (i) => i.invoice_no + " — " + i.customer)) +
    selectField("الصنف المرتجع", "productId", options(products, "id", (p) => p.name_ar + " (" + p.sku + ")")) +
    field("كمية المرتجع", "quantity", "number", true, 'min="0.0001" step="0.0001"') +
    field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">ترحيل مرتجع المبيعات</button></form></div>' +
    '<div class="card table-wrap"><h3>سجل مرتجعات المبيعات</h3><table><thead><tr><th>رقم المرتجع</th><th>التاريخ</th><th>الفاتورة الأصلية</th><th>العميل</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>' +
    returns.map((r) => "<tr><td>" + esc(r.return_no) + "</td><td>" + esc(r.return_date) + "</td><td>" + esc(r.invoice_no) + "</td><td>" + esc(r.customer) + "</td><td>" + money(r.grand_total) + " " + esc(r.currency_code) + "</td><td>" + esc(r.status) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    message("تدعم واجهة الإصدار الحالي صنفاً واحداً في كل فاتورة أو مرتجع. محرك الخدمة يدعم عدة أسطر؛ الدفعات الجزئية وتسويات حساب العميل ما زالت غير مكتملة.");
}

async function purchasesPage() {
  const [suppliers, products, warehouses, currencies, invoices, returns] = await Promise.all([
    getParties("supplier"), getProducts(), getWarehouses(), getCurrencies(),
    query("SELECT s.invoice_no,s.invoice_date,p.name_ar AS supplier,s.currency_code,s.grand_total,s.status FROM purchase_invoices s JOIN parties p ON p.id=s.party_id ORDER BY s.invoice_date DESC,s.id DESC"),
    query("SELECT r.return_no,r.return_date,i.invoice_no,p.name_ar AS supplier,r.currency_code,r.grand_total,r.status FROM purchase_returns r JOIN purchase_invoices i ON i.id=r.original_invoice_id JOIN parties p ON p.id=r.party_id ORDER BY r.return_date DESC,r.id DESC")
  ]);
  const stockProducts = products.filter((p) => !p.is_service);
  const postedInvoices = invoices.filter((invoice) => invoice.status === "posted");
  return heading("المشتريات", "استلام البضاعة وترحيل فواتير الشراء ومرتجعات الموردين") +
    '<div class="card"><h3>فاتورة شراء</h3><form id="purchase-form" class="row">' +
    field("رقم الفاتورة", "number") + field("التاريخ", "date", "date") +
    selectField("المورد", "partyId", options(suppliers, "id", (p) => p.name_ar + " (" + p.party_code + ")")) +
    selectField("المستودع", "warehouseId", options(warehouses, "id", (w) => w.name_ar)) +
    '<div id="purchase-lines" class="invoice-lines"><div class="invoice-line row">' +
    selectField("المنتج", "productId", options(stockProducts, "id", (p) => p.name_ar + " (" + p.sku + ")")) +
    field("الكمية", "quantity", "number", true, 'min="0.0001" step="0.0001"') +
    field("تكلفة الوحدة", "unitCost", "number", true, 'min="0" step="0.01"') +
    field("الضريبة %", "taxRate", "number", false, 'min="0" max="100" step="0.01"') +
    '<button type="button" class="secondary remove-invoice-line">حذف السطر</button></div></div>' +
    '<button type="button" class="secondary" data-add-line="purchase-lines">إضافة صنف آخر</button>' +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">ترحيل فاتورة الشراء</button></form></div>' +
    '<div class="card table-wrap"><h3>فواتير المشتريات</h3><table><thead><tr><th>رقم الفاتورة</th><th>التاريخ</th><th>المورد</th><th>العملة</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>' +
    invoices.map((i) => "<tr><td>" + esc(i.invoice_no) + "</td><td>" + esc(i.invoice_date) + "</td><td>" + esc(i.supplier) + "</td><td>" + esc(i.currency_code) + "</td><td>" + money(i.grand_total) + "</td><td>" + esc(i.status) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card"><h3>مرتجع مشتريات مرتبط بفاتورة أصلية</h3><form id="purchase-return-form" class="row">' +
    field("رقم المرتجع", "number") + field("تاريخ المرتجع", "date", "date") +
    selectField("فاتورة الشراء الأصلية", "originalInvoice", options(postedInvoices, "invoice_no", (i) => i.invoice_no + " — " + i.supplier)) +
    selectField("الصنف المرتجع", "productId", options(stockProducts, "id", (p) => p.name_ar + " (" + p.sku + ")")) +
    field("كمية المرتجع", "quantity", "number", true, 'min="0.0001" step="0.0001"') +
    field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">ترحيل مرتجع المشتريات</button></form></div>' +
    '<div class="card table-wrap"><h3>سجل مرتجعات المشتريات</h3><table><thead><tr><th>رقم المرتجع</th><th>التاريخ</th><th>الفاتورة الأصلية</th><th>المورد</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>' +
    returns.map((r) => "<tr><td>" + esc(r.return_no) + "</td><td>" + esc(r.return_date) + "</td><td>" + esc(r.invoice_no) + "</td><td>" + esc(r.supplier) + "</td><td>" + money(r.grand_total) + " " + esc(r.currency_code) + "</td><td>" + esc(r.status) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    message("تدعم واجهة الإصدار الحالي صنفاً واحداً في كل فاتورة أو مرتجع. أوامر الشراء والاستلام المرحلي والدفعات الجزئية وتسويات المورد ما زالت غير مكتملة.");
}

async function cashPage() {
  const currencies = await getCurrencies();
  const [boxes, banks, parties, transactions, balances] = await Promise.all([
    query("SELECT c.id,c.code,c.name_ar,c.currency_code,a.code AS account_code FROM cash_boxes c JOIN accounts a ON a.id=c.account_id WHERE c.is_active=1 ORDER BY c.name_ar"),
    query("SELECT b.id,b.bank_name,b.account_name,b.account_number,b.currency_code,a.code AS account_code FROM bank_accounts b JOIN accounts a ON a.id=b.account_id WHERE b.is_active=1 ORDER BY b.bank_name"),
    getParties(),
    query("SELECT t.transaction_no,t.transaction_date,t.transaction_type,p.name_ar AS party,t.currency_code,t.amount,t.memo FROM cash_transactions t JOIN parties p ON p.id=t.party_id ORDER BY t.transaction_date DESC,t.id DESC"),
    query("SELECT p.party_code,p.name_ar,p.party_type,l.currency_code,SUM(CASE WHEN a.code='1200' THEN l.debit-l.credit ELSE 0 END) AS receivable,SUM(CASE WHEN a.code='2100' THEN l.credit-l.debit ELSE 0 END) AS payable FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_id JOIN accounts a ON a.id=l.account_id JOIN parties p ON p.id=l.party_id WHERE j.status='posted' AND a.code IN ('1200','2100') GROUP BY p.id,p.party_code,p.name_ar,p.party_type,l.currency_code HAVING ABS(receivable)>0.000001 OR ABS(payable)>0.000001 ORDER BY p.name_ar,l.currency_code")
  ]);
  const cashSources = [
    ...boxes.map((b) => ({ value: "cash:" + b.id, label: "صندوق: " + b.name_ar + " (" + b.currency_code + ")" })),
    ...banks.map((b) => ({ value: "bank:" + b.id, label: "بنك: " + b.bank_name + " / " + b.account_name + " (" + b.currency_code + ")" }))
  ];
  return heading("الصناديق والبنوك", "تعريف الحسابات النقدية وتسجيل سندات قبض العملاء وسندات صرف الموردين") +
    '<div class="card"><h3>صندوق نقدي</h3><form id="cashbox-form" class="row">' +
    field("رمز الصندوق", "code") + field("اسم الصندوق", "name") +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    selectField("حساب الأستاذ", "accountCode", options(accounts.filter((a) => a.type === "asset" && a.is_postable), "code", (a) => a.code + " - " + a.name)) +
    '<button class="primary" type="submit">إضافة صندوق</button></form></div>' +
    '<div class="card"><h3>حساب بنكي</h3><form id="bank-form" class="row">' +
    field("اسم البنك", "bankName") + field("اسم الحساب", "accountName") + field("رقم الحساب", "accountNumber", "text", false) +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    selectField("حساب الأستاذ", "accountCode", options(accounts.filter((a) => a.type === "asset" && a.is_postable), "code", (a) => a.code + " - " + a.name)) +
    '<button class="primary" type="submit">إضافة حساب بنكي</button></form></div>' +
    '<div class="card"><h3>سند قبض أو صرف مرتبط بالطرف</h3><form id="settlement-form" class="row">' +
    field("رقم السند", "number") + field("التاريخ", "date", "date") +
    selectField("نوع السند", "type", [{ value: "receipt", label: "قبض من عميل" }, { value: "payment", label: "صرف إلى مورد" }]) +
    selectField("العميل أو المورد", "partyId", options(parties, "id", (p) => p.name_ar + " (" + p.party_code + ")")) +
    selectField("الصندوق أو البنك", "accountRef", cashSources) +
    field("المبلغ", "amount", "number", true, 'min="0.01" step="0.01"') +
    selectField("العملة", "currency", options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")")) +
    field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">ترحيل السند والقيد</button></form></div>' +
    '<div class="card table-wrap"><h3>أرصدة العملاء والموردين حسب العملة</h3><table><thead><tr><th>الرمز</th><th>الطرف</th><th>النوع</th><th>العملة</th><th>ذمم مدينة</th><th>ذمم دائنة</th></tr></thead><tbody>' +
    balances.map((b) => "<tr><td>" + esc(b.party_code) + "</td><td>" + esc(b.name_ar) + "</td><td>" + esc(b.party_type) + "</td><td>" + esc(b.currency_code) + "</td><td>" + money(b.receivable) + "</td><td>" + money(b.payable) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card table-wrap"><h3>سجل سندات القبض والصرف</h3><table><thead><tr><th>رقم السند</th><th>التاريخ</th><th>النوع</th><th>الطرف</th><th>المبلغ</th><th>البيان</th></tr></thead><tbody>' +
    transactions.map((t) => "<tr><td>" + esc(t.transaction_no) + "</td><td>" + esc(t.transaction_date) + "</td><td>" + (t.transaction_type === "receipt" ? "قبض" : "صرف") + "</td><td>" + esc(t.party) + "</td><td>" + money(t.amount) + " " + esc(t.currency_code) + "</td><td>" + esc(t.memo) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card table-wrap"><h3>الصناديق</h3><table><thead><tr><th>الرمز</th><th>الصندوق</th><th>العملة</th><th>حساب الأستاذ</th></tr></thead><tbody>' +
    boxes.map((b) => "<tr><td>" + esc(b.code) + "</td><td>" + esc(b.name_ar) + "</td><td>" + esc(b.currency_code) + "</td><td>" + esc(b.account_code) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card table-wrap"><h3>الحسابات البنكية</h3><table><thead><tr><th>البنك</th><th>اسم الحساب</th><th>رقم الحساب</th><th>العملة</th><th>حساب الأستاذ</th></tr></thead><tbody>' +
    banks.map((b) => "<tr><td>" + esc(b.bank_name) + "</td><td>" + esc(b.account_name) + "</td><td>" + esc(b.account_number) + "</td><td>" + esc(b.currency_code) + "</td><td>" + esc(b.account_code) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    message("سندات القبض والصرف وتحديث أرصدة الأطراف أصبحت مدعومة. التحويل بين الصناديق والبنوك والتسوية البنكية وكشف أعمار الديون ما زالت قيد الاستكمال.");
}

async function expensesPage() {
  const currencies = await getCurrencies();
  const expenseAccounts = accounts.filter((a) => a.type === "expense" && a.is_postable);
  const revenueAccounts = accounts.filter((a) => a.type === "revenue" && a.is_postable);
  const [expenses, revenues] = await Promise.all([
    query("SELECT e.expense_no,e.expense_date,a.name_ar,e.amount,e.currency_code FROM expenses e JOIN accounts a ON a.id=e.account_id ORDER BY e.expense_date DESC"),
    query("SELECT e.revenue_no,e.revenue_date,a.name_ar,e.amount,e.currency_code FROM revenues e JOIN accounts a ON a.id=e.account_id ORDER BY e.revenue_date DESC")
  ]);
  const currencyOptions = options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")");
  return heading("المصروفات والإيرادات", "إثبات المصروف أو الإيراد مع إنشاء قيد محاسبي مزدوج تلقائياً") +
    '<div class="card"><h3>تسجيل مصروف</h3><form id="expense-form" class="row">' +
    field("رقم السند", "number") + field("التاريخ", "date", "date") + field("المبلغ", "amount", "number", true, 'min="0.01" step="0.01"') +
    selectField("الحساب", "accountCode", options(expenseAccounts, "code", (a) => a.code + " - " + a.name)) +
    selectField("العملة", "currency", currencyOptions) + field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">حفظ المصروف وترحيله</button></form></div>' +
    '<div class="card"><h3>تسجيل إيراد</h3><form id="revenue-form" class="row">' +
    field("رقم السند", "number") + field("التاريخ", "date", "date") + field("المبلغ", "amount", "number", true, 'min="0.01" step="0.01"') +
    selectField("الحساب", "accountCode", options(revenueAccounts, "code", (a) => a.code + " - " + a.name)) +
    selectField("العملة", "currency", currencyOptions) + field("البيان", "memo", "text", false) +
    '<button class="primary" type="submit">حفظ الإيراد وترحيله</button></form></div>' +
    '<div class="card table-wrap"><h3>المصروفات</h3><table><thead><tr><th>السند</th><th>التاريخ</th><th>الحساب</th><th>المبلغ</th><th>العملة</th></tr></thead><tbody>' +
    expenses.map((e) => "<tr><td>" + esc(e.expense_no) + "</td><td>" + esc(e.expense_date) + "</td><td>" + esc(e.name_ar) + "</td><td>" + money(e.amount) + "</td><td>" + esc(e.currency_code) + "</td></tr>").join("") +
    "</tbody></table></div><div class=\"card table-wrap\"><h3>الإيرادات</h3><table><thead><tr><th>السند</th><th>التاريخ</th><th>الحساب</th><th>المبلغ</th><th>العملة</th></tr></thead><tbody>" +
    revenues.map((e) => "<tr><td>" + esc(e.revenue_no) + "</td><td>" + esc(e.revenue_date) + "</td><td>" + esc(e.name_ar) + "</td><td>" + money(e.amount) + "</td><td>" + esc(e.currency_code) + "</td></tr>").join("") +
    "</tbody></table></div>";
}

async function taxesPage() {
  const taxes = await query("SELECT code,name_ar,rate,tax_type,is_active FROM tax_rates ORDER BY code");
  return heading("الضرائب", "تعريف نسب الضرائب وتصنيف ضريبة المبيعات والمشتريات والاستقطاع") +
    '<div class="card"><form id="tax-form" class="row">' +
    field("رمز الضريبة", "code") + field("اسم الضريبة", "name") + field("النسبة %", "rate", "number", true, 'min="0" max="100" step="0.01"') +
    selectField("نوع الضريبة", "type", [{ value: "sales", label: "مبيعات" }, { value: "purchase", label: "مشتريات" }, { value: "withholding", label: "استقطاع" }]) +
    '<button class="primary" type="submit">إضافة ضريبة</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>الرمز</th><th>الاسم</th><th>النسبة</th><th>النوع</th><th>الحالة</th></tr></thead><tbody>' +
    taxes.map((t) => "<tr><td>" + esc(t.code) + "</td><td>" + esc(t.name_ar) + "</td><td>" + money(t.rate) + "%</td><td>" + esc(t.tax_type) + "</td><td>" + (t.is_active ? "نشطة" : "موقوفة") + "</td></tr>").join("") +
    "</tbody></table></div>" + message("تم إعداد سجل نسب الضريبة. الإقرارات الضريبية والتسويات التفصيلية وتقارير الالتزام لم تُنفّذ بعد.");
}

async function currenciesPage() {
  const currencies = await query("SELECT code,name_ar,minor_unit,is_active FROM currencies ORDER BY code");
  const rates = await query("SELECT from_currency,to_currency,rate,effective_date FROM exchange_rates ORDER BY effective_date DESC");
  const optsCurrency = options(currencies, "code", (c) => c.name_ar + " (" + c.code + ")");
  return heading("العملات وأسعار الصرف", "تعريف العملات وأسعار التحويل حسب تاريخ السريان") +
    '<div class="card"><form id="currency-form" class="row">' +
    field("رمز العملة ISO", "code", "text", true, 'maxlength="3"') + field("اسم العملة", "name") +
    field("الخانات العشرية", "decimals", "number", true, 'min="0" max="4" value="2"') +
    '<button class="primary" type="submit">إضافة عملة</button></form></div>' +
    '<div class="card"><form id="rate-form" class="row">' +
    selectField("من عملة", "from", optsCurrency) + selectField("إلى عملة", "to", optsCurrency) +
    field("سعر الصرف", "rate", "number", true, 'min="0.000001" step="0.000001"') +
    field("تاريخ السريان", "date", "date") + '<button class="primary" type="submit">حفظ سعر الصرف</button></form></div>' +
    '<div class="card table-wrap"><h3>العملات</h3><table><thead><tr><th>الرمز</th><th>الاسم</th><th>الخانات</th><th>الحالة</th></tr></thead><tbody>' +
    currencies.map((c) => "<tr><td>" + esc(c.code) + "</td><td>" + esc(c.name_ar) + "</td><td>" + c.minor_unit + "</td><td>" + (c.is_active ? "نشطة" : "موقوفة") + "</td></tr>").join("") +
    "</tbody></table></div><div class=\"card table-wrap\"><h3>أسعار الصرف</h3><table><thead><tr><th>من</th><th>إلى</th><th>السعر</th><th>التاريخ</th></tr></thead><tbody>" +
    rates.map((r) => "<tr><td>" + esc(r.from_currency) + "</td><td>" + esc(r.to_currency) + "</td><td>" + money(r.rate) + "</td><td>" + esc(r.effective_date) + "</td></tr>").join("") +
    "</tbody></table></div>" + message("تسجيل العملات وأسعار الصرف متاح. إعادة تقييم أرصدة العملات الأجنبية وفروق أسعار الصرف لم تكتمل بعد.");
}

async function assetsPage() {
  const [assets, accountsList] = await Promise.all([
    query("SELECT f.id,f.asset_code,f.name_ar,f.acquisition_date,f.cost,f.residual_value,f.useful_life_months,f.status,COALESCE(SUM(d.amount),0) AS accumulated FROM fixed_assets f LEFT JOIN depreciation_runs d ON d.asset_id=f.id GROUP BY f.id ORDER BY f.acquisition_date DESC"),
    loadAccounts()
  ]);
  return heading("الأصول الثابتة والإهلاك", "تسجيل الأصل وحساب قسط الإهلاك بطريقة القسط الثابت وترحيله") +
    '<div class="card"><form id="asset-form" class="row">' +
    field("رمز الأصل", "code") + field("اسم الأصل", "name") + field("تاريخ الشراء", "date", "date") +
    field("التكلفة", "cost", "number", true, 'min="0.01" step="0.01"') +
    field("القيمة المتبقية", "residual", "number", false, 'min="0" step="0.01"') +
    field("العمر الإنتاجي بالأشهر", "life", "number", true, 'min="1" step="1"') +
    '<button class="primary" type="submit">تسجيل الأصل</button></form></div>' +
    '<div class="card"><form id="depreciation-form" class="row">' +
    selectField("الأصل", "assetId", options(assets, "id", (a) => a.asset_code + " - " + a.name_ar)) +
    field("فترة الإهلاك YYYY-MM", "period", "month") +
    '<button class="primary" type="submit">احتساب وترحيل الإهلاك</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>الرمز</th><th>الأصل</th><th>التاريخ</th><th>التكلفة</th><th>مجمع الإهلاك</th><th>صافي القيمة</th><th>العمر (شهر)</th></tr></thead><tbody>' +
    assets.map((a) => "<tr><td>" + esc(a.asset_code) + "</td><td>" + esc(a.name_ar) + "</td><td>" + esc(a.acquisition_date) + "</td><td>" + money(a.cost) + "</td><td>" + money(a.accumulated) + "</td><td>" + money(Number(a.cost)-Number(a.accumulated)) + "</td><td>" + a.useful_life_months + "</td></tr>").join("") +
    "</tbody></table></div>" + message("الإهلاك بالقسط الثابت متاح بالعملة الأساسية YER. طرق وحدات الإنتاج وإعادة التقييم والاستبعاد لم تُنفّذ بعد.");
}

async function loadPostedEntries() {
  const rows = await query("SELECT j.entry_no,j.entry_date,j.memo,l.debit,l.credit,l.currency_code,a.code AS account_code,a.name_ar,a.account_type,a.cash_flow_category FROM journal_entries j JOIN journal_lines l ON l.journal_id=j.id JOIN accounts a ON a.id=l.account_id WHERE j.status='posted' ORDER BY j.entry_date,j.entry_no,l.line_no");
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.entry_no)) map.set(row.entry_no, { reference: row.entry_no, date: row.entry_date, memo: row.memo, status: "posted", lines: [] });
    map.get(row.entry_no).lines.push({
      accountCode: row.account_code, debit: Number(row.debit), credit: Number(row.credit),
      currency: row.currency_code, memo: row.memo, cashFlowCategory: row.cash_flow_category
    });
  }
  return [...map.values()];
}
async function reportsPage() {
  const [entries, chart, currencies] = await Promise.all([loadPostedEntries(), loadAccounts(), getCurrencies()]);
  const base = await query("SELECT base_currency FROM company_settings WHERE id=1");
  const currency = base[0]?.base_currency || "YER";
  const tb = trialBalance(entries, chart, currency);
  const income = incomeStatement(entries, chart, currency);
  const sheet = balanceSheet(entries, chart, currency);
  const cashCodes = (await query("SELECT a.code FROM accounts a WHERE a.code='1100'")).map((a) => a.code);
  const flow = cashFlow(entries, chart, cashCodes, currency);
  return heading("القوائم المالية والتقارير", "تقارير مستخرجة من القيود المرحلة فقط — العملة " + currency) +
    '<div class="grid">' +
    metric("الإيرادات", money(income.revenue)) + metric("المصروفات", money(income.expenses)) +
    metric("صافي الربح / الخسارة", money(income.netIncome)) + metric("إجمالي الأصول", money(sheet.assets)) +
    metric("الالتزامات وحقوق الملكية", money(sheet.liabilitiesAndEquity)) + metric("صافي التدفق النقدي", money(flow.netChange)) +
    "</div>" + message(sheet.balanced ? "الميزانية متوازنة وفق القيود المرحلة." : "الميزانية غير متوازنة؛ راجع أرصدة الحسابات والقيود.", sheet.balanced ? "success" : "") +
    '<div class="card table-wrap"><h3>ميزان المراجعة</h3><table><thead><tr><th>الرمز</th><th>الحساب</th><th>مدين</th><th>دائن</th><th>صافي الرصيد</th></tr></thead><tbody>' +
    tb.map((r) => "<tr><td>" + esc(r.code) + "</td><td>" + esc(r.name) + "</td><td>" + money(r.debit) + "</td><td>" + money(r.credit) + "</td><td>" + money(r.balance) + "</td></tr>").join("") +
    "</tbody></table></div>" +
    '<div class="card"><h3>قائمة الدخل</h3><p>الإيرادات: <b>' + money(income.revenue) + " " + currency + '</b></p><p>المصروفات: <b>' + money(income.expenses) + " " + currency + '</b></p><p>صافي الربح / الخسارة: <b>' + money(income.netIncome) + " " + currency + "</b></p></div>" +
    '<div class="card"><h3>الميزانية العمومية</h3><p>الأصول: ' + money(sheet.assets) + "</p><p>الالتزامات: " + money(sheet.liabilities) + "</p><p>حقوق الملكية بعد نتيجة الفترة: " + money(sheet.equity) + "</p></div>" +
    '<div class="card"><h3>التدفقات النقدية المباشرة المبسطة</h3><p>تشغيلية: ' + money(flow.operating) + " — استثمارية: " + money(flow.investing) + " — تمويلية: " + money(flow.financing) + "</p></div>" +
    message("هذه القوائم أولية؛ لم تُنفّذ بعد إقفال الفترات، أرصدة الافتتاح، التسويات، الاستحقاقات، فروق العملات وإعداد التدفقات النقدية وفق التصنيف الكامل.");
}

async function backupPage() {
  const count = await query("SELECT COUNT(*) AS n FROM journal_entries");
  return heading("النسخ الاحتياطي والاستعادة", "قاعدة بيانات SQLite محلية — عدد القيود المسجلة: " + count[0].n) +
    '<div class="card"><div class="actions"><button class="primary" id="backup-button">إنشاء نسخة احتياطية</button><button class="secondary" id="restore-button">استعادة نسخة احتياطية</button></div><p class="muted">على Windows تُحفظ قاعدة SQLite. على Android تُنشأ نسخة JSON كاملة وتُفتح قائمة المشاركة لنقلها محلياً، ويمكن استيراد الملف نفسه على جهاز ONYX آخر. لا تُشارك النسخة إلا مع جهة موثوقة.</p><input id="restore-file" type="file" accept=".json,application/json" hidden><div id="backup-result"></div></div>';
}

async function render(page = currentPage) {
  currentPage = page;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  try {
    const renderers = {
      dashboard, accounts: accountsPage, journal: journalPage, trial: trialPage,
      parties: partiesPage, products: productsPage, sales: salesPage, purchases: purchasesPage,
      cash: cashPage, expenses: expensesPage, taxes: taxesPage, assets: assetsPage,
      reports: reportsPage, currencies: currenciesPage, backup: backupPage
    };
    contentRoot.innerHTML = renderers[page] ? await renderers[page]() : heading("وحدة غير معروفة");
    bindForms();
  } catch (error) {
    contentRoot.innerHTML = heading("تعذر عرض الوحدة") + message(error.message || String(error));
  }
}

function bindForm(id, handler) {
  const form = $("#" + id);
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (id === "sales-form" || id === "purchase-form") {
      data.lines = [...form.querySelectorAll(".invoice-line")].map((row) => {
        const value = (name) => row.querySelector('[name="' + name + '"]').value;
        const line = {
          productId: Number(value("productId")),
          quantity: Number(value("quantity")),
          taxRate: value("taxRate") === "" ? undefined : Number(value("taxRate"))
        };
        if (id === "sales-form") {
          line.unitPrice = Number(value("unitPrice"));
          line.discount = Number(value("discount") || 0);
        } else {
          line.unitCost = Number(value("unitCost"));
        }
        return line;
      }).filter((line) => line.productId > 0 && line.quantity > 0);
      if (!data.lines.length) { alert("أضف صنفاً واحداً صحيحاً على الأقل."); return; }
    }
    try {
      await handler(data);
      await render(currentPage);
    } catch (error) {
      alert(error.message || String(error));
    }
  });
}
function bindForms() {
  document.querySelectorAll("#content [data-add-line]").forEach((button) => {
    button.addEventListener("click", () => {
      const container = document.getElementById(button.dataset.addLine);
      const first = container?.querySelector(".invoice-line");
      if (!container || !first) return;
      const row = first.cloneNode(true);
      row.querySelectorAll("input").forEach((input) => { input.value = ""; });
      row.querySelectorAll("select").forEach((select) => { select.selectedIndex = 0; });
      container.appendChild(row);
    });
  });
  document.querySelectorAll("#content .invoice-lines").forEach((container) => {
    container.addEventListener("click", (event) => {
      const remove = event.target.closest(".remove-invoice-line");
      if (!remove) return;
      const row = remove.closest(".invoice-line");
      if (container.querySelectorAll(".invoice-line").length > 1) {
        row.remove();
      } else {
        row.querySelectorAll("input").forEach((input) => { input.value = ""; });
        row.querySelectorAll("select").forEach((select) => { select.selectedIndex = 0; });
      }
    });
  });
  bindForm("account-form", async (f) => {
    await run("INSERT INTO accounts(code,name_ar,account_type,normal_side,is_postable) VALUES(?,?,?,?,?)",
      [f.code.trim(), f.name.trim(), f.type, f.side, Number(f.postable)]);
  });
  bindForm("journal-form", async (f) => {
    const amount = Number(f.amount);
    const entry = { date: f.date, reference: f.reference.trim(), memo: f.memo.trim(), status: "draft", lines: [
      { accountCode: f.debit, debit: amount, credit: 0, currency: f.currency },
      { accountCode: f.credit, debit: 0, credit: amount, currency: f.currency }
    ] };
    if (entry.lines[0].accountCode === entry.lines[1].accountCode) throw new Error("اختر حسابين مختلفين.");
    validateJournal(entry, await loadAccounts());
    await transaction([
      { sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,status,posted_at) VALUES(?,?,?,'posted',datetime('now'))", params: [entry.reference, entry.date, entry.memo] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),1,(SELECT id FROM accounts WHERE code=?),?,?,0,?)", params: [entry.reference, entry.lines[0].accountCode, entry.currency || f.currency, amount, entry.memo] },
      { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),2,(SELECT id FROM accounts WHERE code=?),?,0,?,?)", params: [entry.reference, entry.lines[1].accountCode, f.currency, amount, entry.memo] }
    ]);
  });
  bindForm("party-form", (f) => service.createParty(f));
  bindForm("product-form", (f) => service.createProduct({ ...f, isService: f.isService === "1" }));
  bindForm("warehouse-form", (f) => service.createWarehouse(f));
  bindForm("sales-form", (f) => service.createSalesInvoice({
    number: f.number, date: f.date, partyId: Number(f.partyId), warehouseId: Number(f.warehouseId),
    currency: f.currency, memo: f.memo, lines: f.lines
  }));
  bindForm("sales-return-form", (f) => service.createSalesReturn({
    number: f.number, originalInvoice: f.originalInvoice, date: f.date, memo: f.memo,
    lines: [{ productId: Number(f.productId), quantity: Number(f.quantity) }]
  }));
  bindForm("purchase-return-form", (f) => service.createPurchaseReturn({
    number: f.number, originalInvoice: f.originalInvoice, date: f.date, memo: f.memo,
    lines: [{ productId: Number(f.productId), quantity: Number(f.quantity) }]
  }));
  bindForm("purchase-form", (f) => service.createPurchaseInvoice({
    number: f.number, date: f.date, partyId: Number(f.partyId), warehouseId: Number(f.warehouseId),
    currency: f.currency, memo: f.memo, lines: f.lines
  }));
  bindForm("cashbox-form", (f) => run(
    "INSERT INTO cash_boxes(code,name_ar,currency_code,account_id) VALUES(?,?,?,(SELECT id FROM accounts WHERE code=?))",
    [f.code.trim(), f.name.trim(), f.currency, f.accountCode]
  ));
  bindForm("settlement-form", (f) => {
    const [sourceType, sourceId] = String(f.accountRef || "").split(":");
    if (!sourceId || !["cash", "bank"].includes(sourceType)) throw new Error("اختر صندوقاً أو حساباً بنكياً.");
    return service.postPartySettlement({
      number: f.number, date: f.date, type: f.type, partyId: Number(f.partyId),
      cashBoxId: sourceType === "cash" ? Number(sourceId) : null,
      bankAccountId: sourceType === "bank" ? Number(sourceId) : null,
      amount: Number(f.amount), currency: f.currency, memo: f.memo
    });
  });
  bindForm("bank-form", (f) => run(
    "INSERT INTO bank_accounts(bank_name,account_name,account_number,currency_code,account_id) VALUES(?,?,?,?,(SELECT id FROM accounts WHERE code=?))",
    [f.bankName.trim(), f.accountName.trim(), f.accountNumber || "", f.currency, f.accountCode]
  ));
  bindForm("expense-form", (f) => service.postExpense({
    number: f.number, date: f.date, amount: Number(f.amount), currency: f.currency,
    accountCode: f.accountCode, memo: f.memo
  }));
  bindForm("revenue-form", (f) => service.postRevenue({
    number: f.number, date: f.date, amount: Number(f.amount), currency: f.currency,
    accountCode: f.accountCode, memo: f.memo
  }));
  bindForm("tax-form", (f) => run(
    "INSERT INTO tax_rates(code,name_ar,rate,tax_type) VALUES(?,?,?,?)",
    [f.code.trim(), f.name.trim(), Number(f.rate), f.type]
  ));
  bindForm("currency-form", (f) => run(
    "INSERT INTO currencies(code,name_ar,minor_unit) VALUES(?,?,?)",
    [f.code.trim().toUpperCase(), f.name.trim(), Number(f.decimals)]
  ));
  bindForm("rate-form", (f) => run(
    "INSERT INTO exchange_rates(from_currency,to_currency,rate,effective_date) VALUES(?,?,?,?)",
    [f.from, f.to, Number(f.rate), f.date]
  ));
  bindForm("asset-form", async (f) => run(
    "INSERT INTO fixed_assets(asset_code,name_ar,acquisition_date,cost,residual_value,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id) VALUES(?,?,?,?,?,? ,(SELECT id FROM accounts WHERE code='1400'),(SELECT id FROM accounts WHERE code='1490'),(SELECT id FROM accounts WHERE code='5300'))",
    [f.code.trim(), f.name.trim(), f.date, Number(f.cost), Number(f.residual || 0), Number(f.life)]
  ));
  bindForm("depreciation-form", (f) => service.runDepreciation(Number(f.assetId), f.period));
  const backup = $("#backup-button");
  if (backup) backup.addEventListener("click", async () => {
    try {
      const result = await backupDatabase();
      $("#backup-result").innerHTML = message(result.canceled ? "تم إلغاء النسخ الاحتياطي." : "تم إنشاء النسخة: " + result.filePath, "success");
    } catch (error) { $("#backup-result").innerHTML = message(error.message); }
  });
  const restore = $("#restore-button");
  if (restore) restore.addEventListener("click", async () => {
    if (!confirm("سيتم استبدال قاعدة البيانات الحالية. تأكد من وجود نسخة احتياطية حديثة.")) return;
    if (!window.onyx?.db) {
      $("#restore-file")?.click();
      return;
    }
    try {
      const result = await restoreDatabase();
      if (result.canceled) {
        $("#backup-result").innerHTML = message("تم إلغاء الاستعادة.");
        return;
      }
      await loadAccounts();
      await render(currentPage);
      $("#backup-result").innerHTML = message("تمت استعادة قاعدة SQLite والتحقق منها.", "success");
    } catch (error) { $("#backup-result").innerHTML = message(error.message); }
  });
  const restoreFile = $("#restore-file");
  if (restoreFile) restoreFile.addEventListener("change", async () => {
    const file = restoreFile.files?.[0];
    if (!file) return;
    try {
      await restoreDatabase(file);
      await loadAccounts();
      await render(currentPage);
      $("#backup-result").innerHTML = message("تم استيراد النسخة والتحقق من سلامة الجداول والروابط.", "success");
    } catch (error) {
      $("#backup-result").innerHTML = message(error.message || String(error));
    } finally {
      restoreFile.value = "";
    }
  });
}

$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (button) render(button.dataset.page);
});
async function start() {
  try {
    await initDatabase();
    await loadAccounts();
    $("#db-status").textContent = "SQLite محلية — وضع العمل دون إنترنت";
    $("#db-status").classList.add("success");
    await render("dashboard");
  } catch (error) {
    $("#db-status").textContent = "تعذر فتح SQLite";
    contentRoot.innerHTML = heading("لم يتم فتح قاعدة البيانات") + message(error.message);
  }
}
start();