"use strict";

let me = null;
let reports = [];
let roles = [];

function can(perm) {
  return !!(me && me.perms && me.perms[perm]);
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- API ----------

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Сессия истекла (например, сервер перезапускался) — возвращаем на экран входа
    if (res.status === 401 && url !== "/api/login" && url !== "/api/me") {
      me = null;
      showLogin();
      throw new Error("Sessiya bitib — yenidən daxil olun");
    }
    throw new Error(data.error || "Xəta baş verdi");
  }
  return data;
}

// ---------- Утилиты ----------

function toast(msg, type = "success") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${type === "success" ? "success" : "error-toast"}`;
  setTimeout(() => t.classList.add("hidden"), 3000);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function fmtDate(s) {
  if (!s) return "";
  return s.replace("T", " ");
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ---------- Экраны ----------

function showLogin() {
  $("#login-screen").classList.remove("hidden");
  $("#app-screen").classList.add("hidden");
}

async function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  $("#user-name").textContent = me.full_name;
  $$(".perm").forEach((el) => el.classList.toggle("hidden", !can(el.dataset.perm)));
  await loadReports();
  if (can("manage_users")) {
    await loadRoles();
    loadUsers();
  }
}

function switchTab(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
  if (name !== "new") resetForm();
  if (name === "roles") loadRoles();
  if (name === "users") loadUsers();
}

// ---------- Журнал ----------

async function loadReports() {
  reports = await api("/api/reports");
  renderFilters();
  renderReports();
  renderStats();
}

function renderStats() {
  if (!can("view_all_reports")) return;
  $("#stat-total").textContent = reports.length;
  $("#stat-open").textContent = reports.filter((r) => !r.berpa_vaxti).length;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  $("#stat-month").textContent = reports.filter((r) => (r.nasazliq_vaxti || "").startsWith(ym)).length;
}

function renderFilters() {
  const sel = $("#filter-xidmet");
  const current = sel.value;
  const values = [...new Set(reports.map((r) => r.xidmet))].sort();
  sel.innerHTML =
    '<option value="">Bütün xidmətlər</option>' +
    values.map((v) => `<option>${esc(v)}</option>`).join("");
  sel.value = current;
}

function filteredReports() {
  const q = $("#filter-search").value.trim().toLowerCase();
  const xidmet = $("#filter-xidmet").value;
  const status = $("#filter-status").value;
  return reports.filter((r) => {
    if (xidmet && r.xidmet !== xidmet) return false;
    if (status === "open" && r.berpa_vaxti) return false;
    if (status === "done" && !r.berpa_vaxti) return false;
    if (q) {
      const hay = [r.sistem, r.nasazliq, r.sebeb, r.tedbir, r.muraciet, r.cavabdeh, r.obyekt, r.author]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const PRIORITY_LABELS = { asagi: "Aşağı", orta: "Orta", yuksek: "Yüksək" };

function priorityBadge(p) {
  const cls = p === "yuksek" ? "badge-open" : p === "asagi" ? "badge-off" : "badge-mid";
  return `<span class="badge ${cls}">${PRIORITY_LABELS[p] || "Orta"}</span>`;
}

function renderReports() {
  const rows = filteredReports();
  const tbody = $("#reports-table tbody");
  $("#empty-journal").classList.toggle("hidden", rows.length > 0);
  tbody.innerHTML = rows
    .map((r) => {
      const status = r.berpa_vaxti
        ? `<span class="badge badge-done">${esc(fmtDate(r.berpa_vaxti))}</span>`
        : '<span class="badge badge-open">Bərpa olunmayıb</span>';
      const canEdit = can("view_all_reports") || r.user_id === me.id;
      const actions = [
        canEdit ? `<button class="icon-btn" data-edit="${r.id}" title="Redaktə">✎</button>` : "",
        can("delete_reports")
          ? `<button class="icon-btn danger" data-del="${r.id}" title="Sil">✕</button>`
          : "",
      ].join("");
      return `<tr>
        <td>${r.id}</td>
        <td>${esc(r.xidmet)}</td>
        <td>${esc(r.obyekt)}</td>
        <td><b>${esc(r.sistem)}</b></td>
        <td>${esc(r.nasazliq)}</td>
        <td>${esc(fmtDate(r.nasazliq_vaxti))}</td>
        <td>${priorityBadge(r.prioritet)}</td>
        <td>${esc(r.sebeb)}</td>
        <td>${esc(r.tedbir)}</td>
        <td>${status}</td>
        <td>${esc(r.muraciet)}</td>
        <td>${esc(r.cavabdeh)}</td>
        <td>${esc(r.author)}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    })
    .join("");
}

// ---------- Форма записи ----------

function resetForm() {
  $("#report-form").reset();
  $("#f-id").value = "";
  $("#form-title").textContent = "Yeni nasazlıq qeydi";
  $("#btn-cancel-edit").classList.add("hidden");
  $("#form-error").classList.add("hidden");
}

function startEdit(id) {
  const r = reports.find((x) => x.id === id);
  if (!r) return;
  $("#f-id").value = r.id;
  $("#f-xidmet").value = r.xidmet;
  $("#f-obyekt").value = r.obyekt;
  $("#f-sistem").value = r.sistem;
  $("#f-nasazliq").value = r.nasazliq;
  $("#f-nasazliq-vaxti").value = r.nasazliq_vaxti;
  $("#f-berpa-vaxti").value = r.berpa_vaxti;
  $("#f-sebeb").value = r.sebeb;
  $("#f-tedbir").value = r.tedbir;
  $("#f-muraciet").value = r.muraciet;
  $("#f-cavabdeh").value = r.cavabdeh;
  $("#f-prioritet").value = r.prioritet || "orta";
  $("#form-title").textContent = `Qeyd №${r.id} — redaktə`;
  $("#btn-cancel-edit").classList.remove("hidden");
  switchTabKeepForm("new");
}

function switchTabKeepForm(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
}

async function submitReport(e) {
  e.preventDefault();
  const id = $("#f-id").value;
  const body = {
    xidmet: $("#f-xidmet").value,
    obyekt: $("#f-obyekt").value,
    sistem: $("#f-sistem").value,
    nasazliq: $("#f-nasazliq").value,
    nasazliq_vaxti: $("#f-nasazliq-vaxti").value,
    berpa_vaxti: $("#f-berpa-vaxti").value,
    sebeb: $("#f-sebeb").value,
    tedbir: $("#f-tedbir").value,
    muraciet: $("#f-muraciet").value,
    cavabdeh: $("#f-cavabdeh").value,
    prioritet: $("#f-prioritet").value,
  };
  try {
    if (id) {
      await api(`/api/reports/${id}`, { method: "PUT", body: JSON.stringify(body) });
      toast("Qeyd yeniləndi");
    } else {
      await api("/api/reports", { method: "POST", body: JSON.stringify(body) });
      toast("Qeyd göndərildi");
    }
    resetForm();
    await loadReports();
    switchTab("journal");
  } catch (err) {
    showError($("#form-error"), err.message);
  }
}

// ---------- Пользователи ----------

function roleOptions(selected) {
  return roles
    .map((r) => `<option value="${esc(r.name)}" ${r.name === selected ? "selected" : ""}>${esc(r.label)}</option>`)
    .join("");
}

async function loadUsers() {
  const users = await api("/api/users");
  const tbody = $("#users-table tbody");
  tbody.innerHTML = users
    .map((u) => {
      const status = u.active
        ? '<span class="badge badge-done">Aktiv</span>'
        : '<span class="badge badge-off">Deaktiv</span>';
      const isSelf = u.id === me.id;
      const roleCell = isSelf
        ? `<span class="badge badge-dir">${esc(u.role_label)}</span>`
        : `<select class="role-select" data-roleuser="${u.id}">${roleOptions(u.role)}</select>`;
      const actions = isSelf
        ? '<span class="muted">Sizin hesab</span>'
        : `<button class="icon-btn" data-resetpw="${u.id}" data-name="${esc(u.full_name)}">Parol</button>
           <button class="icon-btn ${u.active ? "danger" : ""}" data-toggle="${u.id}" data-active="${u.active}">
             ${u.active ? "Deaktiv et" : "Aktiv et"}
           </button>`;
      return `<tr>
        <td>${u.id}</td>
        <td>${esc(u.full_name)}</td>
        <td>${esc(u.username)}</td>
        <td>${roleCell}</td>
        <td>${status}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    })
    .join("");
}

// ---------- Роли ----------

async function loadRoles() {
  roles = await api("/api/roles");
  $("#u-role").innerHTML = roleOptions("employee");
  renderRoles();
}

function permBadge(on) {
  return on
    ? '<span class="badge badge-done">Bəli</span>'
    : '<span class="badge badge-off">Xeyr</span>';
}

function renderRoles() {
  const tbody = $("#roles-table tbody");
  if (!tbody) return;
  tbody.innerHTML = roles
    .map((r) => {
      const builtIn = r.built_in
        ? '<span class="badge badge-dir">daxili</span>'
        : `<button class="icon-btn danger" data-delrole="${r.id}" data-name="${esc(r.label)}">Sil</button>`;
      const cb = (field) =>
        `<input type="checkbox" data-roleperm="${r.id}" data-field="${field}" ${r[field] ? "checked" : ""} />`;
      return `<tr>
        <td>${r.id}</td>
        <td><b>${esc(r.label)}</b><div class="muted small">${esc(r.name)}</div></td>
        <td>${cb("manage_users")}</td>
        <td>${cb("view_all_reports")}</td>
        <td>${cb("delete_reports")}</td>
        <td>${cb("export_import")}</td>
        <td>${r.user_count}</td>
        <td><div class="row-actions">${builtIn}</div></td>
      </tr>`;
    })
    .join("");
}

async function createRole(e) {
  e.preventDefault();
  try {
    await api("/api/roles", {
      method: "POST",
      body: JSON.stringify({
        label: $("#r-label").value,
        manage_users: $("#r-manage_users").checked,
        view_all_reports: $("#r-view_all_reports").checked,
        delete_reports: $("#r-delete_reports").checked,
        export_import: $("#r-export_import").checked,
      }),
    });
    $("#role-form").reset();
    $("#role-error").classList.add("hidden");
    toast("Rol yaradıldı");
    await loadRoles();
  } catch (err) {
    showError($("#role-error"), err.message);
  }
}

async function createUser(e) {
  e.preventDefault();
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        full_name: $("#u-name").value,
        username: $("#u-username").value,
        password: $("#u-password").value,
        role: $("#u-role").value,
      }),
    });
    $("#user-form").reset();
    $("#user-error").classList.add("hidden");
    toast("Hesab yaradıldı");
    loadUsers();
  } catch (err) {
    showError($("#user-error"), err.message);
  }
}

// ---------- События ----------

document.addEventListener("DOMContentLoaded", async () => {
  // вход
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      me = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#login-username").value,
          password: $("#login-password").value,
        }),
      });
      $("#login-error").classList.add("hidden");
      $("#login-form").reset();
      await showApp();
    } catch (err) {
      showError($("#login-error"), err.message);
    }
  });

  $("#btn-logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    me = null;
    showLogin();
  });

  // вкладки
  $("#nav-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) switchTab(tab.dataset.tab);
  });

  // журнал
  $("#filter-search").addEventListener("input", renderReports);
  $("#filter-xidmet").addEventListener("change", renderReports);
  $("#filter-status").addEventListener("change", renderReports);
  $("#btn-export").addEventListener("click", () => {
    window.location.href = "/api/export";
  });
  $("#btn-delete-all").addEventListener("click", async () => {
    if (reports.length === 0) return toast("Silinəcək qeyd yoxdur", "error");
    if (!confirm(`DİQQƏT: bütün ${reports.length} qeyd birdəfəlik silinəcək.\n\nDavam edilsin?`)) return;
    if (!confirm("Bu əməliyyat geri qaytarıla bilməz. Təsdiq edirsiniz?")) return;
    try {
      const data = await api("/api/reports", { method: "DELETE" });
      toast(`${data.deleted} qeyd silindi`);
      await loadReports();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = confirm(
      "DİQQƏT: mövcud bütün qeydlər silinəcək və seçdiyiniz Excel faylındakı qeydlərlə əvəz olunacaq.\n\nDavam edilsin?"
    );
    if (!ok) {
      e.target.value = "";
      return;
    }
    try {
      const res = await fetch("/api/import", { method: "POST", body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Import xətası");
      toast(`${data.imported} qeyd import olundu`);
      await loadReports();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      e.target.value = "";
    }
  });

  $("#reports-table").addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) return startEdit(Number(editBtn.dataset.edit));
    const delBtn = e.target.closest("[data-del]");
    if (delBtn && confirm(`Qeyd №${delBtn.dataset.del} silinsin?`)) {
      await api(`/api/reports/${delBtn.dataset.del}`, { method: "DELETE" });
      toast("Qeyd silindi");
      await loadReports();
    }
  });

  // форма записи
  $("#report-form").addEventListener("submit", submitReport);
  $("#btn-cancel-edit").addEventListener("click", () => {
    resetForm();
    switchTab("journal");
  });

  // пользователи
  $("#user-form").addEventListener("submit", createUser);
  $("#users-table").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-roleuser]");
    if (!sel) return;
    try {
      await api(`/api/users/${sel.dataset.roleuser}`, {
        method: "PUT",
        body: JSON.stringify({ role: sel.value }),
      });
      toast("Rol dəyişdirildi");
      loadUsers();
    } catch (err) {
      toast(err.message, "error");
      loadUsers();
    }
  });
  $("#users-table").addEventListener("click", async (e) => {
    const pwBtn = e.target.closest("[data-resetpw]");
    if (pwBtn) {
      const np = prompt(`${pwBtn.dataset.name} üçün yeni parol (ən azı 6 simvol):`);
      if (np) {
        try {
          await api(`/api/users/${pwBtn.dataset.resetpw}`, {
            method: "PUT",
            body: JSON.stringify({ password: np }),
          });
          toast("Parol dəyişdirildi");
        } catch (err) {
          toast(err.message, "error");
        }
      }
      return;
    }
    const tgBtn = e.target.closest("[data-toggle]");
    if (tgBtn) {
      await api(`/api/users/${tgBtn.dataset.toggle}`, {
        method: "PUT",
        body: JSON.stringify({ active: tgBtn.dataset.active !== "1" }),
      });
      loadUsers();
    }
  });

  // роли
  $("#role-form").addEventListener("submit", createRole);
  $("#roles-table").addEventListener("change", async (e) => {
    const cb = e.target.closest("[data-roleperm]");
    if (!cb) return;
    try {
      await api(`/api/roles/${cb.dataset.roleperm}`, {
        method: "PUT",
        body: JSON.stringify({ [cb.dataset.field]: cb.checked }),
      });
      toast("Rol yeniləndi");
      await loadRoles();
    } catch (err) {
      toast(err.message, "error");
      await loadRoles();
    }
  });
  $("#roles-table").addEventListener("click", async (e) => {
    const delBtn = e.target.closest("[data-delrole]");
    if (delBtn && confirm(`"${delBtn.dataset.name}" rolu silinsin?`)) {
      try {
        await api(`/api/roles/${delBtn.dataset.delrole}`, { method: "DELETE" });
        toast("Rol silindi");
        await loadRoles();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  // смена пароля
  const dlg = $("#password-dialog");
  $("#btn-password").addEventListener("click", () => {
    $("#password-form").reset();
    $("#password-error").classList.add("hidden");
    dlg.showModal();
  });
  $("#btn-password-close").addEventListener("click", () => dlg.close());
  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/change-password", {
        method: "POST",
        body: JSON.stringify({
          oldPassword: $("#p-old").value,
          newPassword: $("#p-new").value,
        }),
      });
      dlg.close();
      toast("Parol dəyişdirildi");
    } catch (err) {
      showError($("#password-error"), err.message);
    }
  });

  // автологин по сессии
  try {
    me = await api("/api/me");
    await showApp();
  } catch {
    showLogin();
  }
});
