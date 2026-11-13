PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name TEXT NOT NULL DEFAULT 'ONYX',
  base_currency TEXT NOT NULL DEFAULT 'YER',
  fiscal_year_start TEXT NOT NULL DEFAULT '01-01',
  tax_number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO company_settings(id) VALUES (1);
CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY CHECK(length(code) = 3),
  name_ar TEXT NOT NULL,
  minor_unit INTEGER NOT NULL DEFAULT 2 CHECK(minor_unit BETWEEN 0 AND 4),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
);
INSERT OR IGNORE INTO currencies(code,name_ar,minor_unit) VALUES
 ('YER','ريال يمني',2),('SAR','ريال سعودي',2),('USD','دولار أمريكي',2);
CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY,
  from_currency TEXT NOT NULL REFERENCES currencies(code),
  to_currency TEXT NOT NULL REFERENCES currencies(code),
  rate NUMERIC NOT NULL CHECK(rate > 0),
  effective_date TEXT NOT NULL,
  UNIQUE(from_currency,to_currency,effective_date)
);
CREATE TABLE IF NOT EXISTS fiscal_years (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('asset','liability','equity','revenue','expense')),
  normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
  parent_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
  is_postable INTEGER NOT NULL DEFAULT 1 CHECK(is_postable IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  cash_flow_category TEXT CHECK(cash_flow_category IN ('operating','investing','financing') OR cash_flow_category IS NULL)
);
INSERT OR IGNORE INTO accounts(code,name_ar,account_type,normal_side,is_postable) VALUES
 ('1000','الأصول','asset','debit',0),
 ('1100','الصندوق والبنوك','asset','debit',1),
 ('1200','العملاء / الذمم المدينة','asset','debit',1),
 ('1250','ضريبة المدخلات القابلة للاسترداد','asset','debit',1),
 ('1300','المخزون','asset','debit',1),
 ('1400','الأصول الثابتة','asset','debit',1),
 ('1490','مجمع إهلاك الأصول','asset','credit',1),
 ('2000','الالتزامات','liability','credit',0),
 ('2100','الموردون / الذمم الدائنة','liability','credit',1),
 ('2200','ضريبة القيمة المضافة المستحقة','liability','credit',1),
 ('3000','حقوق الملكية','equity','credit',0),
 ('3100','رأس المال','equity','credit',1),
 ('3200','الأرباح المحتجزة','equity','credit',1),
 ('4000','الإيرادات','revenue','credit',0),
 ('4100','إيرادات المبيعات','revenue','credit',1),
 ('4190','مردودات المبيعات','revenue','debit',1),
 ('4200','إيرادات أخرى','revenue','credit',1),
 ('5000','المصروفات','expense','debit',0),
 ('5100','تكلفة البضاعة المباعة','expense','debit',1),
 ('5200','مصروفات تشغيلية','expense','debit',1),
 ('5300','مصروف الإهلاك','expense','debit',1);
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY,
  party_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK(party_type IN ('customer','supplier','both')),
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  tax_number TEXT NOT NULL DEFAULT '',
  receivable_account_id INTEGER REFERENCES accounts(id),
  payable_account_id INTEGER REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  barcode TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'قطعة',
  purchase_cost NUMERIC NOT NULL DEFAULT 0 CHECK(purchase_cost >= 0),
  sale_price NUMERIC NOT NULL DEFAULT 0 CHECK(sale_price >= 0),
  tax_rate NUMERIC NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  inventory_account_id INTEGER REFERENCES accounts(id),
  revenue_account_id INTEGER REFERENCES accounts(id),
  cogs_account_id INTEGER REFERENCES accounts(id),
  is_service INTEGER NOT NULL DEFAULT 0 CHECK(is_service IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','reversed')),
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  party_id INTEGER REFERENCES parties(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  debit NUMERIC NOT NULL DEFAULT 0 CHECK(debit >= 0),
  credit NUMERIC NOT NULL DEFAULT 0 CHECK(credit >= 0),
  memo TEXT NOT NULL DEFAULT '',
  UNIQUE(journal_id,line_no),
  CHECK(NOT (debit > 0 AND credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(entry_date,status);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id,journal_id);
CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  rate NUMERIC NOT NULL CHECK(rate BETWEEN 0 AND 100),
  tax_type TEXT NOT NULL CHECK(tax_type IN ('sales','purchase','withholding')),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sales_invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  invoice_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  subtotal NUMERIC NOT NULL DEFAULT 0 CHECK(subtotal >= 0),
  tax_total NUMERIC NOT NULL DEFAULT 0 CHECK(tax_total >= 0),
  discount_total NUMERIC NOT NULL DEFAULT 0 CHECK(discount_total >= 0),
  grand_total NUMERIC NOT NULL DEFAULT 0 CHECK(grand_total >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  journal_id INTEGER REFERENCES journal_entries(id),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity NUMERIC NOT NULL CHECK(quantity > 0),
  unit_price NUMERIC NOT NULL CHECK(unit_price >= 0),
  discount NUMERIC NOT NULL DEFAULT 0 CHECK(discount >= 0),
  tax_rate NUMERIC NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  line_total NUMERIC NOT NULL CHECK(line_total >= 0)
);
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  invoice_date TEXT NOT NULL,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC NOT NULL DEFAULT 1 CHECK(exchange_rate > 0),
  subtotal NUMERIC NOT NULL DEFAULT 0 CHECK(subtotal >= 0),
  tax_total NUMERIC NOT NULL DEFAULT 0 CHECK(tax_total >= 0),
  grand_total NUMERIC NOT NULL DEFAULT 0 CHECK(grand_total >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  journal_id INTEGER REFERENCES journal_entries(id),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  return_date TEXT NOT NULL,
  original_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  subtotal NUMERIC NOT NULL CHECK(subtotal >= 0),
  tax_total NUMERIC NOT NULL CHECK(tax_total >= 0),
  grand_total NUMERIC NOT NULL CHECK(grand_total >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  journal_id INTEGER REFERENCES journal_entries(id),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sales_return_lines (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity NUMERIC NOT NULL CHECK(quantity > 0),
  unit_price NUMERIC NOT NULL CHECK(unit_price >= 0),
  discount NUMERIC NOT NULL DEFAULT 0 CHECK(discount >= 0),
  tax_rate NUMERIC NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  line_total NUMERIC NOT NULL CHECK(line_total >= 0)
);
CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity NUMERIC NOT NULL CHECK(quantity > 0),
  unit_cost NUMERIC NOT NULL CHECK(unit_cost >= 0),
  tax_rate NUMERIC NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  line_total NUMERIC NOT NULL CHECK(line_total >= 0)
);
CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  return_date TEXT NOT NULL,
  original_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id),
  party_id INTEGER NOT NULL REFERENCES parties(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  subtotal NUMERIC NOT NULL CHECK(subtotal >= 0),
  tax_total NUMERIC NOT NULL CHECK(tax_total >= 0),
  grand_total NUMERIC NOT NULL CHECK(grand_total >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
  journal_id INTEGER REFERENCES journal_entries(id),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity NUMERIC NOT NULL CHECK(quantity > 0),
  unit_cost NUMERIC NOT NULL CHECK(unit_cost >= 0),
  tax_rate NUMERIC NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
  line_total NUMERIC NOT NULL CHECK(line_total >= 0)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  movement_date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  source_type TEXT NOT NULL,
  source_id INTEGER,
  quantity_in NUMERIC NOT NULL DEFAULT 0 CHECK(quantity_in >= 0),
  quantity_out NUMERIC NOT NULL DEFAULT 0 CHECK(quantity_out >= 0),
  unit_cost NUMERIC NOT NULL DEFAULT 0 CHECK(unit_cost >= 0),
  CHECK(NOT (quantity_in > 0 AND quantity_out > 0))
);
CREATE INDEX IF NOT EXISTS idx_stock_product_warehouse ON stock_movements(product_id,warehouse_id,movement_date);
CREATE TABLE IF NOT EXISTS cash_boxes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL DEFAULT '',
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cash_transfers (
  id INTEGER PRIMARY KEY,
  transfer_no TEXT NOT NULL UNIQUE,
  transfer_date TEXT NOT NULL,
  from_cash_box_id INTEGER REFERENCES cash_boxes(id),
  from_bank_account_id INTEGER REFERENCES bank_accounts(id),
  to_cash_box_id INTEGER REFERENCES cash_boxes(id),
  to_bank_account_id INTEGER REFERENCES bank_accounts(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  memo TEXT NOT NULL DEFAULT '',
  CHECK ((from_cash_box_id IS NOT NULL) <> (from_bank_account_id IS NOT NULL)),
  CHECK ((to_cash_box_id IS NOT NULL) <> (to_bank_account_id IS NOT NULL)),
  CHECK (from_cash_box_id IS NULL OR to_cash_box_id IS NULL OR from_cash_box_id <> to_cash_box_id),
  CHECK (from_bank_account_id IS NULL OR to_bank_account_id IS NULL OR from_bank_account_id <> to_bank_account_id)
);
CREATE TABLE IF NOT EXISTS cash_transactions (
  id INTEGER PRIMARY KEY,
  transaction_no TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK(transaction_type IN ('receipt','payment','transfer','deposit','withdrawal')),
  cash_box_id INTEGER REFERENCES cash_boxes(id),
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  party_id INTEGER REFERENCES parties(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  memo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  expense_no TEXT NOT NULL UNIQUE,
  expense_date TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  party_id INTEGER REFERENCES parties(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  memo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS revenues (
  id INTEGER PRIMARY KEY,
  revenue_no TEXT NOT NULL UNIQUE,
  revenue_date TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  party_id INTEGER REFERENCES parties(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  amount NUMERIC NOT NULL CHECK(amount > 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  memo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS fixed_assets (
  id INTEGER PRIMARY KEY,
  asset_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  acquisition_date TEXT NOT NULL,
  cost NUMERIC NOT NULL CHECK(cost > 0),
  residual_value NUMERIC NOT NULL DEFAULT 0 CHECK(residual_value >= 0),
  useful_life_months INTEGER NOT NULL CHECK(useful_life_months > 0),
  asset_account_id INTEGER NOT NULL REFERENCES accounts(id),
  accumulated_depreciation_account_id INTEGER NOT NULL REFERENCES accounts(id),
  depreciation_expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed'))
);
CREATE TABLE IF NOT EXISTS depreciation_runs (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES fixed_assets(id),
  period TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount >= 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  UNIQUE(asset_id,period)
);
CREATE TABLE IF NOT EXISTS debt_installments (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  due_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  paid_amount NUMERIC NOT NULL DEFAULT 0 CHECK(paid_amount >= 0 AND paid_amount <= amount),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  source_type TEXT NOT NULL,
  source_id INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transfer_packages (
  id INTEGER PRIMARY KEY,
  package_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
);
CREATE TABLE IF NOT EXISTS backup_history (
  id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1))
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
CREATE INDEX IF NOT EXISTS idx_journal_party_currency ON journal_lines(party_id,currency_code);
UPDATE journal_lines
SET party_id = (SELECT s.party_id FROM sales_invoices s WHERE s.journal_id=journal_lines.journal_id)
WHERE party_id IS NULL
  AND account_id=(SELECT id FROM accounts WHERE code='1200')
  AND journal_id IN (SELECT journal_id FROM sales_invoices WHERE journal_id IS NOT NULL);
UPDATE journal_lines
SET party_id = (SELECT r.party_id FROM sales_returns r WHERE r.journal_id=journal_lines.journal_id)
WHERE party_id IS NULL
  AND account_id=(SELECT id FROM accounts WHERE code='1200')
  AND journal_id IN (SELECT journal_id FROM sales_returns WHERE journal_id IS NOT NULL);
UPDATE journal_lines
SET party_id = (SELECT p.party_id FROM purchase_invoices p WHERE p.journal_id=journal_lines.journal_id)
WHERE party_id IS NULL
  AND account_id=(SELECT id FROM accounts WHERE code='2100')
  AND journal_id IN (SELECT journal_id FROM purchase_invoices WHERE journal_id IS NOT NULL);
UPDATE journal_lines
SET party_id = (SELECT r.party_id FROM purchase_returns r WHERE r.journal_id=journal_lines.journal_id)
WHERE party_id IS NULL
  AND account_id=(SELECT id FROM accounts WHERE code='2100')
  AND journal_id IN (SELECT journal_id FROM purchase_returns WHERE journal_id IS NOT NULL);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);

-- Seed useful cash-flow classifications without overwriting company customizations.
UPDATE accounts SET cash_flow_category='operating'
WHERE cash_flow_category IS NULL
  AND code IN ('1200','1250','1300','2100','2200','4100','4190','4200','5100','5200');
UPDATE accounts SET cash_flow_category='investing'
WHERE cash_flow_category IS NULL AND code IN ('1400','1490');
UPDATE accounts SET cash_flow_category='financing'
WHERE cash_flow_category IS NULL AND code IN ('3100','3200');
INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_employees_search ON employees(employee_code,name_ar,phone);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);

-- ONEX local authentication and role-based access foundation (schema v6).
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1))
);
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY,
  permission_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 210000,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,role_id)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY(role_id,permission_id)
);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active,username);
INSERT OR IGNORE INTO roles(role_key,name_ar,is_system) VALUES
 ('administrator','مدير النظام',1),('accountant','محاسب',1),('sales','مبيعات',1),('inventory','المخازن',1),('viewer','مشاهد',1);
INSERT OR IGNORE INTO permissions(permission_key,name_ar) VALUES
 ('dashboard.view','عرض لوحة التحكم'),('accounting.view','عرض المحاسبة'),('accounting.manage','إدارة القيود'),
 ('sales.view','عرض المبيعات'),('sales.manage','إدارة المبيعات'),('purchases.view','عرض المشتريات'),
 ('purchases.manage','إدارة المشتريات'),('inventory.view','عرض المخزون'),('inventory.manage','إدارة المخزون'),
 ('parties.view','عرض العملاء والموردين'),('parties.manage','إدارة العملاء والموردين'),
 ('reports.view','عرض التقارير'),('settings.manage','إدارة الإعدادات'),('users.manage','إدارة المستخدمين'),
 ('backup.manage','إدارة النسخ الاحتياطي');
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.role_key='administrator';

INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN
 ('dashboard.view','accounting.view','accounting.manage','sales.view','purchases.view','parties.view','reports.view')
 WHERE r.role_key='accountant';
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN
 ('dashboard.view','sales.view','sales.manage','inventory.view','parties.view','reports.view')
 WHERE r.role_key='sales';
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN
 ('dashboard.view','inventory.view','inventory.manage','purchases.view','purchases.manage')
 WHERE r.role_key='inventory';
INSERT OR IGNORE INTO role_permissions(role_id,permission_id)
 SELECT r.id,p.id FROM roles r JOIN permissions p ON p.permission_key IN
 ('dashboard.view','accounting.view','sales.view','purchases.view','inventory.view','parties.view','reports.view')
 WHERE r.role_key='viewer';
INSERT OR IGNORE INTO schema_migrations(version) VALUES (6);

-- Bank reconciliation: imported statement movements are matched to posted bank-ledger lines.
CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id INTEGER PRIMARY KEY,
  reconciliation_no TEXT NOT NULL UNIQUE,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  opening_balance NUMERIC NOT NULL,
  closing_balance NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','closed')),
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  CHECK(period_start <= period_end)
);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_account_period
  ON bank_reconciliations(bank_account_id,period_start,period_end);
CREATE TABLE IF NOT EXISTS bank_reconciliation_lines (
  id INTEGER PRIMARY KEY,
  reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  statement_date TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL CHECK(amount <> 0),
  matched_journal_line_id INTEGER REFERENCES journal_lines(id) ON DELETE RESTRICT,
  matched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_lines_rec
  ON bank_reconciliation_lines(reconciliation_id,statement_date,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_reconciliation_matched_journal_line
  ON bank_reconciliation_lines(matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS bank_reconciliation_outstanding (
  id INTEGER PRIMARY KEY,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  journal_line_id INTEGER NOT NULL UNIQUE REFERENCES journal_lines(id) ON DELETE RESTRICT,
  origin_reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cleared')),
  cleared_reconciliation_id INTEGER REFERENCES bank_reconciliations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cleared_at TEXT,
  CHECK (
    (status='pending' AND cleared_reconciliation_id IS NULL AND cleared_at IS NULL) OR
    (status='cleared' AND cleared_reconciliation_id IS NOT NULL AND cleared_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliation_outstanding_pending
  ON bank_reconciliation_outstanding(bank_account_id,status,origin_reconciliation_id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (7);


-- Recheck stock at write time so concurrent sales/returns cannot drive a warehouse negative.
CREATE TRIGGER IF NOT EXISTS trg_prevent_negative_stock_outflow
BEFORE INSERT ON stock_movements
WHEN NEW.source_type IN ('sales_invoice','purchase_return') AND NEW.quantity_out > 0
BEGIN
  SELECT CASE
    WHEN (
      SELECT COALESCE(SUM(quantity_in - quantity_out), 0)
      FROM stock_movements
      WHERE product_id = NEW.product_id AND warehouse_id = NEW.warehouse_id
    ) - NEW.quantity_out < -0.000001
    THEN RAISE(ABORT, 'المخزون غير كافٍ؛ تغير الرصيد قبل ترحيل العملية.')
  END;
END;
