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
