# Hướng dẫn Deploy lên Coolify bằng Nixpacks (Không dùng Docker)

Tài liệu này hướng dẫn bạn cách deploy ứng dụng **AI-QuantBot** lên Coolify bằng **Nixpacks** (cơ chế build mặc định của Coolify, không cần viết Dockerfile thủ công). 

Nhờ có file `nixpacks.toml` trong dự án, Coolify sẽ tự động nhận diện, cài đặt cả **Node.js 20** và **Python 3.12**, đồng thời tự động cài các thư viện ML (`xgboost`, `lightgbm`, `onnx`,...) để bot tự train ONNX trong nền mà không cần cấu hình phức tạp.

---

## Kiến trúc triển khai (Single Service)

```
GitHub Repository (Next.js + Python ML)
    │
    └── nixpacks.toml (Cấu hình cài cả Node & Python)
    │
    └── Coolify Application (Nixpacks Build Pack)
         ├── Chạy ứng dụng Next.js chính (Cổng 3000)
         └── Tự động chạy train_one.py trong nền mỗi 6h
```

Bạn **chỉ cần tạo 1 Application duy nhất** trên Coolify. Không cần tạo thêm container phụ, không cần cài thêm addon Python ngoài.

---

## Các bước thiết lập trên Coolify

### Bước 1: Tạo Persistent Storage (Lưu trữ trạng thái)

Để dữ liệu giao dịch và các file model `.onnx` không bị mất khi bạn deploy phiên bản mới, hãy tạo volume lưu trữ:

1. Vào Coolify → **Storage** → **New Volume**.
2. Đặt tên volume: `ai-quantbot-data`.

### Bước 2: Tạo Application mới từ GitHub

1. Chọn **New Resource** → **Application** → **GitHub**.
2. Chọn Repository của bạn và nhánh muốn deploy (ví dụ: `main`).
3. Tại phần **Build Pack**, Coolify sẽ tự động nhận diện hoặc bạn hãy chọn **Nixpacks**.

### Bước 3: Cấu hình Volume (Storage)

1. Vào tab **Destinations** hoặc **Storage** của Application vừa tạo.
2. Thêm mount volume đã tạo ở Bước 1:
   - Volume: `ai-quantbot-data`
   - Container Path: `/app/data` (để lưu file trạng thái bot)
   - (Tùy chọn) Bạn có thể mount thêm một đường dẫn `/app/ml/models` nếu muốn giữ lại các file `.onnx` cũ qua các lần deploy.

### Bước 4: Cấu hình Biến môi trường (Environment Variables)

Vào tab **Environment Variables** và thêm các biến môi trường cần thiết:

| Biến môi trường | Giá trị mẫu | Mô tả |
|---|---|---|
| `BINANCE_API_KEY` | `your_api_key` | API Key sàn Binance (bắt buộc để trade) |
| `BINANCE_API_SECRET` | `your_api_secret` | API Secret sàn Binance (bắt buộc để trade) |
| `LLM_PROVIDER` | `gemini` | `openai` / `gemini` / `anthropic` |
| `LLM_API_KEY` | `your_llm_key` | API Key của nhà cung cấp LLM |
| `LLM_MODEL` | `gemini-2.5-flash` | Model sử dụng cho Quant Operator |
| `BOT_DATA_DIR` | `/app/data` | Thư mục lưu trạng thái (trùng với volume mount) |
| `BOT_MODEL_DIR` | `/app/ml/models` | Thư mục lưu trữ các file model `.onnx` |

### Bước 5: Deploy!

Nhấn nút **Deploy** trên giao diện Coolify. 

1. Nixpacks sẽ đọc file `nixpacks.toml`.
2. Nó sẽ tải môi trường Node.js và Python 3.12 về.
3. Nó chạy `npm ci` để cài dependencies của Next.js.
4. Nó chạy `pip install` để cài các thư viện ML của Python.
5. Nó build Next.js và khởi chạy ứng dụng.

---

## Đồng bộ ví Trust Wallet (TWAK) và Thư viện

Thư viện Trust Wallet CLI (`@trustwallet/cli`) đã được tích hợp tự động cài đặt toàn cục trong cả Dockerfile và Nixpacks. 

Để giữ nguyên thông tin ví (`wallet.json`) và API credentials (`credentials.json`) từ máy local của bạn lên VPS:

1. **Thư mục cấu hình**: Hệ thống đã được thiết lập biến môi trường `HOME=/data`. Điều này chuyển hướng thư mục cấu hình của `twak` từ thư mục tạm của container sang `/data/.twak` (nằm trên persistent volume `ai-quantbot-data`).
2. **Copy file ví sang VPS**: 
   - Trên máy local, các file ví và credentials nằm tại thư mục `C:\Users\<Tên_User>\.twak\`.
   - Sao chép toàn bộ thư mục `.twak` (bao gồm cả `wallet.json` và `credentials.json`) từ máy local lên thư mục mount volume `/data/` của container trên VPS (Đường dẫn volume thực tế trên VPS thường là `/var/lib/docker/volumes/ai-quantbot-data/_data/.twak/` hoặc bạn có thể upload bằng công cụ SFTP/FileManager có sẵn trên Coolify).
   - Hãy chắc chắn rằng file trên VPS có phân quyền hợp lệ (chạy lệnh `chown -R 1001:1001 /data/.twak` trong container nếu dùng Dockerfile non-root, hoặc cấp quyền đọc ghi cho user chạy ứng dụng).
3. **Thêm biến môi trường ví**:
   - Thêm biến môi trường `TWAK_WALLET_PASSWORD` (mật khẩu ví của bạn) vào tab **Environment Variables** trên Coolify để bot tự động mở khóa ví khi thực hiện các giao dịch swap.
   - Thêm biến `TWAK_AGENT_WALLET` (địa chỉ ví BSC của bạn) để bot đồng bộ kiểm tra số dư.

---

## Cách kiểm tra hoạt động của Bot

Sau khi deploy thành công, bạn có thể theo dõi log của ứng dụng:
- Khi bot chạy, nó sẽ tự động kích hoạt tiến trình huấn luyện ONNX trong nền cho các cặp tiền hoạt động.
- Bạn sẽ thấy log dạng:
  ```
  🐍 [ONNX] Bắt đầu tái huấn luyện Python [BTCUSDT] trong nền...
  [ONNX BTCUSDT] Walk-forward mean acc = 0.585 +/- 0.021
  ✅ [ONNX] Huấn luyện [BTCUSDT] hoàn tất. Model mới sẽ được dùng ở lần predict tiếp theo.
  ```
- Hoàn toàn tự động, không cần cronjob ngoài, không cần quản lý Docker phức tạp!
