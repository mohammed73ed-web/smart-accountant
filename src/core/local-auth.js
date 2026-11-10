const ITERATIONS = 210000;
const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64(bytes);
}
async function hashPassword(password, salt, iterations = ITERATIONS) {
  if (!globalThis.crypto?.subtle) throw new Error("ميزة التشفير الآمن غير متاحة في بيئة التشغيل.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64(salt), iterations, hash: "SHA-256" }, key, 256
  );
  return toBase64(new Uint8Array(bits));
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class LocalAuth {
  constructor(database) {
    this.db = database;
    this.session = null;
  }

  async needsInitialSetup() {
    const rows = await this.db.query("SELECT COUNT(*) AS count FROM users");
    return Number(rows[0]?.count || 0) === 0;
  }

  async createInitialAdministrator({ username, displayName, password }) {
    const cleanUser = String(username || "").trim();
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(cleanUser)) throw new Error("اسم المستخدم يجب أن يكون من 3 إلى 40 حرفاً أو رقماً.");
    if (String(password || "").length < 10) throw new Error("كلمة المرور الأولى يجب ألا تقل عن 10 أحرف.");
    const salt = randomSalt();
    const digest = await hashPassword(password, salt);
    await this.db.transaction([
      { sql: "INSERT INTO users(username,display_name,password_salt,password_hash,password_iterations) VALUES(?,?,?,?,?)",
        params: [cleanUser, String(displayName || cleanUser).trim(), salt, digest, ITERATIONS] },
      { sql: "INSERT INTO user_roles(user_id,role_id) VALUES((SELECT id FROM users WHERE username=?),(SELECT id FROM roles WHERE role_key='administrator'))",
        params: [cleanUser] }
    ]);
    return this.login(cleanUser, password);
  }

  async login(username, password) {
    const rows = await this.db.query(
      "SELECT id,username,display_name,password_salt,password_hash,password_iterations,is_active,must_change_password FROM users WHERE username=? COLLATE NOCASE",
      [String(username || "").trim()]
    );
    const user = rows[0];
    if (!user || !user.is_active) throw new Error("اسم المستخدم أو كلمة المرور غير صحيحة.");
    const candidate = await hashPassword(String(password || ""), user.password_salt, Number(user.password_iterations));
    if (!equalBytes(fromBase64(candidate), fromBase64(user.password_hash))) {
      throw new Error("اسم المستخدم أو كلمة المرور غير صحيحة.");
    }
    const roles = await this.db.query(
      "SELECT r.role_key,r.name_ar FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=?",
      [user.id]
    );
    const permissions = await this.db.query(
      "SELECT DISTINCT p.permission_key FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?",
      [user.id]
    );
    await this.db.run("UPDATE users SET last_login_at=datetime('now') WHERE id=?", [user.id]);
    this.session = {
      id: user.id, username: user.username, displayName: user.display_name,
      mustChangePassword: Boolean(user.must_change_password),
      roles: roles.map((row) => row.role_key),
      permissions: new Set(permissions.map((row) => row.permission_key))
    };
    return this.session;
  }

  can(permission) {
    return Boolean(this.session && this.session.permissions.has(permission));
  }

  logout() {
    this.session = null;
  }

  async changePassword(userId, currentPassword, nextPassword) {
    if (String(nextPassword || "").length < 10) throw new Error("كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف.");
    const rows = await this.db.query("SELECT password_salt,password_hash,password_iterations FROM users WHERE id=? AND is_active=1", [userId]);
    const user = rows[0];
    if (!user) throw new Error("المستخدم غير موجود أو موقوف.");
    const oldHash = await hashPassword(String(currentPassword || ""), user.password_salt, Number(user.password_iterations));
    if (!equalBytes(fromBase64(oldHash), fromBase64(user.password_hash))) throw new Error("كلمة المرور الحالية غير صحيحة.");
    const salt = randomSalt();
    const digest = await hashPassword(nextPassword, salt);
    await this.db.run(
      "UPDATE users SET password_salt=?,password_hash=?,password_iterations=?,must_change_password=0 WHERE id=?",
      [salt, digest, ITERATIONS, userId]
    );
    if (this.session?.id === userId) this.session.mustChangePassword = false;
  }

  async createUser({ username, displayName, password, roleKey }) {
    if (!this.can("users.manage")) throw new Error("ليس لديك صلاحية إدارة المستخدمين.");
    const cleanUser = String(username || "").trim();
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(cleanUser)) throw new Error("اسم المستخدم غير صالح.");
    if (String(password || "").length < 10) throw new Error("كلمة المرور يجب ألا تقل عن 10 أحرف.");
    const role = await this.db.query("SELECT id FROM roles WHERE role_key=?", [roleKey]);
    if (!role.length) throw new Error("الدور المحدد غير موجود.");
    const salt = randomSalt();
    const digest = await hashPassword(password, salt);
    await this.db.transaction([
      { sql: "INSERT INTO users(username,display_name,password_salt,password_hash,password_iterations) VALUES(?,?,?,?,?)",
        params: [cleanUser, String(displayName || cleanUser).trim(), salt, digest, ITERATIONS] },
      { sql: "INSERT INTO user_roles(user_id,role_id) VALUES((SELECT id FROM users WHERE username=?),(SELECT id FROM roles WHERE role_key=?))",
        params: [cleanUser, roleKey] }
    ]);
  }
}
