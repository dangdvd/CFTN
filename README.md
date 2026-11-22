# CFTN – Theo dõi thi công trên mặt bằng

Web app tô màu tiến độ thi công móng trên mặt bằng (thay cho file Excel *TNL_Mat bang highlight NSP.xlsx*).
Chạy trên **GitHub Pages** (miễn phí), dữ liệu và đăng nhập dùng **Firebase gói Spark** (miễn phí, không cần thẻ).

- Đăng nhập bằng tài khoản Google, hoặc **email + mật khẩu** cho mọi email khác (Outlook, Microsoft 365, email công ty…) có xác nhận qua thư và quên mật khẩu
- 3 quyền: **Chỉ xem** · **Cập nhật** · **Quản trị**, đặt chung cho mọi nhà hoặc riêng từng nhà (quyền riêng ghi đè quyền mặc định)
- Bấm vào móng để nhập ngày hoàn thành 6 công tác (Đào đất → Lấp đất), màu tự đổi, bảng tổng hợp tự tính
- Chọn nhiều móng để cập nhật một lúc; xem mặt bằng tại một ngày bất kỳ; lịch sử ai sửa gì
- 10 mặt bằng: Nhà sấy phun, Nhà kho, Nhà văn phòng (Móng + Đà kiềng); Nhà phụ trợ 1, Nhà phụ trợ 2, Nhà xe, Nhà sấy lạnh (Móng: `#npt1-mong`, `#npt2-mong`, `#nx-mong`, `#nsl-mong`) – chọn ở ô *Mặt bằng*, link riêng từng mặt bằng: `#nsp-mong`, `#nsp`, `#nk-mong`, `#nk-dakieng`
- **Ô lấp đất** (Nhà sấy phun – Đà kiềng): 71 ô giữa các đà kiềng (Ô1…Ô71, đánh số theo hàng từ trên xuống, trái sang phải; bỏ hố pit và hố thang máy, khoét phần bệ móng có cọc). Lấp đất của mặt bằng này = số ô đã lấp / tổng số ô; đà kiềng chỉ theo dõi 5 công tác đầu
- **Ô lấp đất** (Nhà kho – Đà kiềng): 160 ô chia theo lưới trục 3-1…3-13 × 3-M…3-A; ô trục nào có đà kiềng ngăn thành vùng kín thì chia nhỏ hơn; cột biên phải ôm theo đà kiềng xiên; bỏ MF1, MF2, MF3, hố tiếp liệu
- Nhập từ Excel: chọn file highlight, app tự nhận các sheet `NSP_Mong`, `NSP_DaKieng`, `NKho_Mong`, `NKho_DaKieng` (cột AA = Móng, AD:AI = ngày) · Xuất Excel · Xuất ảnh PNG · **Xuất PDF A3** (mặt bằng đang xem hoặc tất cả mặt bằng, mỗi trang một mặt bằng)
- Cập nhật thời gian thực giữa nhiều người, dùng được trên điện thoại
- **📅 Kế hoạch – Báo cáo tuần** (tab trên thanh công cụ):
  - Chọn *Tuần báo cáo* (mặc định Thứ 7 → Thứ 6, đổi ngày bắt đầu thì app nhớ thứ đó). Số liệu chốt đến hết ngày cuối tuần báo cáo
  - **A. Kế hoạch tuần tới**: *▭ Vẽ vùng* (kéo khung) hoặc *⬠ Vẽ đa giác* (bấm các đỉnh, bấm lại đỉnh đầu / Enter để đóng) → mỗi vùng là một tuyến; cấu kiện (đà kiềng/móng và ô sàn đếm riêng) thuộc vùng khi **≥ 50% diện tích** nằm trong vùng – các cấu kiện được tính có viền đậm. *✎ Sửa vùng*: bấm vùng để chọn, kéo đỉnh, kéo chấm giữa cạnh để thêm đỉnh, Alt+bấm đỉnh để xoá đỉnh, kéo trong vùng để di chuyển; công tác của vùng tự cập nhật, số liệu đã nhập được giữ. Bảng 1 tự liệt kê công tác chưa xong trong vùng; nhập ngày bắt đầu/kết thúc (trong tuần tới, kết thúc > bắt đầu), % hoàn thành kế hoạch (> % hiện tại); xoá công tác không làm bằng ×. Bảng 2: % kế hoạch tuần này (> % lũy kế tuần trước)
  - **B. Báo cáo tuần**: lấy kế hoạch đã lập cho tuần đó, nhập % thực hiện trong tuần (nút *Điền % theo thực tế*). Bảng 2: lũy kế tuần này và % kế hoạch tuần tới (chính là % kế hoạch tuần này ở tab A của tuần sau)
  - KL tổng mặc định = số cấu kiện/ô; nhập khối lượng thật + đơn vị (vd 32200 kg) thì KL lũy kế = KL tổng × % hoàn thành theo số cấu kiện
  - Bảng nhân lực – thiết bị (tuỳ chọn); *🖼 Xuất ảnh* (16:9, dán vào PowerPoint) và *📄 Xuất PDF* (A3 ngang) theo mẫu báo cáo tuần

## Cài đặt lần đầu

### 1. Firebase (đã tạo project `cftn-eb891`)
1. **Security → Authentication → Sign-in method → Google → Enable → Save**; bấm **Add new provider → Email/Password → Enable** (không bật *Email link*) → **Save**
2. **Security → Authentication → Settings → Authorized domains → Add domain**: `dangdvd.github.io`
3. **Databases & Storage → Firestore → Create database** (Standard edition, `asia-southeast1`, production mode)
4. **Firestore → tab Rules**: xoá hết, dán toàn bộ nội dung file [`firestore.rules`](firestore.rules), sửa email chủ hệ thống trong hàm `isOwner()`, bấm **Publish**

> Không bấm vào Storage / Functions / App Hosting – các mục đó đòi gói trả phí Blaze. App này không cần.

### 2. Email chủ hệ thống
Sửa **cùng một email** (chữ thường) ở 2 chỗ:
- `js/config.js` → `OWNER_EMAILS`
- `firestore.rules` → hàm `isOwner()` (rồi Publish lại Rules trên Firebase)

### 3. GitHub Pages
Repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
Sau 1–2 phút trang chạy tại: **https://dangdvd.github.io/CFTN/**

### 4. Nạp dữ liệu
Đăng nhập bằng email chủ → **⬆ Nhập từ Excel** → chọn `TNL_Mat bang highlight NSP.xlsx`, rồi làm lại với `TNL_Mat bang highlight NK.xlsx`. Mỗi file nạp cả 2 sheet.

### 5. Thêm người dùng
**👥 Người dùng** → nhập email + chọn quyền → **Thêm**.
- Email Gmail: mở link → **Đăng nhập bằng Google**.
- Email khác (Outlook, Microsoft 365…): mở link → **Lần đầu vào? Tạo mật khẩu** → mở thư xác nhận (xem cả Spam/Junk) → bấm link → quay lại bấm **Tôi đã xác nhận email**. Lần sau chỉ cần email + mật khẩu.

## Cấu trúc

| File | Nội dung |
|---|---|
| `index.html`, `css/style.css` | Giao diện |
| `js/app.js` | Logic: vẽ mặt bằng, tô màu, cập nhật, Excel, quản lý người dùng |
| `js/weekly.js` | Tab Kế hoạch – Báo cáo tuần: khoanh vùng, bảng, xuất trang báo cáo |
| `js/backend.js` | Kết nối Firebase (Auth + Firestore) |
| `js/config.js` | Cấu hình Firebase, email chủ |
| `data/projects.json` | Danh sách mặt bằng |
| `data/<id>.json` | Thông tin mặt bằng + đa giác từng móng (lấy từ shape trong Excel, kể cả shape xoay / vẽ tự do) |
| `data/<id>-plan.png` | Ảnh nền mặt bằng |
| `firestore.rules` | Phân quyền phía server |

Dữ liệu trên Firestore:
- `roles/{email}` – `{role: none|viewer|editor|admin, houses: {nsp|nk|nvp|npt1|npt2|nx|nsl: quyền}, name}`
- `projects/{id}/mong/m{số móng}` (id: `nsp`, `nsp-mong`, `nk-mong`, `nk-dakieng`) – `{d: [6 ngày yyyy-mm-dd | null], by, byName, at, h: [lịch sử]}`
- `projects/{id}/weeks/w{yyyy-mm-dd}` – kế hoạch/báo cáo tuần bắt đầu ngày đó `{zones, rows, t2, res, tA, dA, tB, dB}`; `projects/{id}/weeks/_cfg` – khối lượng tổng nhập tay `{kl}`

Màu: Đào đất `#908700` · Bê tông lót `#00B0F0` · Cốt thép `#C00000` · Cốp pha `#FFC000` · Đổ bê tông `#00B050` · Lấp đất `#7030A0`.
Một móng hiển thị màu của công tác **sau cùng** đã có ngày (giống công thức cột Z trong Excel).

## Hạn mức miễn phí (Firestore Spark)
50.000 lượt đọc / 20.000 lượt ghi mỗi ngày, 1 GiB dữ liệu – dư cho vài công trình và vài chục người dùng. Vượt hạn mức thì tạm ngưng tới hôm sau, không phát sinh phí.
