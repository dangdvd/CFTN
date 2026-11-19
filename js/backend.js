// Lớp truy cập Firebase (Auth + Firestore). Giao diện không gọi Firebase trực tiếp.
import { firebaseConfig, FIREBASE_SDK } from "./config.js";

const { initializeApp } = await import(`${FIREBASE_SDK}/firebase-app.js`);
const A = await import(`${FIREBASE_SDK}/firebase-auth.js`);
const F = await import(`${FIREBASE_SDK}/firebase-firestore.js`);

const app = initializeApp(firebaseConfig);
const auth = A.getAuth(app);
const db = F.getFirestore(app);

export function onUser(cb) {
  return A.onAuthStateChanged(auth, cb);
}

export async function signIn() {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    // Một số trình duyệt điện thoại chặn popup → chuyển sang redirect
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) {
      await A.signInWithRedirect(auth, provider);
    } else {
      throw e;
    }
  }
}

export function signOut() {
  return A.signOut(auth);
}

// ---------- Vai trò ----------
export async function getRole(email) {
  const s = await F.getDoc(F.doc(db, "roles", email.toLowerCase()));
  return s.exists() ? s.data() : null;
}

export function watchRoles(cb, err) {
  return F.onSnapshot(F.collection(db, "roles"),
    (snap) => cb(snap.docs.map((d) => ({ email: d.id, ...d.data() }))), err);
}

export function setRole(email, data) {
  return F.setDoc(F.doc(db, "roles", email.toLowerCase()), data);
}

export function deleteRole(email) {
  return F.deleteDoc(F.doc(db, "roles", email.toLowerCase()));
}

// ---------- Dữ liệu móng ----------
export function watchMong(projectId, cb, err) {
  return F.onSnapshot(F.collection(db, "projects", projectId, "mong"), (snap) => {
    const out = {};
    snap.docs.forEach((d) => { out[d.id.replace(/^m/, "")] = d.data(); });
    cb(out, snap.metadata.fromCache);
  }, err);
}

export function saveMong(projectId, n, data) {
  return F.setDoc(F.doc(db, "projects", projectId, "mong", "m" + n), data);
}

// Ghi nhiều móng một lần (tối đa 400 thao tác / batch)
export async function saveMongMany(projectId, entries) {
  for (let i = 0; i < entries.length; i += 400) {
    const b = F.writeBatch(db);
    entries.slice(i, i + 400).forEach(([n, data]) =>
      b.set(F.doc(db, "projects", projectId, "mong", "m" + n), data));
    await b.commit();
  }
}
