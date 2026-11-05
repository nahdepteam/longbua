// =========================================================================
// 1. ĐỌC TOKEN, CHAT ID & TỰ ĐỘNG PHÂN LỊCH CHẠY THEO GIỜ
// =========================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const currentUTCHour = new Date().getUTCHours();
const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

// Xác định các mốc giờ quy định (03:30, 07:30, 11:30, 15:30, 19:30, 23:30 giờ VN)
const isScheduledMilestoneHour = (currentUTCHour % 4 === 0) || isManualRun;

// 1H, 2H & 4H: Chạy mỗi giờ
const TIMEFRAMES = [
    { label: '1H', mexcTf: '60m', binanceTf: '1h' },
    { label: '2H', mexcTf: '120m', binanceTf: '2h' },
    { label: '4H', mexcTf: '4h', binanceTf: '4h' }
];

// 1D: Chạy vào các mốc giờ quy định (03:30, 07:30, 11:30, 15:30, 19:30, 23:30 Giờ VN)
if (isScheduledMilestoneHour) {
    TIMEFRAMES.push({ label: '1D', mexcTf: '1d', binanceTf: '1d' });
}

// 1W: Chạy mỗi ngày 1 lần vào lúc 07:30 Giờ VN (Tức là 00:30 UTC)
if (currentUTCHour === 0 || isManualRun) {
    TIMEFRAMES.push({ label: '1W', mexcTf: '1W', binanceTf: '1w' });
}

// =========================================================================
// 2. HÀM GỬI TIN NHẮN VỀ TELEGRAM
// =========================================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
    } catch (e) {
        console.error('Lỗi gửi tin nhắn Telegram:', e);
    }
}

// =========================================================================
// 3. THUẬT TOÁN TÍNH EMA & MACD LINE
// =========================================================================
function calcEMA(data, period) {
    let k = 2 / (period + 1);
    let ema = new Array(data.length);
    ema[0] = data[0];
    for (let i = 1; i < data.length; i++) { 
        ema[i] = data[i] * k + ema[i - 1] * (1 - k); 
    }
    return ema;
}

function computeMACD(closes) {
    let ema12 = calcEMA(closes, 12);
    let ema26 = calcEMA(closes, 26);
    let macdLine = new Array(closes.length);
    for (let i = 0; i < closes.length; i++) {
        macdLine[i] = ema12[i] - ema26[i];
    }
    let signalLine = calcEMA(macdLine, 9);
    return { macdLine, signalLine };
}

// =========================================================================
// 4. KIỂM TRA MÔ HÌNH BÁO ĐÁY CHUẨN MACD SUPER
// =========================================================================
function checkStrictDivergence(rawList) {
    if (!rawList || rawList.length < 150) return { found: false };

    let closes = rawList.map(item => parseFloat(item[4]));
    let lows = rawList.map(item => parseFloat(item[3]));

    let { macdLine, signalLine } = computeMACD(closes);
    let n = closes.length;

    const maxBars = 150;
    const minBarsBetween = 8;
    const minSpreadPct = 13.0;
    const hsMaxDiffPct = 30.0;
    const WARMUP_BARS = 50;

    let lastCrossAboveZeroBar = null;
    let currentTroughVal = null, currentTroughBar = null, currentTroughPrice = null;
    let maxSpreadTrough = 0.0;
    let inTrough = false;

    let b1_val = null, b1_bar = null, b1_price = null;
    let b2_val = null, b2_bar = null, b2_price = null;
    let b3_val = null, b3_bar = null, b3_price = null;

    let lastSignalAgo = -1;

    for (let bar = 0; bar < n; bar++) {
        let macd = macdLine[bar];
        let signal = signalLine[bar];
        let low = lows[bar];

        if (macd > 0) lastCrossAboveZeroBar = bar;
        if (bar < 1) continue;

        let prevMacd = macdLine[bar - 1];
        let prevSignal = signalLine[bar - 1];

        let crossUnderSig = (prevMacd >= prevSignal) && (macd < signal);
        let crossOverSig  = (prevMacd <= prevSignal) && (macd > signal);

        if (crossUnderSig) {
            inTrough = true;
            currentTroughVal = macd;
            currentTroughBar = bar;
            currentTroughPrice = low;
            maxSpreadTrough = 0.0;
        }

        if (macd < signal && inTrough) {
            if (currentTroughVal === null || macd < currentTroughVal) {
                currentTroughVal = macd;
                currentTroughBar = bar;
            }
            if (currentTroughPrice === null || low < currentTroughPrice) {
                currentTroughPrice = low;
            }
            let spread = macd !== 0 ? (Math.abs(macd - signal) / Math.abs(macd)) * 100 : 0;
            if (spread > maxSpreadTrough) maxSpreadTrough = spread;
        }

        if (crossOverSig) {
            if (inTrough && maxSpreadTrough >= minSpreadPct && bar >= WARMUP_BARS) {
                b3_val = b2_val; b3_bar = b2_bar; b3_price = b2_price;
                b2_val = b1_val; b2_bar = b1_bar; b2_price = b1_price;
                b1_val = currentTroughVal; b1_bar = currentTroughBar; b1_price = currentTroughPrice;

                if (b3_val !== null) {
                    let cond_maxDist = (bar - b3_bar) <= maxBars;
                    let cond_minDist = (b1_bar - b2_bar >= minBarsBetween) && (b2_bar - b3_bar >= minBarsBetween);
                    let cond_belowZero = (b1_val < 0 && b2_val < 0 && b3_val < 0);
                    let cond_noCrossZ = (lastCrossAboveZeroBar === null || lastCrossAboveZeroBar < b3_bar);

                    let hs_diff_bot = b3_val !== 0 ? (Math.abs(b1_val - b3_val) / Math.abs(b3_val)) * 100 : 999.0;
                    let cond_hs_shoulders_bot = hs_diff_bot <= hsMaxDiffPct;

                    let macd_Standard = (b1_val > b2_val && b2_val > b3_val);
                    let macd_HS = (b2_val < b3_val && b2_val < b1_val) && cond_hs_shoulders_bot;
                    let cond_macdDivBot = (macd_Standard || macd_HS);
                    let cond_priceDivBot = (b1_price <= b2_price && b2_price <= b3_price);

                    if (cond_maxDist && cond_minDist && cond_belowZero && cond_macdDivBot && cond_priceDivBot && cond_noCrossZ) {
                        lastSignalAgo = (n - 1) - bar;
                        b3_val = null;
                    }
                }
            }
            inTrough = false;
        }
    }

    // NHẬN CẢ NẾN LIVE (0) VÀ NẾN VỪA ĐÓNG (1)
    if (lastSignalAgo >= 0 && lastSignalAgo <= 1) {
        return { found: true, candlesAgo: lastSignalAgo };
    }
    return { found: false };
}

// =========================================================================
// 5. LỌC FULL DANH SÁCH COIN FUTURES (TOP 750 CẶP MEXC)
// =========================================================================
async function getTopFuturesSymbols() {
    let symbols = [];
    let tickerMap = {};
    
    try {
        let res = await fetch('https://contract.mexc.com/api/v1/contract/ticker');
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        
        let json = await res.json();

        if (json.success && json.data && Array.isArray(json.data)) {
            let futuresList = json.data
                .filter(item => item.symbol && item.symbol.endsWith('_USDT'))
                .sort((a, b) => parseFloat(b.amount24 || b.volume24 || 0) - parseFloat(a.amount24 || a.volume24 || 0))
                .slice(0, 750); // LẤY TOP 750 CẶP THANH KHOẢN CAO NHẤT

            futuresList.forEach(item => {
                let cleanSym = item.symbol.replace('_', '');
                symbols.push(cleanSym);

                let changePct = parseFloat(item.riseFallRate || 0) * 100;
                tickerMap[cleanSym] = {
                    price: parseFloat(item.lastPrice || 0),
                    change: isNaN(changePct) ? 0 : changePct
                };
            });
        }
    } catch(e) {
        console.error('Lỗi khi lấy danh sách Futures MEXC:', e);
    }
    
    return { symbols, tickerMap };
}

async function getKlines(symbol, timeItem) {
    try {
        let res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${timeItem.binanceTf}&limit=1000`);
        if (res.ok) {
            let data = await res.json();
            if (Array.isArray(data) && data.length > 100) return data;
        }
    } catch(e) {}

    try {
        let res = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${timeItem.mexcTf}&limit=1000`);
        if (res.ok) {
            let data = await res.json();
            if (Array.isArray(data) && data.length > 100) return data;
        }
    } catch(e) {}

    return null;
}

// =========================================================================
// 6. QUY TRÌNH CHẠY QUÉT
// =========================================================================
async function runScanner() {
    console.log(`[${new Date().toLocaleString('vi-VN')}] Bắt đầu quy trình quét thị trường MEXC Futures...`);
    
    let { symbols, tickerMap } = await getTopFuturesSymbols();
    
    // BÁO LỖI KẾT NỐI API NẾU KHÔNG LẤY ĐƯỢC DANH SÁCH COIN
    if (!symbols || symbols.length === 0) {
        console.error('Lỗi: Không lấy được danh sách coin từ API MEXC.');
        await sendTelegramMessage(`⚠️ <b>CẢNH BÁO LỖI KẾT NỐI API</b>\n\nKhông thể tải danh sách hợp đồng Futures từ sàn MEXC. Quy trình quét tạm thời không thể thực hiện.`);
        return;
    }

    console.log(`Đã nạp thành công TOP ${symbols.length} cặp MEXC Futures.`);

    for (let timeItem of TIMEFRAMES) {
        console.log(`\n--- Đang quét Khung ${timeItem.label} ---`);
        let matchedList = [];

        for (let symbol of symbols) {
            let klines = await getKlines(symbol, timeItem);
            if (klines) {
                let result = checkStrictDivergence(klines);
                if (result.found) {
                    matchedList.push({
                        symbol: symbol,
                        price: tickerMap[symbol]?.price || 0,
                        change: tickerMap[symbol]?.change || 0,
                        candlesAgo: result.candlesAgo
                    });
                }
            }
            await new Promise(r => setTimeout(r, 15)); 
        }

        if (matchedList.length > 0) {
            console.log(`=> Khung ${timeItem.label}: Tìm thấy ${matchedList.length} cặp. Đang gửi Telegram...`);

            let msg = `🚀 <b>TÍN HIỆU [Khung ${timeItem.label}]</b>\n\n`;
            matchedList.forEach(item => {
                let cleanSymbol = item.symbol.replace('USDT', ''); 
                
                let tvMexc = `https://www.tradingview.com/chart/?symbol=MEXC:${cleanSymbol}USDT.P`;
                let tvBinance = `https://www.tradingview.com/chart/?symbol=BINANCE:${cleanSymbol}USDT.P`;
                let tvBybit = `https://www.tradingview.com/chart/?symbol=BYBIT:${cleanSymbol}USDT.P`;
                
                let agoStr = item.candlesAgo === 0 ? '⚡ Đúng nến hiện tại (Live)' : 'Cách 1 nến (Vừa đóng)';
                
                msg += `📌 <b>${item.symbol}</b>\n`;
                msg += `• Giá: <code>$${item.price}</code> (${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%)\n`;
                msg += `• Trạng thái: ${agoStr}\n`;
                msg += `• Chart Futures: <a href="${tvMexc}">MEXC</a> | <a href="${tvBinance}">Binance</a> | <a href="${tvBybit}">Bybit</a>\n\n`;
            });

            await sendTelegramMessage(msg);
        } else {
            console.log(`=> Khung ${timeItem.label}: Không có cặp nào thỏa mãn.`);
            
            // LUÔN BÁO CHO KHUNG 1W, HOẶC BÁO CHO 4H/1D VÀO CÁC MỐC GIỜ QUY ĐỊNH
            if (timeItem.label === '1W' || (isScheduledMilestoneHour && (timeItem.label === '4H' || timeItem.label === '1D'))) {
                let emptyMsg = `ℹ️ <b>TÍN HIỆU [Khung ${timeItem.label}]</b>\n\nKhông có cặp thoả mãn`;
                await sendTelegramMessage(emptyMsg);
            }
        }
    }
}

runScanner();
