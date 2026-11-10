import test from "node:test";
import assert from "node:assert/strict";
import { LocalAuth } from "../src/core/local-auth.js";

function createMemoryDb() {
  const users = [];
  const roles = [{ id: 1, role_key: "administrator", name_ar: "مدير النظام" }];
  const permissions = ["dashboard.view", "users.manage", "settings.manage"].map((permission_key, i) => ({ id: i + 1, permission_key }));
  const userRoles = [];
  const rolePermissions = permissions.map((p) => ({ role_id: 1, permission_id: p.id }));
  return {
    async query(sql, params = []) {
      if (sql.includes("COUNT(*) AS count FROM users")) return [{ count: users.length }];
      if (sql.includes("FROM users WHERE username")) return users.filter((u) => u.username.toLowerCase() === String(params[0]).toLowerCase());
      if (sql.includes("FROM users WHERE id=")) return users.filter((u) => u.id === params[0]);
      if (sql.includes("FROM roles WHERE role_key")) return roles.filter((r) => r.role_key === params[0]);
      if (sql.includes("FROM roles r JOIN user_roles")) return userRoles.filter((ur) => ur.user_id === params[0]).map((ur) => roles.find((r) => r.id === ur.role_id));
      if (sql.includes("FROM permissions p JOIN role_permissions")) return userRoles.filter((ur) => ur.user_id === params[0]).flatMap((ur) => rolePermissions.filter((rp) => rp.role_id === ur.role_id).map((rp) => permissions.find((p) => p.id === rp.permission_id)));
      return [];
    },
    async run(sql, params = []) {
      if (sql.startsWith("UPDATE users SET last_login_at")) {
        const user = users.find((u) => u.id === params[0]);
        if (user) user.last_login_at = "now";
      } else if (sql.startsWith("UPDATE users SET password_salt")) {
        const user = users.find((u) => u.id === params[3]);
        Object.assign(user, { password_salt: params[0], password_hash: params[1], password_iterations: params[2], must_change_password: 0 });
      }
    },
    async transaction(statements) {
      for (const statement of statements) {
        if (statement.sql.startsWith("INSERT INTO users")) {
          const [username, display_name, password_salt, password_hash, password_iterations] = statement.params;
          if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new Error("duplicate");
          users.push({ id: users.length + 1, username, display_name, password_salt, password_hash, password_iterations, is_active: 1, must_change_password: 0 });
        } else if (statement.sql.startsWith("INSERT INTO user_roles")) {
          const [username] = statement.params;
          const user = users.find((u) => u.username === username);
          userRoles.push({ user_id: user.id, role_id: 1 });
        }
      }
    }
  };
}

test("first launch creates one administrator and authenticates locally", async () => {
  const auth = new LocalAuth(createMemoryDb());
  assert.equal(await auth.needsInitialSetup(), true);
  const session = await auth.createInitialAdministrator({ username: "admin", displayName: "مدير", password: "SecurePass123!" });
  assert.equal(session.username, "admin");
  assert.equal(auth.can("users.manage"), true);
  assert.equal(await auth.needsInitialSetup(), false);
});

test("login rejects an incorrect password without creating a session", async () => {
  const auth = new LocalAuth(createMemoryDb());
  await auth.createInitialAdministrator({ username: "admin", displayName: "مدير", password: "SecurePass123!" });
  auth.logout();
  await assert.rejects(() => auth.login("admin", "wrong-password"), /غير صحيحة/);
  assert.equal(auth.session, null);
});

test("initial administrator password must meet minimum length", async () => {
  const auth = new LocalAuth(createMemoryDb());
  await assert.rejects(
    () => auth.createInitialAdministrator({ username: "admin", displayName: "مدير", password: "short" }),
    /10 أحرف/
  );
});

test("administrator cannot deactivate own account or the last active administrator", async () => {
  const users = [{ id: 1, is_active: 1 }];
  const db = {
    async query(sql, params = []) {
      if (sql.includes("SELECT id FROM users WHERE id")) return users.filter((u) => u.id === params[0]);
      if (sql.includes("COUNT(DISTINCT u.id)")) return [{ n: 1 }];
      if (sql.includes("FROM user_roles ur JOIN roles")) return [{ role_key: "administrator" }];
      return [];
    },
    async run(sql, params = []) {
      const user = users.find((u) => u.id === params[1]);
      if (user) user.is_active = params[0];
    }
  };
  const auth = new LocalAuth(db);
  auth.session = { id: 1, permissions: new Set(["users.manage"]) };
  await assert.rejects(() => auth.setUserActive(1, false), /لا يمكنك إيقاف حسابك/);
  auth.session = { id: 99, permissions: new Set(["users.manage"]) };
  await assert.rejects(() => auth.setUserActive(1, false), /آخر مدير نشط/);
  await auth.setUserActive(1, true);
  assert.equal(users[0].is_active, 1);
});
