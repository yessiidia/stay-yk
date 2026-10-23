/* ===========================================================
   CineSeat — logika pemesanan kursi (Vanilla JS + Firebase RTDB)
   =========================================================== */

/* -----------------------------------------------------------
   1) FIREBASE CONFIG
   -----------------------------------------------------------
   👉 TARUH FIREBASE CONFIG ANDA DI SINI.
   Ambil dari Firebase Console → Project settings → General →
   "Your apps" → Web app → SDK setup and configuration → Config.
   Pastikan `databaseURL` ikut terisi (alamat Realtime Database).
   ----------------------------------------------------------- */
// 1. Import semua modul Firebase yang dibutuhkan
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// 2. Masukkan Konfigurasi Firebase milikmu
const firebaseConfig = {
  apiKey: "AIzaSyDljRhwCVnJpQ2JcoNouMzMqL4Ng5c0iWY",
  authDomain: "skz-yk.firebaseapp.com",
  projectId: "skz-yk",
  storageBucket: "skz-yk.firebasestorage.app",
  messagingSenderId: "959559417054",
  appId: "1:959559417054:web:bcc20b8ae5cb7320fa164f",
  measurementId: "G-53QVKY1D10"
};

// 3. Inisialisasi Aplikasi, Database, dan Autentikasi
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 4. Eksekusi Login Anonim saat halaman dimuat
signInAnonymously(auth)
  .then((result) => {
    // Jika berhasil, user mendapat UID unik
    const user = result.user;
    console.log("Login anonim sukses! UID Pengguna:", user.uid);
    
    // Web sudah siap digunakan untuk membaca/menulis data booking
  })
  .catch((error) => {
    // Jika gagal, tampilkan pesan error di console
    console.error("Gagal login anonim:", error.code, error.message);
  });

/* -----------------------------------------------------------
   2) KONFIGURASI DENAH (total 58 kursi)
   Grid 11 kolom: 5 kiri | lorong | 5 kanan. Urutan dari atas
   (paling belakang) ke bawah (paling dekat layar).
   Angka = nomor kursi, null = kosong.
   Baris F: 9 kursi (F05 berada di lorong)
   Baris E: 9 kursi
   Baris D–A: 10 kursi × 4 = 40
   ----------------------------------------------------------- */
const LAYOUT = [
  { row: "F", cells: [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, null] },
  { row: "E", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, null] },
  { row: "D", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "C", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "B", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "A", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
];
const MAX_SEATS_PER_EMAIL = 2;
const SLOT_KEYS = ["s1", "s2"]; // slot kuota per email (dikunci juga oleh Security Rules)
const TOTAL_SEATS = LAYOUT.reduce((n, r) => n + r.cells.filter(Boolean).length, 0); // 58
const NAME_MAX = 50;

/* -----------------------------------------------------------
   3) STATE APLIKASI
   ----------------------------------------------------------- */
const state = {
  db: null,
  uid: null,
  name: null,        // nama pemesan (disimpan di data kursi)
  email: null,       // email asli (hanya di memori browser)
  emailKey: null,    // SHA-256 dari email → key di database (privasi)
  seats: {},         // snapshot /seats dari Firebase
  userSlots: {},     // snapshot /users/{emailKey} → { s1: "B3", s2: "C4" }
  selected: new Set(), // kursi "Sedang Dipilih" (lokal, belum dikonfirmasi)
  userRef: null,
  firstLoad: true,
  booking: false,
};

/* -----------------------------------------------------------
   4) ELEMEN DOM
   ----------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const el = {
  seatMap: $("seatMap"),
  lockHint: $("lockHint"),
  emailForm: $("emailForm"),
  nameInput: $("nameInput"),
  emailInput: $("emailInput"),
  emailMsg: $("emailMsg"),
  emailBtn: $("emailBtn"),
  confirmBtn: $("confirmBtn"),
  selectedList: $("selectedList"),
  ownedList: $("ownedList"),
  quota: $("quota"),
  statAvailable: $("statAvailable"),
  statBooked: $("statBooked"),
  conn: $("connStatus"),
  toasts: $("toasts"),
};
const seatButtons = new Map(); // seatId → <button>

/* -----------------------------------------------------------
   5) UTILITAS
   ----------------------------------------------------------- */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(email) {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

// Rapikan spasi berlebih pada nama
function cleanName(name) {
  return name.replace(/\s+/g, " ").trim();
}

function isValidName(name) {
  return name.length >= 2 && name.length <= NAME_MAX;
}

// Hash email → hex SHA-256. Email asli tidak pernah disimpan ke database.
async function hashEmail(email) {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// "budi.santoso@gmail.com" → "bu***@gmail.com"
function maskEmail(email) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function toast(message, type = "info", ms = 3800) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

function ownedSeats() {
  return Object.values(state.userSlots || {}).filter(Boolean);
}

function remainingQuota() {
  return MAX_SEATS_PER_EMAIL - ownedSeats().length - state.selected.size;
}

/* -----------------------------------------------------------
   6) RENDER DENAH KURSI
   ----------------------------------------------------------- */
function buildSeatMap() {
  const frag = document.createDocumentFragment();

  LAYOUT.forEach(({ row, cells }) => {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    rowEl.setAttribute("role", "row");

    cells.forEach((n) => {
      if (!n) {
        const gap = document.createElement("span");
        gap.className = "seat-gap";
        rowEl.appendChild(gap);
        return;
      }
      const id = `${row}${String(n).padStart(2, "0")}`; // mis. "A01"
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat available";
      btn.dataset.seat = id;
      btn.textContent = id;
      btn.setAttribute("role", "gridcell");
      btn.setAttribute("aria-label", `Kursi ${id}, tersedia`);
      seatButtons.set(id, btn);
      rowEl.appendChild(btn);
    });

    frag.appendChild(rowEl);
  });

  el.seatMap.appendChild(frag);
  el.seatMap.addEventListener("click", onSeatClick);
}

// Sinkronkan tampilan semua kursi dengan state saat ini
function renderSeats() {
  let booked = 0;

  seatButtons.forEach((btn, id) => {
    const data = state.seats[id];
    let status = "available";

    if (data) {
      booked++;
      status = state.emailKey && data.owner === state.emailKey ? "mine" : "booked";
    } else if (state.selected.has(id)) {
      status = "selected";
    }

    if (!btn.classList.contains(status)) {
      btn.classList.remove("available", "selected", "mine", "booked");
      btn.classList.add(status);
    }
    btn.disabled = status === "booked" || status === "mine";

    const labels = {
      available: "tersedia",
      selected: "sedang dipilih",
      mine: "milik Anda",
      booked: "sudah dibooking",
    };
    btn.setAttribute("aria-label", `Kursi ${id}, ${labels[status]}`);
    btn.title = status === "booked" ? `Dibooking oleh ${data.emailMasked || "pengguna lain"}` : `Kursi ${id}`;
  });

  el.statBooked.textContent = booked;
  el.statAvailable.textContent = TOTAL_SEATS - booked;
  renderSummary();
}

function renderSummary() {
  const sel = [...state.selected];
  const owned = ownedSeats();

  el.selectedList.textContent = sel.length ? sel.join(", ") : "—";
  el.ownedList.textContent = owned.length ? owned.join(", ") : "—";
  el.quota.textContent = state.emailKey ? Math.max(0, remainingQuota()) : MAX_SEATS_PER_EMAIL;
  el.confirmBtn.disabled = !state.emailKey || sel.length === 0 || state.booking;

  const unlocked = Boolean(state.emailKey);
  el.seatMap.classList.toggle("locked", !unlocked);
  el.lockHint.classList.toggle("hidden", unlocked && owned.length < MAX_SEATS_PER_EMAIL);
  if (unlocked && owned.length >= MAX_SEATS_PER_EMAIL) {
    el.lockHint.textContent = "Kuota email ini sudah penuh (2 kursi). Terima kasih!";
  } else if (!unlocked) {
    el.lockHint.textContent = "Masukkan nama dan email yang valid untuk mulai memilih kursi.";
  }
}

/* -----------------------------------------------------------
   7) INTERAKSI KURSI
   ----------------------------------------------------------- */
function onSeatClick(e) {
  const btn = e.target.closest(".seat");
  if (!btn) return;
  const id = btn.dataset.seat;

  if (!state.emailKey) {
    toast("Isi nama dan alamat email yang valid terlebih dahulu.", "warn");
    (el.nameInput.value.trim() ? el.emailInput : el.nameInput).focus();
    return;
  }
  if (state.seats[id]) return; // sudah dibooking

  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    if (remainingQuota() <= 0) {
      const owned = ownedSeats().length;
      toast(
        owned >= MAX_SEATS_PER_EMAIL
          ? "Email ini sudah memiliki 2 kursi. Tidak bisa memesan lagi."
          : `Maksimal ${MAX_SEATS_PER_EMAIL} kursi per email (Anda sudah punya ${owned}).`,
        "warn"
      );
      return;
    }
    state.selected.add(id);
  }
  renderSeats();
}

/* -----------------------------------------------------------
   8) FORM NAMA & EMAIL
   ----------------------------------------------------------- */
el.nameInput.addEventListener("input", () => {
  const v = cleanName(el.nameInput.value);
  el.nameInput.classList.toggle("invalid", v.length > 0 && !isValidName(v));
  el.nameInput.classList.toggle("valid", isValidName(v));
});

el.emailInput.addEventListener("input", () => {
  const v = el.emailInput.value.trim();
  el.emailInput.classList.toggle("invalid", v.length > 0 && !isValidEmail(v));
  el.emailInput.classList.toggle("valid", isValidEmail(v));
});

el.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = cleanName(el.nameInput.value);
  const email = el.emailInput.value.trim().toLowerCase();

  if (!isValidName(name)) {
    setEmailMsg(`Nama wajib diisi (2–${NAME_MAX} karakter).`, "error");
    el.nameInput.classList.add("invalid");
    el.nameInput.focus();
    return;
  }
  if (!isValidEmail(email)) {
    setEmailMsg("Format email tidak valid. Contoh: nama@email.com", "error");
    el.emailInput.classList.add("invalid");
    return;
  }
  if (!state.db) {
    setEmailMsg("Belum terhubung ke Firebase. Periksa konfigurasi.", "error");
    return;
  }

  // Ganti email → hentikan listener lama & bersihkan pilihan
  if (state.userRef) state.userRef.off();
  state.selected.clear();
  state.userSlots = {};

  state.name = name;
  state.email = email;
  state.emailKey = await hashEmail(email);
  state.userRef = state.db.ref(`users/${state.emailKey}`);

  // Pantau kuota email ini secara real-time
  state.userRef.on("value", (snap) => {
    state.userSlots = snap.val() || {};
    // Jika kuota penuh (mis. dibooking dari tab lain), batalkan pilihan berlebih
    while (state.selected.size > 0 && remainingQuota() < 0) {
      state.selected.delete([...state.selected].pop());
    }
    renderSeats();
  });

  setEmailMsg(`Masuk sebagai ${name} (${email})`, "ok");
  el.emailBtn.textContent = "Ganti";
  renderSeats();
});

function setEmailMsg(text, type) {
  el.emailMsg.textContent = text;
  el.emailMsg.className = `field-msg ${type || ""}`;
}

/* -----------------------------------------------------------
   9) KONFIRMASI BOOKING — ANTI RACE CONDITION
   -----------------------------------------------------------
   Semua kursi + slot kuota ditulis dalam SATU multi-path update.
   Multi-path update di Realtime Database bersifat ATOMIK:
   semua berhasil atau semua gagal.

   Security Rules (lihat firebase/database.rules.json) menolak:
     • menulis kursi yang SUDAH ADA (!data.exists())  → 2 orang
       klik kursi sama bersamaan: yang kedua otomatis ditolak.
     • slot kuota selain s1/s2 atau slot yang sudah terisi
       → 1 email maksimal 2 kursi, divalidasi di server.
   ----------------------------------------------------------- */
el.confirmBtn.addEventListener("click", confirmBooking);

async function confirmBooking() {
  const seatsToBook = [...state.selected];
  if (!seatsToBook.length || state.booking) return;

  // Nama boleh diubah setelah "Lanjut", jadi ambil nilai terbaru
  state.name = cleanName(el.nameInput.value);
  if (!isValidName(state.name)) {
    toast(`Nama wajib diisi (2–${NAME_MAX} karakter).`, "error");
    el.nameInput.focus();
    return;
  }

  const freeSlots = SLOT_KEYS.filter((k) => !state.userSlots[k]);
  if (seatsToBook.length > freeSlots.length) {
    toast("Kuota email tidak mencukupi. Maksimal 2 kursi per email.", "error");
    return;
  }

  // Cek cepat di sisi klien (server tetap menjadi penentu akhir)
  const taken = seatsToBook.filter((id) => state.seats[id]);
  if (taken.length) {
    taken.forEach((id) => state.selected.delete(id));
    renderSeats();
    toast(`Kursi ${taken.join(", ")} baru saja dibooking orang lain.`, "error");
    return;
  }

  const updates = {};
  seatsToBook.forEach((seatId, i) => {
    updates[`seats/${seatId}`] = {
      owner: state.emailKey,
      name: state.name,
      emailMasked: maskEmail(state.email),
      uid: state.uid,
      bookedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    updates[`users/${state.emailKey}/${freeSlots[i]}`] = seatId;
  });

  state.booking = true;
  el.confirmBtn.classList.add("loading");
  el.confirmBtn.textContent = "Memproses…";
  renderSummary();

  try {
    await state.db.ref().update(updates);
    state.selected.clear();
    toast(`Booking berhasil! Kursi ${seatsToBook.join(", ")} milik Anda. 🎬`, "success", 5000);
  } catch (err) {
    console.error(err);
    if (String(err.code || err.message).toUpperCase().includes("PERMISSION_DENIED")) {
      toast(
        "Booking gagal: kursi sudah diambil orang lain atau kuota email sudah penuh. Silakan pilih ulang.",
        "error",
        5500
      );
      // Buang pilihan yang kini sudah terisi
      seatsToBook.forEach((id) => state.seats[id] && state.selected.delete(id));
    } else {
      toast("Terjadi kesalahan jaringan. Coba lagi.", "error");
    }
  } finally {
    state.booking = false;
    el.confirmBtn.classList.remove("loading");
    el.confirmBtn.textContent = "Konfirmasi Booking";
    renderSeats();
  }
}

/* -----------------------------------------------------------
   10) LISTENER REAL-TIME FIREBASE
   ----------------------------------------------------------- */
function listenSeats() {
  state.db.ref("seats").on(
    "value",
    (snap) => {
      const prev = state.seats;
      state.seats = snap.val() || {};

      // Kursi yang sedang dipilih user ternyata dibooking orang lain
      const lost = [...state.selected].filter((id) => state.seats[id]);
      if (lost.length) {
        lost.forEach((id) => state.selected.delete(id));
        toast(`Kursi ${lost.join(", ")} baru saja dibooking orang lain.`, "warn");
      }

      // Efek kilat untuk kursi yang baru dibooking (bukan saat load pertama)
      if (!state.firstLoad) {
        Object.keys(state.seats)
          .filter((id) => !prev[id])
          .forEach((id) => {
            const b = seatButtons.get(id);
            if (!b) return;
            b.classList.remove("just-booked");
            void b.offsetWidth;
            b.classList.add("just-booked");
          });
      }
      state.firstLoad = false;
      renderSeats();
    },
    (err) => {
      console.error(err);
      toast("Gagal membaca data kursi. Periksa Security Rules.", "error");
    }
  );

  // Indikator koneksi
  state.db.ref(".info/connected").on("value", (snap) => {
    const online = snap.val() === true;
    el.conn.classList.toggle("online", online);
    el.conn.classList.toggle("offline", !online);
    el.conn.querySelector(".conn-label").textContent = online ? "Live" : "Offline";
  });
}

/* -----------------------------------------------------------
   11) INISIALISASI
   ----------------------------------------------------------- */
async function init() {
  buildSeatMap();
  renderSeats();

  if (firebaseConfig.apiKey.startsWith("GANTI_")) {
    el.conn.classList.add("offline");
    el.conn.querySelector(".conn-label").textContent = "Belum dikonfigurasi";
    toast("Firebase belum dikonfigurasi. Isi firebaseConfig di app.js.", "warn", 8000);
    return;
  }

  try {
    firebase.initializeApp(firebaseConfig);
    // Anonymous Auth: setiap penulisan wajib terautentikasi (lihat Security Rules)
    const cred = await firebase.auth().signInAnonymously();
    state.uid = cred.user.uid;
    state.db = firebase.database();
    listenSeats();
  } catch (err) {
    console.error(err);
    el.conn.classList.add("offline");
    el.conn.querySelector(".conn-label").textContent = "Gagal terhubung";
    toast("Tidak dapat terhubung ke Firebase. Aktifkan Anonymous Auth & cek config.", "error", 8000);
  }
}

init();
