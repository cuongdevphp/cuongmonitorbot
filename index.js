const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');
const http = require('http');
const path = require('path');

// Đọc .env nếu có (Node >= 21) - phải chạy trước khi đọc process.env bên dưới
try { process.loadEnvFile(); } catch (_) { /* không có .env thì bỏ qua */ }

// Tạo Express server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket clients
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('Client connected to web interface');
    clients.add(ws);

    ws.on('close', () => {
        console.log('Client disconnected from web interface');
        clients.delete(ws);
    });
});

// Broadcast data to all connected clients
function broadcastToClients(data) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Các mã cần bỏ qua: stock token (bStocks: AAPLB, TSLAB, ...) và fan token (fan_token).
// exchangeInfo không phân loại, nên lấy tag từ API sản phẩm của Binance.
const EXCLUDED_TAGS = ['bStocks', 'fan_token'];
let stockSymbols = new Set(); // tên cũ, giờ chứa tất cả mã bị loại

// Cache ra file: API này đôi khi bị mạng chặn, lúc đó vẫn dùng được danh sách lần trước
const EXCLUDED_CACHE_FILE = path.join(__dirname, 'excluded-symbols.json');
try {
    stockSymbols = new Set(JSON.parse(require('fs').readFileSync(EXCLUDED_CACHE_FILE, 'utf8')));
    console.log(`Nạp ${stockSymbols.size} mã loại trừ từ cache`);
} catch (_) { /* chưa có cache */ }

async function loadStockSymbols(retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(
                'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products',
                { timeout: 15000 }
            );
            const excluded = res.data.data.filter(p =>
                Array.isArray(p.tags) && p.tags.some(t => EXCLUDED_TAGS.includes(t))
            );
            // Danh sách quá ít thì khả năng là phản hồi sai (vd: trang chặn) -> coi như lỗi
            if (excluded.length < 10) throw new Error(`chỉ có ${excluded.length} mã, dữ liệu bất thường`);
            stockSymbols = new Set(excluded.map(p => p.s));
            require('fs').writeFileSync(EXCLUDED_CACHE_FILE, JSON.stringify([...stockSymbols]));
            const counts = EXCLUDED_TAGS.map(t => `${t}: ${excluded.filter(p => p.tags.includes(t)).length}`);
            console.log(`Bỏ qua ${stockSymbols.size} mã (${counts.join(', ')})`);
            return true;
        } catch (error) {
            console.error(`Lỗi lấy danh sách loại trừ (lần ${attempt}/${retries}): ${error.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.error(`⚠️  Không lấy được danh sách mới, đang dùng ${stockSymbols.size} mã từ cache`);
    return false;
}

// Bỏ các cặp có khối lượng giao dịch 24h (tính bằng USDT) thấp hơn ngưỡng này (chỉnh qua env MIN_VOLUME_USDT)
const MIN_VOLUME_USDT = process.env.MIN_VOLUME_USDT !== undefined && process.env.MIN_VOLUME_USDT !== ''
    ? parseFloat(process.env.MIN_VOLUME_USDT)
    : 2000;

// Lấy danh sách tất cả các cặp spot từ Binance
async function getAllSpotSymbols() {
    try {
        const [info, ticker] = await Promise.all([
            axios.get('https://api.binance.com/api/v3/exchangeInfo'),
            axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 15000 }).catch(error => {
                console.error('Lỗi khi lấy volume 24h, tạm không lọc theo volume:', error.message);
                return null;
            })
        ]);
        const volumes = ticker ? new Map(ticker.data.map(t => [t.symbol, parseFloat(t.quoteVolume)])) : null;

        const symbols = info.data.symbols
            .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && !stockSymbols.has(s.symbol))
            .filter(s => !volumes || (volumes.get(s.symbol) || 0) >= MIN_VOLUME_USDT)
            .map(s => s.symbol.toLowerCase());
        
        console.log(`Tìm thấy ${symbols.length} cặp coin spot USDT (đã bỏ stock, fan token, volume 24h < ${MIN_VOLUME_USDT.toLocaleString()} USDT)`);
        return symbols;
    } catch (error) {
        console.error('Lỗi khi lấy danh sách symbols:', error.message);
        return [];
    }
}

// ================== 5 NẾN 1 PHÚT TĂNG LIÊN TIẾP ==================
// Nến tăng = close > open. Báo Telegram khi chuỗi nến xanh liên tiếp đạt M1_STREAK (mặc định 5).
// Chỉ báo 1 lần cho mỗi chuỗi; chuỗi bị ngắt (nến đỏ / đứng giá / mất nến) thì đếm lại từ đầu.
const M1_STREAK = parseInt(process.env.M1_STREAK) || 5;
const m1Streaks = new Map(); // symbol -> { count, lastOpenTime, startOpen }

function check5M1Streak(symbol, openTime, open, close) {
    let s = m1Streaks.get(symbol);
    // Nến không liền kề nến trước (vd: mất kết nối) -> reset chuỗi
    if (!s || openTime - s.lastOpenTime !== 60000) s = { count: 0, lastOpenTime: 0, startOpen: 0 };
    s.lastOpenTime = openTime;

    if (close > open) {
        if (s.count === 0) s.startOpen = open;
        s.count++;
    } else {
        s.count = 0;
    }
    m1Streaks.set(symbol, s);

    if (s.count === M1_STREAK) {
        const change = (close - s.startOpen) / s.startOpen * 100;
        console.log('=======================================================');
        console.log(`======= 🟢 ${M1_STREAK} NẾN 1M TĂNG: ${symbol.padEnd(14)} +${change.toFixed(2)}% | ${s.startOpen} -> ${close} | ${new Date().toLocaleTimeString()}`);
        console.log('=======================================================');
        queueAlert(`${symbol}_M1`, `🟢 ${M1_STREAK} nến 1M tăng liên tiếp: ${symbol} +${change.toFixed(2)}% | ${s.startOpen} -> ${close}`);
    }
}

// ================== VOLUME ĐỘT BIẾN, GIÁ CHƯA CHẠY ==================
// Báo khi nến 1m vừa đóng thỏa CẢ 4 điều kiện (dấu hiệu có người gom trước khi giá chạy):
//  1. Volume (USDT) >= VOL_SPIKE_X lần trung bình các nến 1m trước đó
//  2. Lệnh mua chủ động (taker buy) >= VOL_SPIKE_BUY_RATIO tổng volume nến
//  3. Nến tăng nhưng chưa quá VOL_SPIKE_MAX_PRICE % (giá chưa chạy)
//  4. Volume nến >= VOL_SPIKE_MIN_USDT (tránh mã thanh khoản mỏng bị nhiễu)
const VOL_SPIKE_X = parseFloat(process.env.VOL_SPIKE_X) || 5;
const VOL_SPIKE_BUY_RATIO = parseFloat(process.env.VOL_SPIKE_BUY_RATIO) || 0.6;
const VOL_SPIKE_MAX_PRICE = parseFloat(process.env.VOL_SPIKE_MAX_PRICE) || 1;
const VOL_SPIKE_MIN_USDT = parseFloat(process.env.VOL_SPIKE_MIN_USDT) || 20000;
const VOL_WINDOW = 30;      // số nến 1m dùng để tính volume trung bình
const VOL_MIN_HISTORY = 15; // cần ít nhất ngần này nến trước đó mới bắt đầu báo (sau khi khởi động)
const volHistory = new Map(); // symbol -> { lastOpenTime, vols: [] }

function checkVolumeSpike(symbol, kline) {
    const openTime = kline.t;
    const quoteVol = parseFloat(kline.q);
    const buyVol = parseFloat(kline.Q);
    const open = parseFloat(kline.o);
    const close = parseFloat(kline.c);

    let h = volHistory.get(symbol);
    // Nến không liền kề (vd: mất kết nối) -> bỏ lịch sử cũ
    if (!h || openTime - h.lastOpenTime !== 60000) h = { lastOpenTime: 0, vols: [] };

    // So sánh với các nến TRƯỚC đó (chưa tính nến hiện tại)
    if (h.vols.length >= VOL_MIN_HISTORY && open > 0) {
        const avg = h.vols.reduce((a, b) => a + b, 0) / h.vols.length;
        const ratio = avg > 0 ? quoteVol / avg : 0;
        const buyRatio = quoteVol > 0 ? buyVol / quoteVol : 0;
        const priceChange = (close - open) / open * 100;

        if (ratio >= VOL_SPIKE_X && buyRatio >= VOL_SPIKE_BUY_RATIO &&
            priceChange > 0 && priceChange <= VOL_SPIKE_MAX_PRICE &&
            quoteVol >= VOL_SPIKE_MIN_USDT) {
            console.log('=======================================================');
            console.log(`======= 📊 VOLUME ĐỘT BIẾN: ${symbol.padEnd(14)} x${ratio.toFixed(1)} | Mua chủ động ${(buyRatio * 100).toFixed(0)}% | Giá +${priceChange.toFixed(2)}% | Vol ${quoteVol.toFixed(0)} USDT | ${new Date().toLocaleTimeString()}`);
            console.log('=======================================================');
            queueAlert(`${symbol}_VOL`, `📊 Volume đột biến: ${symbol} x${ratio.toFixed(1)} so với TB ${h.vols.length} nến | mua chủ động ${(buyRatio * 100).toFixed(0)}% | giá +${priceChange.toFixed(2)}% | ${quoteVol.toFixed(0)} USDT`);
        }
    }

    h.vols.push(quoteVol);
    if (h.vols.length > VOL_WINDOW) h.vols.shift();
    h.lastOpenTime = openTime;
    volHistory.set(symbol, h);
}

// Kết nối WebSocket cho tất cả symbols
async function connectToAllMarkets() {
    const symbols = await getAllSpotSymbols();
    
    if (symbols.length === 0) {
        console.log('Không có symbol nào để theo dõi');
        return;
    }

    // Tạo stream cho tất cả symbols (kline 1 phút)
    const streams = symbols.map(symbol => `${symbol}@kline_1m`).join('/');
    // console.log(streams, 'streams');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    console.log('Đang kết nối WebSocket...');
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('✅ Kết nối WebSocket thành công!');
        console.log('Đang theo dõi giá tất cả cặp spot USDT...\n');
    });

    ws.on('message', (data) => {
        try {
            const item = JSON.parse(data);
            
            // Kiểm tra nếu có dữ liệu kline
            if (item.data && item.data.k) {
                const kline = item.data.k;
                const symbol = kline.s;
                const openPrice = parseFloat(kline.o);
                const closePrice = parseFloat(kline.c);
                const highPrice = parseFloat(kline.h);
                const lowPrice = parseFloat(kline.l);
                const volume = parseFloat(kline.v);
                const isClosed = kline.x; // Nến đã đóng chưa

                // Khi nến 1m đóng: đếm chuỗi nến xanh liên tiếp
                if (isClosed) {
                    check5M1Streak(symbol, kline.t, openPrice, closePrice);
                    checkVolumeSpike(symbol, kline);
                }
                
                let precent = 0;
                let type = '';
                let currentPrice = 0;

                if (openPrice > closePrice) {
                    precent = 100 - (closePrice / openPrice * 100);
                    type = '\x1b[31mSHORT\x1b[0m'; // Màu đỏ
                    currentPrice = kline.o;
                } else if (openPrice < closePrice) {
                    precent = 100 - (openPrice / closePrice * 100);
                    type = '\x1b[32mLONG\x1b[0m'; // Màu xanh
                    currentPrice = kline.o;
                }

                // Chỉ log khi nến đóng hoặc có biến động đáng kể
                if (precent > 0.35) {
                    const displaySymbol = symbol.replace('USDT', '');
                    const logMessage = `[${new Date().toLocaleTimeString()}] ${displaySymbol.padEnd(12)} | Type: ${type} | currentPrice: ${currentPrice}  | Change: ${precent.toFixed(2)}% | Volume: ${volume.toFixed(2)}`;
                    console.log(logMessage);

                    // Gửi dữ liệu đến web interface
                    const webData = {
                        time: new Date().toLocaleTimeString(),
                        symbol: displaySymbol,
                        type: type.replace(/\x1b\[\d+m/g, ''), // Remove color codes
                        currentPrice: currentPrice,
                        change: precent.toFixed(2),
                        volume: volume.toFixed(2)
                    };
                    broadcastToClients(webData);
                }
            }
        } catch (error) {
            console.error('Lỗi khi xử lý message:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
    });

    ws.on('close', () => {
        console.log('❌ WebSocket đã đóng. Đang kết nối lại sau 5 giây...');
        setTimeout(connectToAllMarkets, 5000);
    });
}

// ================== THÔNG BÁO TELEGRAM (Bot API) ==================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_COOLDOWN_MS = 60 * 1000; // mỗi mã chỉ báo tối đa 1 lần / 60s
const TG_FLUSH_MS = 3000;         // gom các alert lại, gửi 1 tin mỗi 3s để tránh bị rate limit
const TG_MAX_LEN = 4096;          // Telegram giới hạn 4096 ký tự / tin
const tgQueue = [];
const tgLastSent = new Map();
let tgPausedUntil = 0;            // khi bị 429, tạm dừng gửi tới thời điểm này

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️  Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID - sẽ không gửi Telegram');
}

function queueAlert(symbol, text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const now = Date.now();
    if (now - (tgLastSent.get(symbol) || 0) < TG_COOLDOWN_MS) return;
    tgLastSent.set(symbol, now);
    tgQueue.push(text);
}

setInterval(async () => {
    if (tgQueue.length === 0 || Date.now() < tgPausedUntil) return;
    // Lấy các alert vừa đủ 4096 ký tự, phần còn lại gửi lượt sau
    let text = '';
    while (tgQueue.length && (text.length + tgQueue[0].length + 1) <= TG_MAX_LEN) {
        text += (text ? '\n' : '') + tgQueue.shift();
    }
    if (!text) text = tgQueue.shift().slice(0, TG_MAX_LEN);
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true },
            { timeout: 10000 }
        );
    } catch (error) {
        const data = error.response?.data;
        // 429: Telegram yêu cầu chờ retry_after giây -> đưa tin lại đầu hàng đợi
        if (error.response?.status === 429) {
            const wait = (data?.parameters?.retry_after || 5) * 1000;
            tgPausedUntil = Date.now() + wait;
            tgQueue.unshift(text);
            console.error(`Telegram rate limit, chờ ${wait / 1000}s`);
        } else {
            console.error('Lỗi gửi Telegram:', data?.description || error.message);
        }
    }
}, TG_FLUSH_MS);

// ================== SCAN TĂNG BẤT THƯỜNG TRONG 1 GIÂY ==================
// Ngưỡng % tăng trong ~1s để coi là bất thường (có thể chỉnh qua env PUMP_THRESHOLD)
const PUMP_THRESHOLD = parseFloat(process.env.PUMP_THRESHOLD) || 0.5;
// Lưu giá gần nhất của từng symbol: { price, time }
const lastTicks = new Map();

// Stream !miniTicker@arr: Binance đẩy ticker của TẤT CẢ cặp spot mỗi 1 giây
function connectPumpScanner() {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
    let msgCount = 0;
    let lastMsgAt = Date.now();

    // Mỗi 60s log trạng thái; nếu 30s không nhận được dữ liệu thì tự kết nối lại
    const watchdog = setInterval(() => {
        if (Date.now() - lastMsgAt > 30000) {
            console.log('⚠️  Pump scanner 30s không nhận dữ liệu - kết nối lại...');
            ws.terminate();
        }
    }, 10000);
    const stats = setInterval(() => {
        console.log(`[${new Date().toLocaleTimeString()}] 💓 Pump scanner đang chạy: ${msgCount} gói / 60s, theo dõi ${lastTicks.size} mã`);
        msgCount = 0;
    }, 60000);

    ws.on('open', () => {
        console.log(`✅ Pump scanner đã kết nối - ngưỡng tăng ${PUMP_THRESHOLD}% / 1s (cặp USDT)\n`);
    });

    ws.on('message', (data) => {
        msgCount++;
        lastMsgAt = Date.now();
        try {
            const tickers = JSON.parse(data);
            if (!Array.isArray(tickers)) return;

            for (const t of tickers) {
                const symbol = t.s;
                if (!symbol.endsWith('USDT')) continue; // Chỉ lấy cặp USDT
                if (stockSymbols.has(symbol)) continue; // Bỏ qua stock token, fan token
                if (parseFloat(t.q) < MIN_VOLUME_USDT) continue; // Bỏ qua cặp volume 24h thấp (t.q = volume 24h tính bằng USDT)
                const price = parseFloat(t.c);
                const time = t.E; // event time (ms)
                if (!price) continue;

                const prev = lastTicks.get(symbol);
                lastTicks.set(symbol, { price, time });

                // Chỉ so sánh khi tick trước cách không quá ~1.5s (stream chỉ gửi symbol có thay đổi)
                if (!prev || time - prev.time > 1500) continue;

                const change = (price - prev.price) / prev.price * 100;
                if (change >= PUMP_THRESHOLD) {
                    console.log('=======================================================');
                    console.log(`======= 🚀 PUMP 1s: ${symbol.padEnd(14)} +${change.toFixed(2)}% | ${prev.price} -> ${price} | Vol 24h (quote): ${parseFloat(t.q).toFixed(2)} | ${new Date(time).toLocaleTimeString()}`);
                    console.log('=======================================================');
                    queueAlert(symbol, `🚀 PUMP 1s: ${symbol} +${change.toFixed(2)}% | ${prev.price} -> ${price} | ${new Date(time).toLocaleTimeString()}`);
                }
            }
        } catch (error) {
            console.error('Lỗi pump scanner:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('Pump scanner error:', error.message);
    });

    ws.on('close', () => {
        console.log('❌ Pump scanner đã đóng. Kết nối lại sau 5 giây...');
        clearInterval(watchdog);
        clearInterval(stats);
        lastTicks.clear();
        setTimeout(connectPumpScanner, 5000);
    });
}

// ================== SCAN 3 NẾN 1H TĂNG ==================
// Điều kiện: MỖI nến trong 3 nến 1h đã đóng gần nhất đều tăng >= H1_THRESHOLD %
// (tính theo (close - open) / open của từng nến)
const H1_THRESHOLD = parseFloat(process.env.H1_THRESHOLD) || 1.5;
const H1_CONCURRENCY = 10;     // số request song song tới Binance (tránh vượt rate limit)
const h1Alerted = new Map();   // symbol -> closeTime của nến cuối đã báo (không báo trùng)

async function checkSymbol3H1(symbol) {
    const res = await axios.get('https://api.binance.com/api/v3/klines', {
        params: { symbol, interval: '1h', limit: 4 },
        timeout: 10000
    });
    // Bỏ nến đang chạy, chỉ lấy 3 nến đã đóng
    const closed = res.data.filter(k => k[6] < Date.now()).slice(-3);
    if (closed.length < 3) return null;

    // % tăng của từng nến
    const changes = closed.map(k => (parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1]) * 100);
    if (!changes.every(c => c >= H1_THRESHOLD)) return null;

    const open = parseFloat(closed[0][1]);
    const close = parseFloat(closed[2][4]);
    const change = (close - open) / open * 100; // tổng tăng của 3 nến

    const lastCloseTime = closed[2][6];
    if (h1Alerted.get(symbol) === lastCloseTime) return null;
    h1Alerted.set(symbol, lastCloseTime);

    const candles = changes.map(c => `+${c.toFixed(2)}%`).join(' / ');
    return { symbol, change, open, close, candles };
}

async function scan3H1() {
    const symbols = (await getAllSpotSymbols()).map(s => s.toUpperCase());
    const hits = [];
    let idx = 0;

    const worker = async () => {
        while (idx < symbols.length) {
            const symbol = symbols[idx++];
            try {
                const hit = await checkSymbol3H1(symbol);
                if (hit) hits.push(hit);
            } catch (error) {
                // bỏ qua lỗi lẻ của từng mã
            }
        }
    };
    await Promise.all(Array.from({ length: H1_CONCURRENCY }, worker));

    hits.sort((a, b) => b.change - a.change);
    for (const h of hits) {
        console.log('=======================================================');
        console.log(`======= 📈 3 NẾN 1H: ${h.symbol.padEnd(14)} +${h.change.toFixed(2)}% | ${h.open} -> ${h.close} | Từng nến: ${h.candles}`);
        console.log('=======================================================');
        queueAlert(`${h.symbol}_3H1`, `📈 3 nến 1H tăng: ${h.symbol} +${h.change.toFixed(2)}% | ${h.open} -> ${h.close} | ${h.candles}`);
    }
    console.log(`[${new Date().toLocaleTimeString()}] Quét 3 nến 1H xong: ${hits.length}/${symbols.length} mã thỏa điều kiện (mỗi nến >= ${H1_THRESHOLD}%)`);
}

// Quét ngay khi khởi động, sau đó quét mỗi giờ (10s sau khi nến 1h đóng)
function start3H1Scanner() {
    const run = () => scan3H1().catch(e => console.error('Lỗi quét 3 nến 1H:', e.message));
    run();
    const msToNextHour = 3600000 - (Date.now() % 3600000) + 10000;
    setTimeout(() => {
        run();
        setInterval(run, 3600000);
    }, msToNextHour);
}

// Khởi động server
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 Binance Spot Monitor - Khởi động...`);
    console.log(`📊 Web interface: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket server running on port ${PORT}\n`);
    // Phải có danh sách stock trước khi các scanner chạy
    await loadStockSymbols();
    setInterval(loadStockSymbols, 6 * 3600000); // làm mới 6h/lần để bắt mã mới niêm yết
    connectToAllMarkets();
    connectPumpScanner();
    start3H1Scanner();
});
