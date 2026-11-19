// =====================================================================
//  CẤU HÌNH – sửa ở đây
// =====================================================================

// Cấu hình Firebase (lấy ở Firebase console → Settings → General → Your apps).
// Đoạn này công khai được; dữ liệu được bảo vệ bằng firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCXktv2aEfTAbLusSrbgf2GLovtrVrE0m0",
  authDomain: "cftn-eb891.firebaseapp.com",
  projectId: "cftn-eb891",
  storageBucket: "cftn-eb891.firebasestorage.app",
  messagingSenderId: "834713577424",
  appId: "1:834713577424:web:6a8b85c3c940358b60fbd5"
};

// Email Google của CHỦ hệ thống (luôn có quyền Quản trị).
// Phải TRÙNG với email ghi trong firestore.rules (hàm isOwner).
export const OWNER_EMAILS = [
  "owner_email@gmail.com"
];

// Phiên bản Firebase JS SDK tải từ CDN
export const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2";
