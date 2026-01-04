import { createClient } from 'redis';
import { NextResponse } from 'next/server';

// Redis client singleton
let redisClient = null;
let isConnecting = false;

async function getRedis() {
    if (redisClient?.isOpen) return redisClient;
    if (isConnecting) {
        await new Promise(r => setTimeout(r, 100));
        return redisClient;
    }
    
    const host = process.env.REDIS_HOST;
    const password = process.env.REDIS_PASSWORD;
    const port = process.env.REDIS_PORT || '6379';
    
    if (!host || !password) {
        console.log('Redis not configured');
        return null;
    }
    
    try {
        isConnecting = true;
        redisClient = createClient({
            password,
            socket: { host, port: parseInt(port) }
        });
        redisClient.on('error', (err) => console.log('Redis:', err.message));
        await redisClient.connect();
        isConnecting = false;
        return redisClient;
    } catch (error) {
        isConnecting = false;
        console.error('Redis connect failed:', error.message);
        return null;
    }
}

// Get crypto price
async function getPrice(symbol) {
    const coins = {
        'BTC': 'bitcoin', 'LTC': 'litecoin', 'ETH': 'ethereum',
        'BNB': 'binancecoin', 'BSC': 'binancecoin', 'SOL': 'solana',
        'USDT': 'tether', 'USDC': 'usd-coin'
    };
    
    const id = coins[symbol?.toUpperCase()];
    if (!id) return null;
    if (['USDT', 'USDC'].includes(symbol?.toUpperCase())) return 1;
    
    try {
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
        const data = await res.json();
        return data[id]?.usd || null;
    } catch {
        return null;
    }
}

// Send Telegram message
async function sendTelegram(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !chatId) return null;
    
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
    } catch (err) {
        console.error('Telegram error:', err.message);
    }
}

// Health check
export async function GET() {
    return NextResponse.json({
        status: 'ok',
        service: 'deposit-webhook',
        time: new Date().toISOString()
    });
}

// Tatum webhook handler
export async function POST(request) {
    // Respond immediately (Tatum retries on slow response)
    const responsePromise = processWebhook(request);
    
    // Return 200 immediately
    return NextResponse.json({ received: true });
}

async function processWebhook(request) {
    try {
        const payload = await request.json();
        console.log('📥 Webhook:', JSON.stringify(payload));
        
        const { txId, address, amount, chain, type, tokenSymbol, blockNumber } = payload;
        
        // Only incoming transactions
        if (type !== 'incoming') {
            console.log('Skip: not incoming');
            return;
        }
        
        const redis = await getRedis();
        if (!redis) {
            console.error('No Redis connection');
            return;
        }
        
        // DUPLICATE CHECK - Critical!
        const txKey = `ghetto:processed_tx:${txId}`;
        const exists = await redis.exists(txKey);
        if (exists) {
            console.log(`Skip: TX ${txId} already processed`);
            return;
        }
        
        // Lock this TX immediately to prevent race conditions
        const locked = await redis.set(`ghetto:tx_lock:${txId}`, '1', { NX: true, EX: 60 });
        if (!locked) {
            console.log(`Skip: TX ${txId} being processed by another request`);
            return;
        }
        
        // Get user from address
        const userId = await redis.get(`ghetto:tatum:address:${address.toLowerCase()}`);
        if (!userId) {
            console.log(`Skip: No user for address ${address}`);
            await redis.del(`ghetto:tx_lock:${txId}`);
            return;
        }
        
        // Determine symbol
        let symbol = tokenSymbol || chain;
        const chainMap = { 'ETH': 'ETH', 'BSC': 'BNB', 'BTC': 'BTC', 'LTC': 'LTC', 'SOL': 'SOL' };
        if (!tokenSymbol) symbol = chainMap[chain] || chain;
        
        // Parse amount
        const depositAmount = parseFloat(amount) || 0;
        if (depositAmount <= 0) {
            console.log('Skip: zero amount');
            await redis.del(`ghetto:tx_lock:${txId}`);
            return;
        }
        
        // Get USD value
        const price = await getPrice(symbol);
        const usdAmount = price ? (depositAmount * price).toFixed(2) : '0.00';
        
        // Check minimum deposit
        const minSetting = await redis.hGet('ghetto:deposit_withdraw_settings', 'min_deposit_usd');
        const minUSD = parseFloat(minSetting || '5');
        
        if (parseFloat(usdAmount) < minUSD) {
            console.log(`Skip: $${usdAmount} below min $${minUSD}`);
            await redis.hSet(txKey, {
                userId, amount: depositAmount.toString(), symbol, usdAmount,
                status: 'below_minimum', processedAt: new Date().toISOString()
            });
            await redis.del(`ghetto:tx_lock:${txId}`);
            return;
        }
        
        // Get user data
        const userKey = `ghetto:users:${userId}`;
        const userData = await redis.hGetAll(userKey);
        const firstName = userData?.first_name || 'User';
        const currentBalance = parseFloat(userData?.balance || '0');
        const newBalance = (currentBalance + parseFloat(usdAmount)).toFixed(2);
        
        // Update balance
        await redis.hSet(userKey, 'balance', newBalance);
        
        // Mark TX as processed
        await redis.hSet(txKey, {
            userId,
            amount: depositAmount.toString(),
            symbol,
            usdAmount,
            newBalance,
            chain,
            blockNumber: blockNumber?.toString() || '',
            processedAt: new Date().toISOString()
        });
        
        // Remove lock
        await redis.del(`ghetto:tx_lock:${txId}`);
        
        // Notify user
        const userMsg = `💰 *Deposit Confirmed!*\n\n` +
            `💵 Amount: \`${depositAmount} ${symbol}\`\n` +
            `💲 Value: \`$${usdAmount} USD\`\n` +
            `🔗 Network: \`${chain}\`\n` +
            `📦 Block: \`${blockNumber || 'Confirmed'}\`\n\n` +
            `💳 New Balance: \`$${newBalance}\`\n\n` +
            `🏷️ TX: \`${txId}\``;
        
        await sendTelegram(userId, userMsg);
        
        // Notify admin
        const adminChatId = process.env.DEPOSIT_CHATID;
        if (adminChatId) {
            const adminMsg = `💰 *New Deposit*\n\n` +
                `👤 User: ${firstName} (\`${userId}\`)\n` +
                `💵 Amount: \`${depositAmount} ${symbol}\`\n` +
                `💲 Value: \`$${usdAmount} USD\`\n` +
                `🔗 Network: \`${chain}\`\n` +
                `📦 Block: \`${blockNumber || 'Confirmed'}\`\n` +
                `💳 New Balance: \`$${newBalance}\`\n\n` +
                `🏷️ TX: \`${txId}\``;
            
            await sendTelegram(adminChatId, adminMsg);
        }
        
        console.log(`✅ Deposit: ${depositAmount} ${symbol} ($${usdAmount}) → User ${userId}`);
        
    } catch (error) {
        console.error('Webhook error:', error);
    }
}
