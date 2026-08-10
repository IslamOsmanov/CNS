import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { db, User, Report, Role, getRole } from "./db.js";

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 12 * 60 * 60 * 1000 },
  })
);

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

function currentUser(req: express.Request): User | null {
  if (!req.session.userId) return null;
  const u = db
    .prepare("SELECT * FROM users WHERE id = ? AND active = 1")
    .get(req.session.userId) as User | undefined;
  return u ?? null;
}

type PermField = "manage_users" | "view_all_reports" | "delete_reports" | "export_import";

// Права роли; если роль почему-то удалена — все права выключены.
function permsOf(u: User): Role {
  return (
    getRole(u.role) ?? {
      id: 0,
      name: u.role,
      label: u.role,
      manage_users: 0,
      view_all_reports: 0,
      delete_reports: 0,
      export_import: 0,
      built_in: 0,
    }
  );
}

function can(u: User, perm: PermField): boolean {
  return permsOf(u)[perm] === 1;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Giriş tələb olunur" });
  (res.locals as { user: User }).user = u;
  next();
}

function requirePerm(perm: PermField) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const u = (res.locals as { user: User }).user;
    if (!can(u, perm)) return res.status(403).json({ error: "İcazə yoxdur" });
    next();
  };
}

// Полезная нагрузка о пользователе для фронтенда: роль + набор прав
function userPayload(u: User) {
  const p = permsOf(u);
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    perms: {
      manage_users: p.manage_users === 1,
      view_all_reports: p.view_all_reports === 1,
      delete_reports: p.delete_reports === 1,
      export_import: p.export_import === 1,
    },
  };
}

// ---------- Auth ----------

app.post("/api/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json({ error: "Login və parol daxil edin" });
  const u = db
    .prepare("SELECT * FROM users WHERE username = ? AND active = 1")
    .get(username.trim().toLowerCase()) as User | undefined;
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: "Yanlış login və ya parol" });
  }
  req.session.userId = u.id;
  res.json(userPayload(u));
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Giriş tələb olunur" });
  res.json(userPayload(u));
});

app.post("/api/change-password", requireAuth, (req, res) => {
  const u = (res.locals as { user: User }).user;
  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Yeni parol ən azı 6 simvol olmalıdır" });
  }
  if (!bcrypt.compareSync(oldPassword, u.password_hash)) {
    return res.status(400).json({ error: "Köhnə parol yanlışdır" });
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    bcrypt.hashSync(newPassword, 10),
    u.id
  );
  res.json({ ok: true });
});

// ---------- Reports ----------

const REPORT_FIELDS = [
  "xidmet",
  "obyekt",
  "sistem",
  "nasazliq",
  "nasazliq_vaxti",
  "sebeb",
  "tedbir",
  "berpa_vaxti",
  "muraciet",
  "cavabdeh",
  "prioritet",
] as const;

const PRIORITIES = ["asagi", "orta", "yuksek"] as const;
const PRIORITY_LABELS: Record<string, string> = {
  asagi: "Aşağı",
  orta: "Orta",
  yuksek: "Yüksək",
};

function normalizePriority(v: string): string {
  const s = v.trim().toLowerCase();
  if ((PRIORITIES as readonly string[]).includes(s)) return s;
  const found = Object.entries(PRIORITY_LABELS).find(([, label]) => label.toLowerCase() === s);
  return found ? found[0] : "orta";
}

function pickReport(body: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const f of REPORT_FIELDS) out[f] = String(body[f] ?? "").trim();
  out.prioritet = normalizePriority(out.prioritet);
  return out;
}

app.get("/api/reports", requireAuth, (req, res) => {
  const u = (res.locals as { user: User }).user;
  const rows =
    can(u, "view_all_reports")
      ? db
          .prepare(
            `SELECT r.*, u.full_name AS author FROM reports r
             JOIN users u ON u.id = r.user_id ORDER BY r.id DESC`
          )
          .all()
      : db
          .prepare(
            `SELECT r.*, u.full_name AS author FROM reports r
             JOIN users u ON u.id = r.user_id WHERE r.user_id = ? ORDER BY r.id DESC`
          )
          .all(u.id);
  res.json(rows);
});

app.post("/api/reports", requireAuth, (req, res) => {
  const u = (res.locals as { user: User }).user;
  const r = pickReport(req.body as Record<string, unknown>);
  if (!r.xidmet || !r.sistem || !r.nasazliq || !r.nasazliq_vaxti) {
    return res
      .status(400)
      .json({ error: "Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləq doldurulmalıdır" });
  }
  const info = db
    .prepare(
      `INSERT INTO reports (user_id, ${REPORT_FIELDS.join(", ")})
       VALUES (?, ${REPORT_FIELDS.map(() => "?").join(", ")})`
    )
    .run(u.id, ...REPORT_FIELDS.map((f) => r[f]));
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/reports/:id", requireAuth, (req, res) => {
  const u = (res.locals as { user: User }).user;
  const existing = db.prepare("SELECT * FROM reports WHERE id = ?").get(req.params.id) as
    | Report
    | undefined;
  if (!existing) return res.status(404).json({ error: "Qeyd tapılmadı" });
  if (!can(u, "view_all_reports") && existing.user_id !== u.id) {
    return res.status(403).json({ error: "İcazə yoxdur" });
  }
  const r = pickReport(req.body as Record<string, unknown>);
  if (!r.xidmet || !r.sistem || !r.nasazliq || !r.nasazliq_vaxti) {
    return res
      .status(400)
      .json({ error: "Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləq doldurulmalıdır" });
  }
  db.prepare(
    `UPDATE reports SET ${REPORT_FIELDS.map((f) => `${f} = ?`).join(", ")},
     updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(...REPORT_FIELDS.map((f) => r[f]), existing.id);
  res.json({ ok: true });
});

app.delete("/api/reports", requireAuth, requirePerm("delete_reports"), (req, res) => {
  const info = db.prepare("DELETE FROM reports").run();
  res.json({ ok: true, deleted: info.changes });
});

app.delete("/api/reports/:id", requireAuth, requirePerm("delete_reports"), (req, res) => {
  db.prepare("DELETE FROM reports WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Excel export (для директора) ----------

app.get("/api/export", requireAuth, requirePerm("export_import"), async (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, u.full_name AS author FROM reports r
       JOIN users u ON u.id = r.user_id ORDER BY r.id ASC`
    )
    .all() as (Report & { author: string })[];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("CNS nasazlıqlar");
  ws.columns = [
    { header: "№", key: "id", width: 6 },
    { header: "Xidmət", key: "xidmet", width: 12 },
    { header: "Obyekt / yer", key: "obyekt", width: 14 },
    { header: "Sistem, avadanlıq", key: "sistem", width: 20 },
    { header: "Nasazlıq barədə məlumat", key: "nasazliq", width: 40 },
    { header: "Nasazlıq tarixi və saatı", key: "nasazliq_vaxti", width: 18 },
    { header: "Vaciblik", key: "prioritet", width: 10 },
    { header: "Səbəb", key: "sebeb", width: 35 },
    { header: "Tədbir", key: "tedbir", width: 35 },
    { header: "Bərpa tarixi və saatı", key: "berpa_vaxti", width: 18 },
    { header: "Müraciət edilən şəxs", key: "muraciet", width: 18 },
    { header: "Cavabdeh", key: "cavabdeh", width: 16 },
    { header: "Daxil etdi", key: "author", width: 18 },
    { header: "Daxil edilmə vaxtı", key: "created_at", width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFE0A3" },
  };
  for (const r of rows) ws.addRow({ ...r, prioritet: PRIORITY_LABELS[r.prioritet] ?? r.prioritet });
  ws.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
  });

  const fileName = `CNS_nasazliqlar_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Excel import (замена всех записей, только админ) ----------

app.post(
  "/api/import",
  requireAuth,
  requirePerm("export_import"),
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const u = (res.locals as { user: User }).user;
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: "Fayl boşdur" });
    }

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    } catch {
      return res.status(400).json({ error: "Excel faylını oxumaq mümkün olmadı" });
    }
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: "Excel-də vərəq tapılmadı" });

    // Восстанавливаем автора по ФИО, иначе назначаем текущего админа
    const usersList = db.prepare("SELECT id, full_name FROM users").all() as {
      id: number;
      full_name: string;
    }[];
    const nameToId = new Map(
      usersList.map((x) => [x.full_name.trim().toLowerCase(), x.id])
    );

    const cellText = (cell: ExcelJS.Cell): string => {
      const v = cell.value;
      if (v == null) return "";
      if (v instanceof Date) {
        const p = (n: number) => String(n).padStart(2, "0");
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}T${p(v.getHours())}:${p(v.getMinutes())}`;
      }
      if (typeof v === "object") {
        const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
        if (o.richText) return o.richText.map((t) => t.text).join("").trim();
        if (o.text) return o.text.trim();
        if (o.result != null) return String(o.result).trim();
        return "";
      }
      return String(v).trim();
    };

    // Порядок столбцов совпадает с экспортом: 2=xidmet ... 6=nasazliq_vaxti.
    // В новом формате столбец 7 — "Vaciblik"; в старых файлах его нет,
    // определяем по заголовку и сдвигаем остальные столбцы.
    const hasPriority = cellText(ws.getRow(1).getCell(7)).toLowerCase().includes("vacib");
    const shift = hasPriority ? 1 : 0;
    const parsed: { fields: Record<string, string>; author: string }[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // заголовок
      const get = (c: number) => cellText(row.getCell(c));
      const fields: Record<string, string> = {
        xidmet: get(2),
        obyekt: get(3),
        sistem: get(4),
        nasazliq: get(5),
        nasazliq_vaxti: get(6),
        prioritet: normalizePriority(hasPriority ? get(7) : ""),
        sebeb: get(7 + shift),
        tedbir: get(8 + shift),
        berpa_vaxti: get(9 + shift),
        muraciet: get(10 + shift),
        cavabdeh: get(11 + shift),
      };
      if (!fields.xidmet && !fields.sistem && !fields.nasazliq) return; // пустая строка
      parsed.push({ fields, author: get(12 + shift) });
    });

    if (parsed.length === 0) {
      return res.status(400).json({ error: "Excel-də uyğun qeyd tapılmadı" });
    }

    const insert = db.prepare(
      `INSERT INTO reports (user_id, ${REPORT_FIELDS.join(", ")})
       VALUES (?, ${REPORT_FIELDS.map(() => "?").join(", ")})`
    );
    const replaceAll = db.transaction((items: typeof parsed) => {
      db.prepare("DELETE FROM reports").run();
      for (const it of items) {
        const uid = nameToId.get(it.author.trim().toLowerCase()) ?? u.id;
        insert.run(uid, ...REPORT_FIELDS.map((f) => it.fields[f] ?? ""));
      }
    });
    replaceAll(parsed);

    res.json({ imported: parsed.length });
  }
);

// ---------- Users (управление сотрудниками, только директор) ----------

app.get("/api/users", requireAuth, requirePerm("manage_users"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at,
              COALESCE(rl.label, u.role) AS role_label
       FROM users u LEFT JOIN roles rl ON rl.name = u.role ORDER BY u.id`
    )
    .all();
  res.json(rows);
});

app.post("/api/users", requireAuth, requirePerm("manage_users"), (req, res) => {
  const { username, password, full_name, role } = req.body as {
    username?: string;
    password?: string;
    full_name?: string;
    role?: string;
  };
  if (!username || !password || !full_name || password.length < 6) {
    return res
      .status(400)
      .json({ error: "Login, ad-soyad və parol (ən azı 6 simvol) daxil edin" });
  }
  if (!role || !getRole(role)) {
    return res.status(400).json({ error: "Belə rol mövcud deyil" });
  }
  try {
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)"
      )
      .run(username.trim().toLowerCase(), bcrypt.hashSync(password, 10), full_name.trim(), role);
    res.json({ id: info.lastInsertRowid });
  } catch {
    res.status(400).json({ error: "Bu login artıq mövcuddur" });
  }
});

app.put("/api/users/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as
    | User
    | undefined;
  if (!target) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  const { active, password, full_name, role } = req.body as {
    active?: boolean;
    password?: string;
    full_name?: string;
    role?: string;
  };
  if (role !== undefined) {
    if (!getRole(role)) return res.status(400).json({ error: "Belə rol mövcud deyil" });
    if (target.id === req.session.userId) {
      return res.status(400).json({ error: "Öz rolunuzu dəyişə bilməzsiniz" });
    }
    // Нельзя убрать право управления пользователями у последнего, кто им обладает
    if (can(target, "manage_users") && !(getRole(role)!.manage_users === 1)) {
      if (countActiveManagers() <= 1) {
        return res.status(400).json({ error: "Ən azı bir idarəçi (manage_users) qalmalıdır" });
      }
    }
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, target.id);
  }
  if (typeof active === "boolean") {
    if (!active && can(target, "manage_users") && countActiveManagers() <= 1) {
      return res.status(400).json({ error: "Son idarəçini deaktiv etmək olmaz" });
    }
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active ? 1 : 0, target.id);
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: "Parol ən azı 6 simvol olmalıdır" });
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      bcrypt.hashSync(password, 10),
      target.id
    );
  }
  if (full_name) {
    db.prepare("UPDATE users SET full_name = ? WHERE id = ?").run(full_name.trim(), target.id);
  }
  res.json({ ok: true });
});

// ---------- Roles (управление ролями, право manage_users) ----------

// Сколько активных пользователей имеют право manage_users
function countActiveManagers(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u
       JOIN roles r ON r.name = u.role
       WHERE u.active = 1 AND r.manage_users = 1`
    )
    .get() as { n: number };
  return row.n;
}

const PERM_FIELDS = ["manage_users", "view_all_reports", "delete_reports", "export_import"] as const;

app.get("/api/roles", requireAuth, requirePerm("manage_users"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.name) AS user_count
       FROM roles r ORDER BY r.id`
    )
    .all();
  res.json(rows);
});

app.post("/api/roles", requireAuth, requirePerm("manage_users"), (req, res) => {
  const body = req.body as Record<string, unknown>;
  const label = String(body.label ?? "").trim();
  if (!label) return res.status(400).json({ error: "Rol adı daxil edin" });
  // Машинное имя роли на основе метки (латиница/цифры)
  let name = String(body.name ?? label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = "rol_" + Date.now();
  if (getRole(name)) return res.status(400).json({ error: "Bu adda rol artıq mövcuddur" });
  const vals = PERM_FIELDS.map((f) => (body[f] ? 1 : 0));
  const info = db
    .prepare(
      `INSERT INTO roles (name, label, ${PERM_FIELDS.join(", ")}, built_in)
       VALUES (?, ?, ${PERM_FIELDS.map(() => "?").join(", ")}, 0)`
    )
    .run(name, label, ...vals);
  res.json({ id: info.lastInsertRowid, name });
});

app.put("/api/roles/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
  const role = db.prepare("SELECT * FROM roles WHERE id = ?").get(req.params.id) as Role | undefined;
  if (!role) return res.status(404).json({ error: "Rol tapılmadı" });
  const body = req.body as Record<string, unknown>;
  const label = body.label !== undefined ? String(body.label).trim() : role.label;
  if (!label) return res.status(400).json({ error: "Rol adı boş ola bilməz" });
  const perm = (f: (typeof PERM_FIELDS)[number]) =>
    body[f] !== undefined ? (body[f] ? 1 : 0) : role[f];
  // Не даём отключить manage_users, если это последний носитель права
  const newManage = perm("manage_users");
  if (role.manage_users === 1 && newManage === 0 && countActiveManagers() <= 1) {
    return res.status(400).json({ error: "Ən azı bir idarəçi rolu qalmalıdır" });
  }
  db.prepare(
    `UPDATE roles SET label = ?, ${PERM_FIELDS.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`
  ).run(label, ...PERM_FIELDS.map((f) => perm(f)), role.id);
  res.json({ ok: true });
});

app.delete("/api/roles/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
  const role = db.prepare("SELECT * FROM roles WHERE id = ?").get(req.params.id) as Role | undefined;
  if (!role) return res.status(404).json({ error: "Rol tapılmadı" });
  if (role.built_in === 1) return res.status(400).json({ error: "Daxili rolu silmək olmaz" });
  const used = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ?").get(role.name) as {
    n: number;
  };
  if (used.n > 0) {
    return res.status(400).json({ error: "Bu rolda istifadəçilər var, əvvəlcə onları dəyişin" });
  }
  db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
  res.json({ ok: true });
});

// ---------- Static ----------

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nCNS jurnal işləyir!`);
  console.log(`Lokal:   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`Şəbəkə:  http://${net.address}:${PORT}  (bu ünvanı işçilərə verin)`);
      }
    }
  }
});
