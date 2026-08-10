const BASE = "http://localhost:3000";

async function call(path, opts = {}, cookie) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: setCookie ? setCookie.split(";")[0] : cookie };
}

// 1. Директор входит
let r = await call("/api/login", { method: "POST", body: JSON.stringify({ username: "director", password: "director123" }) });
console.log("login director:", r.status, r.body);
const dirCookie = r.cookie;

// 2. Директор создаёт сотрудника
r = await call("/api/users", { method: "POST", body: JSON.stringify({ username: "qatarov", password: "test123", full_name: "Qatarov V." }) }, dirCookie);
console.log("create user:", r.status, r.body);

// 3. Сотрудник входит и отправляет запись
r = await call("/api/login", { method: "POST", body: JSON.stringify({ username: "qatarov", password: "test123" }) });
console.log("login employee:", r.status, r.body);
const empCookie = r.cookie;

r = await call("/api/reports", {
  method: "POST",
  body: JSON.stringify({
    xidmet: "NAV",
    obyekt: "Bakı",
    sistem: "ILS 15/17",
    nasazliq: "Monitor nasazlığı, kurs kanalı işləmir",
    nasazliq_vaxti: "2026-07-10T09:30",
    sebeb: "IT bloklarında yoxlama aparıldı",
    tedbir: "Blok dəyişdirildi, sistem yoxlanıldı",
    berpa_vaxti: "2026-07-10T11:20",
    muraciet: "Bayramov D.",
    cavabdeh: "Qatarov V.",
  }),
}, empCookie);
console.log("create report:", r.status, r.body);

// 4. Сотрудник не может видеть чужое / директор видит всё
r = await call("/api/reports", {}, empCookie);
console.log("employee sees:", r.status, r.body.length, "reports");

r = await call("/api/reports", {}, dirCookie);
console.log("director sees:", r.status, r.body.length, "reports; first:", r.body[0]?.sistem, "by", r.body[0]?.author);

// 5. Сотруднику запрещено управление пользователями и экспорт
r = await call("/api/users", {}, empCookie);
console.log("employee /api/users:", r.status, r.body);

// 6. Экспорт Excel директором
const res = await fetch(BASE + "/api/export", { headers: { Cookie: dirCookie } });
console.log("export:", res.status, res.headers.get("content-type"), (await res.arrayBuffer()).byteLength, "bytes");

// 7. Без логина — отказ
r = await call("/api/reports");
console.log("no auth:", r.status, r.body);
