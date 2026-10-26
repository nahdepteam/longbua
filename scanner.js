// =========================================================================
// 1. ĐỌC TOKEN, CHAT ID & TỰ ĐỘNG PHÂN LỊCH CHẠY THEO GIỜ
// =========================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const currentUTCHour = new Date().getUTCHours();
const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

const TIMEFRAMES = [
    { tf: '60', label: '1H' },
    { tf: '240', label: '4H' }
];

if (currentUTCHour % 8 === 0 || isManualRun) {
    TIMEFRAMES.push({ tf: 'D', label: '1D' });
}

const MAX_AGO = 10; 
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

// =========================================================================
// 2. HÀM FETCH BẢO VỆ VƯỢT RÀO CẢN IP (BYPASS GEO-BLOCK)
// =========================================================================
async function fetchBybit(pathAndQuery) {
    const targetUrl = `https://api.bybit.com${pathAndQuery}`;
    
    // Thử qua Proxy 1: corsproxy.io
    try {
        const proxyUrl1 = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl1, { headers: HEADERS });
        if (res.ok) {
            const data = await res.json();
            if (data && data.retCode === 0) return data;
        }
    } catch (e) {}

    // Dự phòng Proxy 2: allorigins.win
    try {
        const proxyUrl2 = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl2, { headers: HEADERS });
        if (res.ok) {
            const data = await res.json();
            if (data && data.retCode === 0) return data;
        }
    } catch (e) {}

    return null;
}

// =========================================================================
// 3. HÀM GỬI TIN NHẮN VỀ TELEGRAM
// =========================================================================
async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('Lỗi: Chưa cấu hình TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID!');
        return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });
        const resData = await response.json();
        if (!resData.ok) {
            console.error('Lỗi API Telegram:', resData.description);
        }
    } catch (e) {
        console.error('Lỗi kết nối khi gửi Telegram:', e.message);
    }
}

// =========================================================================
// 4. THUẬT TOÁN TÍNH EMA & MACD LINE
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
// 5. KIỂM TRA MÔ HÌNH BÁO ĐÁY CHUẨN MACD SUPER
// =========================================================================
function checkStrictDivergence(rawList) {
    if (!rawList || rawList.length < 150) return { found: false };

    let closes = rawList.map(item => parseFloat(item[4])).reverse();
    let lows = rawList.map(item => parseFloat(item[3])).reverse();

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

    if (lastSignalAgo >= 0 && lastSignalAgo <= MAX_AGO) {
        return { found: true, candlesAgo: lastSignalAgo };
    }
    return { found: false };
}

// =========================================================================
// 6. QUY TRÌNH CHẠY QUÉT MULTI-TIMEFRAME
// =========================================================================
async function runScanner() {
    console.log(`[${new Date().toLocaleString('vi-VN')}] Bắt đầu quy trình quét thị trường Bybit...`);
    console.log(`Các khung quét đợt này: ${TIMEFRAMES.map(t => t.label).join(', ')}`);
    
    try {
        let data = await fetchBybit('/v5/market/instruments-info?category=linear');
        if (!data || !data.result || !data.result.list) {
            console.error('Không thể truy cập danh sách hợp đồng qua Proxy!');
            return;
        }

        let symbols = data.result.list
            .filter(item => item.quoteCoin === 'USDT' && item.status === 'Trading')
            .map(item => item.symbol);

        console.log(`Đã nạp thành công ${symbols.length} cặp hợp đồng USDT.`);

        for (let timeItem of TIMEFRAMES) {
            console.log(`\n--- Đang quét Khung ${timeItem.label} ---`);
            let matchedList = [];

            for (let i = 0; i < symbols.length; i++) {
                let symbol = symbols[i];
                try {
                    let [tickerRes, klineRes] = await Promise.all([
                        fetchBybit(`/v5/market/tickers?category=linear&symbol=${symbol}`),
                        fetchBybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${timeItem.tf}&limit=1000`)
                    ]);

                    let price = parseFloat(tickerRes?.result?.list[0]?.lastPrice || 0);
                    let change = parseFloat(tickerRes?.result?.list[0]?.price24hPcnt || 0) * 100;

                    if (klineRes && klineRes.result && klineRes.result.list) {
                        let result = checkStrictDivergence(klineRes.result.list);
                        if (result.found) {
                            matchedList.push({
                                symbol: symbol,
                                price: price,
                                change: change,
                                candlesAgo: result.candlesAgo
                            });
                        }
                    }
                } catch (err) {}

                await new Promise(r => setTimeout(r, 15));
            }

            if (matchedList.length > 0) {
                console.log(`=> Khung ${timeItem.label}: Tìm thấy ${matchedList.length} cặp. Đang gửi Telegram...`);
                
                let msg = `🚀 <b>CẢNH BÁO MACD SUPER 3 ĐÁY [Khung ${timeItem.label}]</b>\n\n`;
                matchedList.forEach(item => {
                    let tvBybit = `https://www.tradingview.com/chart/?symbol=BYBIT:${item.symbol}.P`;
                    let tvMexc = `https://www.tradingview.com/chart/?symbol=MEXC:${item.symbol}.P`;
                    let agoStr = item.candlesAgo === 0 ? '⚡ Đúng nến hiện tại (Live)' : `Cách ${item.candlesAgo} nến`;
                    
                    msg += `📌 <b>${item.symbol}.P</b>\n`;
                    msg += `• Giá: <code>$${item.price}</code> (${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%)\n`;
                    msg += `• Trạng thái: ${agoStr}\n`;
                    msg += `• Xem Chart: <a href="${tvBybit}">Bybit</a> | <a href="${tvMexc}">MEXC</a>\n\n`;
                });

                await sendTelegramMessage(msg);
            } else {
                console.log(`=> Khung ${timeItem.label}: Không có cặp nào thỏa mãn.`);
            }
        }

    } catch (error) {
        console.error('Lỗi trong quá trình quét:', error);
    }
}

runScanner();
