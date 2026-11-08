import "./styles.css";
import { initDatabase, query, run, transaction, backupDatabase, restoreDatabase } from "./db/index.js";
import { validateJournal } from "./core/accounting.js";

const $ = (selector) => document.querySelector(selector);
const content = $("#content");
let currentPage = "dashboard";
let accounts = [];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function money(value) { return Number(value || 0).toLocaleString("ar-YE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function message(text, kind = "") { return '<div class="notice ' + kind + '">' + esc(text) + "</div>"; }
function heading(title, subtitle = "") { return "<h2>" + title + "</h2>" + (subtitle ? '<p class="muted">' + subtitle + "</p>" : ""); }

async function loadAccounts() {
  accounts = await query("SELECT id,code,name_ar AS name,account_type AS type,normal_side,is_postable,is_active FROM accounts ORDER BY code");
  return accounts;
}
async function dashboard() {
  const [a, j, p, products, sales] = await Promise.all([
    query("SELECT COUNT(*) AS n FROM accounts"),
    query("SELECT COUNT(*) AS n FROM journal_entries WHERE status='posted'"),
    query("SELECT COUNT(*) AS n FROM parties WHERE is_active=1"),
    query("SELECT COUNT(*) AS n FROM products WHERE is_active=1"),
    query("SELECT COUNT(*) AS n FROM sales_invoices WHERE status='posted'")
  ]);
  return heading("لوحة التحكم", "نظرة عامة على قاعدة بيانات SQLite المحلية") +
    '<section class="grid">' +
    metric("الحسابات", a[0].n) + metric("القيود المرحلة", j[0].n) +
    metric("العملاء والموردون", p[0].n) + metric("المنتجات", products[0].n) +
    metric("فواتير المبيعات", sales[0].n) + metric("قاعدة البيانات", "SQLite") +
    "</section>" +
    '<div class="card"><h3>حالة النظام</h3><p class="success">قاعدة البيانات المحلية متصلة. لا يحتاج تشغيل المحاسبة الأساسية إلى اتصال بالإنترنت.</p><p class="muted">الوحدات التي لم تُنفّذ واجهاتها بعد ستظهر كقيد تطوير؛ وجود جداولها في قاعدة البيانات لا يعني اكتمالها الوظيفي.</p></div>';
}
function metric(label, value) {
  return '<div class="card"><div class="muted">' + label + '</div><div class="metric">' + esc(value) + "</div></div>";
}
async function accountsPage() {
  await loadAccounts();
  return heading("دليل الحسابات", "إضافة الحسابات وتصنيفها وربطها بدليل محاسبي") +
    '<div class="card"><form id="account-form" class="row">' +
    '<label>رمز الحساب<input name="code" required maxlength="20"></label>' +
    '<label>اسم الحساب<input name="name" required></label>' +
    '<label>نوع الحساب<select name="type"><option value="asset">أصول</option><option value="liability">التزامات</option><option value="equity">حقوق ملكية</option><option value="revenue">إيرادات</option><option value="expense">مصروفات</option></select></label>' +
    '<label>طبيعة الرصيد<select name="side"><option value="debit">مدين</option><option value="credit">دائن</option></select></label>' +
    '<label>قابل للترحيل<select name="postable"><option value="1">نعم</option><option value="0">لا - حساب تجميعي</option></select></label>' +
    '<button class="primary" type="submit">إضافة الحساب</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>الرمز</th><th>اسم الحساب</th><th>النوع</th><th>طبيعة الرصيد</th><th>الترحيل</th></tr></thead><tbody>' +
    accounts.map((a) => "<tr><td>" + esc(a.code) + "</td><td>" + esc(a.name) + "</td><td>" + esc(a.type) + "</td><td>" + (a.normal_side === "debit" ? "مدين" : "دائن") + "</td><td>" + (a.is_postable ? "مسموح" : "تجميعي") + "</td></tr>").join("") +
    "</tbody></table></div>";
}
async function journalPage() {
  await loadAccounts();
  const selectable = accounts.filter((a) => a.is_active && a.is_postable);
  const options = selectable.map((a) => '<option value="' + esc(a.code) + '">' + esc(a.code + " - " + a.name) + "</option>").join("");
  return heading("قيود اليومية", "ترحيل القيد المزدوج؛ يتحقق النظام من توازن المدين والدائن قبل الحفظ") +
    '<div class="card"><form id="journal-form" class="row">' +
    '<label>رقم القيد<input name="reference" required></label><label>التاريخ<input name="date" type="date" required value="' + new Date().toISOString().slice(0,10) + '"></label>' +
    '<label>البيان<input name="memo"></label><label>الحساب المدين<select name="debit">' + options + '</select></label>' +
    '<label>الحساب الدائن<select name="credit">' + options + '</select></label><label>العملة<select name="currency"><option>YER</option><option>SAR</option><option>USD</option></select></label>' +
    '<label>المبلغ<input name="amount" type="number" min="0.01" step="0.01" required></label><button class="primary" type="submit">ترحيل القيد</button></form></div>' +
    '<div class="card table-wrap"><table><thead><tr><th>رقم القيد</th><th>التاريخ</th><th>البيان</th><th>الحالة</th></tr></thead><tbody>' +
    (await query("SELECT entry_no,entry_date,memo,status FROM journal_entries ORDER BY entry_date DESC,id DESC LIMIT 100")).map((j) => "<tr><td>" + esc(j.entry_no) + "</td><td>" + esc(j.entry_date) + "</td><td>" + esc(j.memo) + "</td><td>" + esc(j.status) + "</td></tr>").join("") +
    "</tbody></table></div>";
}
async function trialPage() {
  const currency = "YER";
  const rows = await query("SELECT a.code,a.name_ar,COALESCE(SUM(CASE WHEN j.status='posted' THEN l.debit ELSE 0 END),0) AS debit,COALESCE(SUM(CASE WHEN j.status='posted' THEN l.credit ELSE 0 END),0) AS credit FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id AND l.currency_code=? LEFT JOIN journal_entries j ON j.id=l.journal_id GROUP BY a.id ORDER BY a.code", [currency]);
  const totalDebit = rows.reduce((n, r) => n + Number(r.debit), 0);
  const totalCredit = rows.reduce((n, r) => n + Number(r.credit), 0);
  return heading("ميزان المراجعة", "عرض أرصدة القيود المرحلة بالعملة الأساسية الحالية: " + currency) +
    '<div class="card table-wrap"><table><thead><tr><th>الحساب</th><th>الاسم</th><th>مدين</th><th>دائن</th><th>الفرق</th></tr></thead><tbody>' +
    rows.map((r) => "<tr><td>" + esc(r.code) + "</td><td>" + esc(r.name_ar) + "</td><td>" + money(r.debit) + "</td><td>" + money(r.credit) + "</td><td>" + money(Number(r.debit)-Number(r.credit)) + "</td></tr>").join("") +
    "</tbody><tfoot><tr><th colspan=2>الإجمالي</th><th>" + money(totalDebit) + "</th><th>" + money(totalCredit) + "</th><th>" + money(totalDebit-totalCredit) + "</th></tr></tfoot></table></div>" +
    message(Math.abs(totalDebit-totalCredit) < 0.00001 ? "ميزان المراجعة متوازن." : "تنبيه: يوجد فرق في ميزان المراجعة.", Math.abs(totalDebit-totalCredit) < 0.00001 ? "success" : "");
}
const pending = {
  parties: ["العملاء والموردون", "البيانات الأساسية للأطراف موجودة في مخطط SQLite، لكن واجهة إدارة الأطراف والتحقق من أرصدتها لم تُنفّذ بعد."],
  products: ["المنتجات والمخزون", "جداول المنتجات والمستودعات وحركات المخزون موجودة؛ لم تُنفّذ بعد دورة الاستلام والصرف والتسعير والجرد."],
  sales: ["المبيعات والمرتجعات", "مخطط فواتير المبيعات وتفاصيلها موجود؛ لم تُنفّذ بعد دورة الفاتورة والترحيل والتحصيل والمرتجع."],
  purchases: ["المشتريات والمرتجعات", "مخطط فواتير المشتريات موجود؛ لم تُنفّذ بعد دورة الشراء والاستلام والسداد والمرتجع."],
  cash: ["الصناديق والبنوك", "الجداول الأساسية موجودة؛ لم تُنفّذ بعد إدارة الصندوق والبنك والتسوية والتحويل."],
  expenses: ["المصروفات والإيرادات", "جداول المصروفات والإيرادات موجودة؛ لم تُنفّذ بعد نماذج الإدخال والترحيل والربط بالسندات."],
  taxes: ["الضرائب", "جدول معدلات الضرائب موجود؛ لم تُنفّذ بعد احتساب الضريبة والإقرارات والتقارير الضريبية."],
  assets: ["الأصول الثابتة", "جداول الأصول والإهلاك موجودة؛ لم تُنفّذ بعد سجل الأصل وجدول الإهلاك والاستبعاد."],
  reports: ["القوائم المالية", "محرك المحاسبة يتضمن وظائف حسابية قابلة للاختبار؛ واجهات القوائم المالية الكاملة وربطها بالفترات لم تكتمل بعد."],
  backup: ["النسخ الاحتياطي ونقل البيانات", "نسخ واستعادة SQLite مفعّلان على Windows مع فحص integrity_check. دعم Android ونقل البيانات بين جهازين لم يُنفّذا بعد."]
};
async function pendingPage(key) {
  const item = pending[key];
  return heading(item[0]) + message(item[1]) + '<div class="card"><p class="muted">لن تُعرض هذه الوحدة على أنها مكتملة حتى تُنفّذ عملياتها الفعلية وتُختبر مع قاعدة البيانات والقيد المزدوج.</p></div>';
}
async function render(page = currentPage) {
  currentPage = page;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  try {
    const renderers = { dashboard, accounts: accountsPage, journal: journalPage, trial: trialPage };
    content.innerHTML = renderers[page] ? await renderers[page]() : await pendingPage(page);
    bindForms();
  } catch (error) {
    content.innerHTML = heading("تعذر عرض الوحدة") + message(error.message || String(error));
  }
}
function bindForms() {
  const accountForm = $("#account-form");
  if (accountForm) accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const f = new FormData(accountForm);
    try {
      await run("INSERT INTO accounts(code,name_ar,account_type,normal_side,is_postable) VALUES(?,?,?,?,?)",
        [f.get("code").trim(), f.get("name").trim(), f.get("type"), f.get("side"), Number(f.get("postable"))]);
      await render("accounts");
    } catch (error) { alert(error.message); }
  });
  const journalForm = $("#journal-form");
  if (journalForm) journalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const f = new FormData(journalForm);
    const amount = Number(f.get("amount"));
    const entry = { date: f.get("date"), reference: f.get("reference").trim(), memo: f.get("memo").trim(), status: "draft", lines: [
      { accountCode: f.get("debit"), debit: amount, credit: 0, currency: f.get("currency") },
      { accountCode: f.get("credit"), debit: 0, credit: amount, currency: f.get("currency") }
    ] };
    try {
      if (entry.lines[0].accountCode === entry.lines[1].accountCode) throw new Error("اختر حسابين مختلفين.");
      validateJournal(entry, await loadAccounts());
      await transaction([
        { sql: "INSERT INTO journal_entries(entry_no,entry_date,memo,status,posted_at) VALUES(?,?,?,'posted',datetime('now'))", params: [entry.reference, entry.date, entry.memo] },
        { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),1,(SELECT id FROM accounts WHERE code=?),?,?,0,?)", params: [entry.reference, entry.lines[0].accountCode, entry.lines[0].currency, amount, entry.memo] },
        { sql: "INSERT INTO journal_lines(journal_id,line_no,account_id,currency_code,debit,credit,memo) VALUES((SELECT id FROM journal_entries WHERE entry_no=?),2,(SELECT id FROM accounts WHERE code=?),?,0,?,?)", params: [entry.reference, entry.lines[1].accountCode, entry.lines[1].currency, amount, entry.memo] }
      ]);
      await render("journal");
    } catch (error) { alert(error.message || "تعذر ترحيل القيد."); }
  });
}
$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (button) render(button.dataset.page);
});
async function start() {
  try {
    await initDatabase();
    $("#db-status").textContent = "SQLite محلية — وضع العمل دون إنترنت";
    $("#db-status").classList.add("success");
    await render("dashboard");
  } catch (error) {
    $("#db-status").textContent = "تعذر فتح SQLite";
    content.innerHTML = heading("لم يتم فتح قاعدة البيانات") + message(error.message);
  }
}
start();