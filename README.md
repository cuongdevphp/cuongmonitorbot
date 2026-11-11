# Binance Spot Monitor

Ứng dụng Node.js theo dõi giá tất cả các cặp spot USDT trên Binance qua WebSocket với khung thời gian 1 phút.

## Tính năng

- ✅ Kết nối WebSocket với tất cả cặp spot USDT trên Binance
- ✅ Nhận dữ liệu kline 1 phút real-time
- ✅ Phân tích xu hướng LONG/SHORT dựa trên giá mở và đóng
- ✅ Tính phần trăm thay đổi giá
- ✅ Tự động kết nối lại khi mất kết nối
- ✅ Hiển thị màu sắc cho từng loại tín hiệu

## Cài đặt

```bash
cd binance-spot-monitor
npm install
```

## Chạy ứng dụng

```bash
npm start
```

Sau khi chạy, mở trình duyệt và truy cập: **http://localhost:3000**

## Logic phân tích

- **LONG (Màu xanh)**: Khi `openPrice < closePrice` - Giá tăng
  - `precent = 100 - (openPrice / closePrice * 100)`
  - `currentPrice = openPrice`

- **SHORT (Màu đỏ)**: Khi `openPrice > closePrice` - Giá giảm
  - `precent = 100 - (closePrice / openPrice * 100)`
  - `currentPrice = openPrice`

- **FLAT (Màu vàng)**: Khi `openPrice = closePrice` - Không đổi

## Output mẫu

```
[14:30:45] BTCUSDT      | Type: LONG  | Open: 43250.50000000 | Close: 43280.30000000 | Change: 0.07% | Volume: 1234.56
[14:30:46] ETHUSDT      | Type: SHORT | Open: 2250.80000000 | Close: 2248.50000000 | Change: 0.10% | Volume: 5678.90
```

## Lưu ý

- Ứng dụng chỉ theo dõi các cặp có quote asset là USDT
- Chỉ hiển thị các nến đã đóng hoặc có biến động > 0.5%
- WebSocket sẽ tự động kết nối lại nếu bị ngắt kết nối
