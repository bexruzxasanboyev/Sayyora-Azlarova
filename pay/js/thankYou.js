document.addEventListener("DOMContentLoaded", () => {
    // 🔹 Read formData from localStorage
    let formData = null;

    try {
        const raw = localStorage.getItem("formData");
        if (raw) {
            formData = JSON.parse(raw);
        }
    } catch (e) {
        console.error("Error parsing formData from localStorage:", e);
    }

    // 🔹 Select DOM elements
    const ismEl = document.querySelector(".ism");
    const telEl = document.querySelector(".tel");
    const tarifEl = document.querySelector(".tarif");
    const sanEl = document.querySelector(".san");


    // 🔹 Set date/time: dd/mm/yyyy hh:mm:ss
    if (sanEl) {
        const now = new Date();

        const pad = (n) => n.toString().padStart(2, "0");

        const day = pad(now.getDate());
        const month = pad(now.getMonth() + 1); // 0-based
        const year = now.getFullYear();
        const hours = pad(now.getHours());
        const minutes = pad(now.getMinutes());
        const seconds = pad(now.getSeconds());

        const formatted = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
        sanEl.textContent = formatted;
    }

    // 🔹 If no formData – stop here (leave placeholders)
    if (!formData) {
        console.warn("formData not found in localStorage");
        return;
    }

    if (!ismEl || !telEl || !tarifEl) {
        console.error("One or more required elements (.ism, .tel, .tarif) not found");
        return;
    }

    // 🔹 Fill values from formData
    //  formData structure expected:
    //  { name: "...", phone_number: "...", type: "..." }

    ismEl.textContent = formData.name || "—";
    telEl.textContent = formData.phone_number || "—";
    tarifEl.textContent = formData.type || "—";
});



// IndexedDB helper — rasmni o'qish uchun
function openImageDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("PaymentImages", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("images");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function getImageFromIDB() {
    return openImageDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction("images", "readonly");
            const req = tx.objectStore("images").get("pendingImage");
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    });
}

function deleteImageFromIDB() {
    return openImageDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction("images", "readwrite");
            tx.objectStore("images").delete("pendingImage");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });
}

const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbzgI-eJCrJIIcT_F7DvKQPbIkE_6J5DpYTCeWnZ6Yh4FqfoEO4wWvAES5vmJE3XvGR_/exec";
const PENDING_KEY = "pendingSubmission";
let retryTimer = null;
let retryAttempts = 0;
let cachedImageData = null; // in-memory cache for pagehide/unload
const MAX_RETRIES = 12; // e.g., ~12 attempts (with backoff)
const BASE_DELAY_MS = 2000; // 2s base

// Utility: convert JS payload to FormData (Apps Script expects form payload)
function payloadToFormData(payloadObj) {
    const fd = new FormData();
    Object.entries(payloadObj).forEach(([k, v]) => {
        // ensure strings
        fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    });
    return fd;
}

// Try to send once using fetch (returns true if server says ok)
async function sendOnce(payload) {
    try {
        const fd = payloadToFormData(payload);
        const resp = await fetch(SHEET_URL, {
            method: "POST",
            body: fd,
        });

        if (!resp.ok) {
            // try to parse body as text/json for debug
            let text = await resp.text();
            try { text = JSON.parse(text); } catch (e) {}
            console.warn("Server returned error:", resp.status, text);
            return false;
        }

        // success
        return true;
    } catch (e) {
        console.warn("Network/send error:", e);
        return false;
    }
}

// Fallback: use navigator.sendBeacon with FormData or Blob (best-effort)
function sendBeaconFallback(payload) {
    try {
        if (!navigator.sendBeacon) return false;
        const fd = payloadToFormData(payload);
        // sendBeacon returns true if queued
        return navigator.sendBeacon(SHEET_URL, fd);
    } catch (e) {
        console.warn("sendBeacon failed:", e);
        return false;
    }
}

// Exponential backoff scheduler
function scheduleRetry(payload) {
    if (retryAttempts >= MAX_RETRIES) {
        console.error("Max retries reached — will stop trying.");
        return;
    }
    const delay = Math.min(60000, BASE_DELAY_MS * Math.pow(1.8, retryAttempts)); // cap 60s
    retryAttempts++;
    retryTimer = setTimeout(async() => {
        const ok = await sendOnce(payload);
        if (ok) {
            cleanupSuccess();
        } else {
            scheduleRetry(payload);
        }
    }, delay);
}

// Cleanup on success
function cleanupSuccess() {
    clearTimeout(retryTimer);
    localStorage.removeItem(PENDING_KEY);
    deleteImageFromIDB().catch(() => {});
    retryAttempts = 0;
    retryTimer = null;
    console.log("Submission successful — cleared pendingSubmission.");
    // optionally update UI: show final success message
    const el = document.getElementById("thankYouMessage");
    if (el) el.textContent = "Rahmat! Sizning ma'lumot qabul qilindi.";
}

// Try to send now; returns true if success
// Try to send now; returns true if success
async function trySendAndMaybeRetry() {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) {
        console.log("No pending submission found.");
        return;
    }

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        console.error("Invalid pending payload JSON:", e);
        localStorage.removeItem(PENDING_KEY);
        return;
    }

    // IndexedDB dan rasm ma'lumotini olish
    if (!payload.file_data) {
        try {
            const imageData = await getImageFromIDB();
            if (imageData) {
                payload.file_data = imageData;
                cachedImageData = imageData;
            }
        } catch (e) {
            console.warn("IndexedDB dan rasm olishda xatolik:", e);
        }
    }

    // ✅ Add send date & time (once) before sending
    if (!payload.sana || !payload.vaqt) {
        const now = new Date();

        // Sana: 18.11.2025 kabi
        const sentDate = now.toLocaleDateString("uz-UZ");

        // Soat: 21:34:10 kabi (24 soat format)
        const sentTime = now.toLocaleTimeString("uz-UZ", {
            hour12: false,
        });

        payload.sana = sentDate;
        payload.vaqt = sentTime;

        // ✅ Update localStorage so retries use the same timestamp
        localStorage.setItem(PENDING_KEY, JSON.stringify(payload));
    }

    // First quick attempt with fetch
    const ok = await sendOnce(payload);
    if (ok) {
        cleanupSuccess();
        return;
    }

    // If fetch failed, schedule retries and rely on sendBeacon on unload
    scheduleRetry(payload);
}

// When page is hidden or unloaded, try sendBeacon as last chance
function onPageHideOrUnload() {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch (e) { return; }

    // Add cached image data if available
    if (!payload.file_data && cachedImageData) {
        payload.file_data = cachedImageData;
    }

    // Try sendBeacon
    const beaconOk = sendBeaconFallback(payload);
    if (beaconOk) {
        // If beacon queued, we can remove the pending item.
        localStorage.removeItem(PENDING_KEY);
        console.log("Queued pendingSubmission via sendBeacon and cleared local copy.");
    } else {
        console.warn("sendBeacon not available or failed — pendingSubmission remains for retry.");
    }
}

// Run on load
window.addEventListener("DOMContentLoaded", () => {
    // show a friendly message
    const el = document.getElementById("thankYouMessage");
    if (el) el.textContent = "Rahmat! Sizning ma'lumot qabul qilinishi uchun jarayon boshlanmoqda...";

    // Try to send immediately
    trySendAndMaybeRetry().catch((e) => console.error("Initial send error:", e));
});

// When tab becomes hidden -> try to send via beacon (best-effort)
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        onPageHideOrUnload();
    }
});

// Also handle pagehide (more reliable in some browsers)
window.addEventListener("pagehide", onPageHideOrUnload);
window.addEventListener("beforeunload", onPageHideOrUnload);