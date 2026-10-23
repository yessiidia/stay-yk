/* ===========================================================
   CineSeat — logika pemesanan kursi (Vanilla JS + Firebase RTDB v9)
   =========================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase, ref, onValue, update, serverTimestamp, off } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// 1) FIREBASE CONFIG
const firebaseConfig = {
  apiKey: "AIzaSyDljRhwCVnJpQ2JcoNouMzMqL4Ng5c0iWY",
  authDomain: "skz-yk.firebaseapp.com",
  projectId: "skz-yk",
  storageBucket: "skz-yk.firebasestorage.app",
  messagingSenderId: "959559417054",
  appId: "1:959559417054:web:bcc20b8ae5cb7320fa164f",
  measurementId: "G-53QVKY1D10",
  databaseURL: "https://skz-yk-default-rtdb.asia-southeast1.firebasedatabase.app"
};

// Inisialisasi Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// 2) KONFIGURASI DENAH (total 58 kursi)
const LAYOUT = [
  { row: "F", cells: [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, null] },
  { row: "E", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, null] },
  { row: "D", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "C", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "B", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
  { row: "A", cells: [1, 2, 3, 4, 5, null, 6, 7, 8, 9, 10] },
];
const MAX_SEATS_PER_EMAIL = 2;
const SLOT_KEYS = ["s1", "s2"];
const TOTAL_SEATS = LAYOUT.reduce((n, r) => n + r.cells.filter(Boolean).length, 0);
const NAME_MAX = 50;

// 3) STATE APLIKASI
const state = {
  uid: null,
  name: null,
  email: null,
  emailKey: null,
  seats: {},
  userSlots: {},
  selected: new Set(),
  userRef: null,
  firstLoad: true,
  booking: false,
};

// 4) ELEMEN DOM
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
const seatButtons = new Map();

// 5) UTILITAS
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function isValidEmail(email) { return EMAIL_REGEX.test(email) && email.length <= 254; }
function cleanName(name) { return name.replace(/\s+/g, " ").trim(); }
function isValidName(name) { return name.length >= 2 && name.length <= NAME_MAX; }

async function hashEmail(email) {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

function ownedSeats() { return Object.values(state.userSlots || {}).filter(Boolean); }
function remainingQuota() { return MAX_SEATS_PER_EMAIL - ownedSeats().length - state.selected.size; }

// 6) RENDER DENAH KURSI
function buildSeatMap() {
  const frag = document.createDocumentFragment();

  LAYOUT.forEach(({ row, cells }) => {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    rowEl.setAttribute("role", "row"); // <-- Ini yang bikin CSS-mu jalan

    cells.forEach((n) => {
      if (!n) {
        const gap = document.createElement("span");
        gap.className = "seat-gap";
        rowEl.appendChild(gap);
        return;
      }
      const id = `${row}${String(n).padStart(2, "0")}`; 
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat available";
      btn.dataset.seat = id;
      btn.textContent = id;
      btn.setAttribute("role", "gridcell"); // <-- Ini juga penting untuk CSS-mu
      btn.setAttribute("aria-label", `Kursi ${id}, tersedia`);
      seatButtons.set(id, btn);
      rowEl.appendChild(btn);
    });

    frag.appendChild(rowEl);
  });

  el.seatMap.appendChild(frag);
  el.seatMap.addEventListener("click", onSeatClick);
}

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
    el.lockHint.textContent = "Kuota email ini sudah penuh (2 kursi).";
  } else if (!unlocked) {
    el.lockHint.textContent = "Masukkan nama dan email yang valid untuk mulai memilih kursi.";
  }
}

// 7) INTERAKSI KURSI
function onSeatClick(e) {
  const btn = e.target.closest(".seat");
  if (!btn) return;
  const id = btn.dataset.seat;
  if (!state.emailKey) {
    toast("Isi nama dan alamat email terlebih dahulu.", "warn");
    return;
  }
  if (state.seats[id]) return; 

  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    if (remainingQuota() <= 0) {
      toast("Maksimal 2 kursi per email.", "warn");
      return;
    }
    state.selected.add(id);
  }
  renderSeats();
}

// 8) FORM NAMA & EMAIL
el.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = cleanName(el.nameInput.value);
  const email = el.emailInput.value.trim().toLowerCase();

  if (!isValidName(name) || !isValidEmail(email)) return;

  if (state.userRef) off(state.userRef);
  state.selected.clear();
  state.userSlots = {};

  state.name = name;
  state.email = email;
  state.emailKey = await hashEmail(email);
  
  // Real-time pemantauan kuota menggunakan Firebase v9
  state.userRef = ref(db, `users/${state.emailKey}`);
  onValue(state.userRef, (snap) => {
    state.userSlots = snap.val() || {};
    while (state.selected.size > 0 && remainingQuota() < 0) {
      state.selected.delete([...state.selected].pop());
    }
    renderSeats();
  });

  el.emailMsg.textContent = `Masuk sebagai ${name}`;
  el.emailBtn.textContent = "Ganti";
  renderSeats();
});

// 9) KONFIRMASI BOOKING
el.confirmBtn.addEventListener("click", async () => {
  const seatsToBook = [...state.selected];
  if (!seatsToBook.length || state.booking) return;

  const freeSlots = SLOT_KEYS.filter((k) => !state.userSlots[k]);
  const updates = {};
  
  seatsToBook.forEach((seatId, i) => {
    updates[`seats/${seatId}`] = {
      owner: state.emailKey,
      name: state.name,
      emailMasked: maskEmail(state.email),
      uid: state.uid,
      bookedAt: serverTimestamp(), // Menggunakan fungsi modular v9
    };
    updates[`users/${state.emailKey}/${freeSlots[i]}`] = seatId;
  });

  state.booking = true;
  el.confirmBtn.textContent = "Memproses…";

  try {
    // Update atomik menggunakan Firebase v9
    await update(ref(db), updates);
    state.selected.clear();
    toast(`Booking berhasil! 🎬`, "success");
  } catch (err) {
    toast("Booking gagal: kursi sudah diambil atau error jaringan.", "error");
  } finally {
    state.booking = false;
    el.confirmBtn.textContent = "Konfirmasi Booking";
    renderSeats();
  }
});

// 10) LISTENER REAL-TIME FIREBASE
function listenSeats() {
  onValue(ref(db, "seats"), (snap) => {
    state.seats = snap.val() || {};
    
    const lost = [...state.selected].filter((id) => state.seats[id]);
    if (lost.length) {
      lost.forEach((id) => state.selected.delete(id));
      toast(`Kursi dibooking orang lain.`, "warn");
    }
    renderSeats();
  });

  onValue(ref(db, ".info/connected"), (snap) => {
    const online = snap.val() === true;
    el.conn.classList.toggle("online", online);
    el.conn.classList.toggle("offline", !online);
    el.conn.querySelector(".conn-label").textContent = online ? "Live" : "Offline";
  });
}

// 11) INISIALISASI
async function init() {
  buildSeatMap();
  renderSeats();

  try {
    const cred = await signInAnonymously(auth);
    state.uid = cred.user.uid;
    console.log("Login anonim sukses! UID:", state.uid);
    listenSeats();
  } catch (err) {
    console.error(err);
    el.conn.classList.add("offline");
    el.conn.querySelector(".conn-label").textContent = "Gagal terhubung";
  }
}

init();
