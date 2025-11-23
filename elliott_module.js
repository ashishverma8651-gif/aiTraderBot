// ==========================================================
// elliott_module.js - Import FIXED
// Removed unused import causing error.
// Version: v3.1_TF_FIX_2
// ==========================================================
// Removed: import { calculateIndicators } from './indicator_module.js';

const VERSION = "v3.1_TF_FIX_2";

// Helper function to find extremes (peaks and troughs)
function findExtremes(data, lookback = 5) {
    const extremes = [];
    
    for (let i = lookback; i < data.length - lookback; i++) {
        const currentClose = data[i].close;
        let isPeak = true;
        let isTrough = true;
        
        // Check for Peak
        for (let j = 1; j <= lookback; j++) {
            if (data[i - j].close > currentClose || data[i + j].close > currentClose) {
                isPeak = false;
                break;
            }
        }
        
        // Check for Trough
        if (!isPeak) {
            for (let j = 1; j <= lookback; j++) {
                if (data[i - j].close < currentClose || data[i + j].close < currentClose) {
                    isTrough = false;
                    break;
                }
            }
        }

        if (isPeak) {
            extremes.push({ index: i, type: 'peak', close: currentClose, t: data[i].t });
        } else if (isTrough) {
            extremes.push({ index: i, type: 'trough', close: currentClose, t: data[i].t });
        }
    }
    return extremes;
}


// A simplified function to detect basic harmonic/Elliott patterns
function detectSimplePatterns(data, extremes) {
    const patterns = [];

    const last = data.at(-1);
    if (!last) return patterns;

    const recentExtremes = extremes.slice(-10); // Look at last 10 points

    // --- 1. Double Top/Bottom ---
    if (recentExtremes.length >= 4) {
        const [a, b, c, d] = recentExtremes.slice(-4);
        
        // Double Bottom (Trough, Peak, Trough, Current Close)
        if (a.type === 'trough' && c.type === 'trough' && a.close * 1.002 >= c.close && a.close * 0.998 <= c.close && last.close > c.close) {
            patterns.push({
                type: "DoubleBottom",
                side: "Bullish",
                confidence: 100, // High confidence if rules met
            });
        }
        
        // Double Top (Peak, Trough, Peak, Current Close)
        if (a.type === 'peak' && c.type === 'peak' && a.close * 1.002 >= c.close && a.close * 0.998 <= c.close && last.close < c.close) {
            patterns.push({
                type: "DoubleTop",
                side: "Bearish",
                confidence: 95,
            });
        }
    }
    
    // --- 2. Inverse Head and Shoulders (Bullish Reversal) ---
    if (recentExtremes.length >= 7) {
        // [LS, H, RS] -> Trough, Peak, Trough(Head), Peak, Trough(RS)
        const e = recentExtremes.slice(-7);
        const [a, b, c, d, f] = [e[0], e[1], e[2], e[3], e[4]]; 

        // Simplified check: Trough-Peak-DeepTrough-Peak-Trough (A-B-C-D-E)
        if (a.type === 'trough' && c.type === 'trough' && f.type === 'trough' && 
            b.type === 'peak' && d.type === 'peak') {
            
            const head = c.close;
            const leftShoulder = a.close;
            const rightShoulder = f.close;
            
            // Head is lowest point, shoulders are roughly equal and higher than head.
            if (head < leftShoulder && head < rightShoulder && 
                rightShoulder * 1.01 >= leftShoulder && rightShoulder * 0.99 <= leftShoulder &&
                last.close > d.close) // Price breaks neckline (D)
            {
                patterns.push({
                    type: "InverseHeadAndShoulders",
                    side: "Bullish",
                    confidence: 70, 
                });
            }
        }
    }

    // --- 3. Simple Order Block Detection (Not a wave, but a structure) ---
    // Look for a large, strong candle (e.g., body > ATR) followed by a range.
    // NOTE: ATR computation would require importing indicator_module, which we avoid here.
    // This part is simplified to rely only on price action patterns.
    
    return patterns;
}

/**
 * Runs Elliott Wave-style analysis on the provided candle data.
 * @param {Array} candles Array of candle objects {t, open, high, low, close, vol}
 * @returns {object} Analysis result
 */
export async function analyzeElliott(candles, options = { lookback: 5 }) {
    if (!Array.isArray(candles) || candles.length < 50) {
        console.warn(`[${VERSION}] analyzeElliott: Not enough data (found ${candles?.length})`);
        return { patterns: [], confidence: 0, sentiment: 0 };
    }

    // 🛑 DEBUG CHECK: Logs the amount of data received from merge_signals
    console.debug(`[${VERSION}] analyzeElliott received data length: ${candles.length}`);
    
    // 1. Find Extremes (Peaks and Troughs)
    const extremes = findExtremes(candles, options.lookback);

    // 2. Detect Patterns
    const patterns = detectSimplePatterns(candles, extremes);

    // 3. Calculate Simple Sentiment Score (based on last 10 candles vs average close)
    const recentCloses = candles.slice(-10).map(c => c.close);
    const avgClose = candles.slice(0, -10).map(c => c.close).reduce((a, b) => a + b, 0) / (candles.length - 10);
    const lastAvgClose = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    
    // Score based on recent price movement relative to historical average
    let sentimentScore = (lastAvgClose - avgClose) / avgClose * 100;
    
    // Max sentiment at 10, Min at -10 for stability
    sentimentScore = Math.min(10, Math.max(-10, sentimentScore));

    // Calculate Confidence based on highest pattern confidence
    const maxConf = patterns.length ? patterns.reduce((max, p) => Math.max(max, p.confidence), 0) : 50;

    return {
        patterns: patterns,
        confidence: maxConf, // highest pattern confidence
        sentiment: sentimentScore / 10, // Normalized score between -1 and 1
        debug: {
            extremesCount: extremes.length,
            dataLength: candles.length
        }
    };
}

