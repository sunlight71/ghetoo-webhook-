import { createClient } from 'redis';
import { NextResponse } from 'next/server';

// Create fresh Redis connection for each request (Vercel serverless)
async function getRedis() {
    const host = process.env.REDIS_HOST;
    const password = process.env.REDIS_PASSWORD;
    const port = process.env.REDIS_PORT || '6379';
    
    console.log(`Redis config: host=${host ? 'SET' : 'MISSING'}, port=${port}, password=${password ? 'SET' : 'MISSING'}`);
    
    if (!host || !password) {
        console.error('❌ Redis env vars not configured!');
        return null;
    }
    
    try {
        const client = createClient({
            password,
            socket: { 
                host, 
                port: parseInt(port),
                connectTimeout: 10000
            }
        });
        
        client.on('error', (err) => console.error('Redis error:', err.message));
        await client.connect();
        console.log('✅ Redis connected');
        return client;
    } catch (error) {
        console.error('❌ Redis connect failed:', error.message);
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

// Health check - also tests Redis connection
export async function GET() {
    let redisStatus = 'not tested';
    try {
        const redis = await getRedis();
        if (redis) {
            redisStatus = 'connected';
            await redis.disconnect();
        } else {
            redisStatus = 'failed - check env vars';
        }
    } catch (e) {
        redisStatus = `error: ${e.message}`;
    }
    
    return NextResponse.json({
        status: 'ok',
        service: 'deposit-webhook',
        redis: redisStatus,
        env: {
            REDIS_HOST: process.env.REDIS_HOST ? 'SET' : 'MISSING',
            REDIS_PORT: process.env.REDIS_PORT || '6379',
            REDIS_PASSWORD: process.env.REDIS_PASSWORD ? 'SET' : 'MISSING',
            TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? 'SET' : 'MISSING',
            DEPOSIT_CHATID: process.env.DEPOSIT_CHATID ? 'SET' : 'MISSING'
        },
        time: new Date().toISOString()
    });
}

// Tatum webhook handler
export async function POST(request) {
    let redis = null;
    try {
        const payload = await request.json();
        console.log('📥 Webhook received:', JSON.stringify(payload));
        
        redis = await getRedis();
        if (!redis) {
            console.error('❌ Cannot process - Redis not available');
            return NextResponse.json({ received: true, error: 'Redis unavailable' });
        }
        
        await processWebhook(payload, redis);
        
        return NextResponse.json({ received: true, processed: true });
    } catch (error) {
        console.error('❌ Webhook POST error:', error.message);
        return NextResponse.json({ received: true, error: error.message });
    } finally {
        if (redis) {
            try { await redis.disconnect(); } catch (e) {}
        }
    }
}

async function processWebhook(payload, redis) {
    // Log full payload for debugging
    console.log('Processing payload:', JSON.stringify(payload, null, 2));
    
    // Tatum ADDRESS_EVENT can have various structures
    // Extract all possible fields
    const txId = payload.txId || payload.transactionId || payload.hash;
    const address = payload.address || payload.to;
    const amount = payload.amount || payload.value;
    const chain = payload.chain || payload.network;
    const type = payload.type;
    const asset = payload.asset || payload.tokenSymbol || payload.currency;
    const blockNumber = payload.blockNumber || payload.block;
    const counterAddress = payload.counterAddress || payload.from;
    
    console.log(`Parsed: txId=${txId}, address=${address}, amount=${amount}, chain=${chain}, type=${type}, asset=${asset}`);
    
    // Validate required fields
    if (!txId || !address || !amount) {
        console.log('Skip: Missing required fields (txId, address, or amount)');
        return;
    }
    
    // Skip outgoing transactions
    if (type === 'outgoing' || type === 'native_outgoing' || type === 'token_outgoing') {
        console.log('Skip: outgoing transaction');
        return;
    }
    
    // DUPLICATE CHECK
    const txKey = `ghetto:processed_tx:${txId}`;
    const exists = await redis.exists(txKey);
    if (exists) {
        console.log(`Skip: TX ${txId} already processed`);
        return;
    }
    
    // Lock TX to prevent race conditions
    const lockKey = `ghetto:tx_lock:${txId}`;
    const locked = await redis.set(lockKey, '1', { NX: true, EX: 60 });
    if (!locked) {
        console.log(`Skip: TX ${txId} being processed`);
        return;
    }
    
    try {
        // Find user by address (try both cases)
        let userId = await redis.get(`ghetto:tatum:address:${address.toLowerCase()}`);
        if (!userId) {
            userId = await redis.get(`ghetto:tatum:address:${address}`);
        }
        
        if (!userId) {
            console.log(`Skip: No user for address ${address}`);
            // List all registered addresses for debugging
            const keys = await redis.keys('ghetto:tatum:address:*');
            console.log(`Registered addresses: ${keys.length}`);
            return;
        }
        
        console.log(`Found user ${userId} for address ${address}`);
        
        // Determine symbol
        let symbol = asset;
        if (!symbol || symbol === chain) {
            const chainMap = { 'ETH': 'ETH', 'BSC': 'BNB', 'BTC': 'BTC', 'LTC': 'LTC', 'SOL': 'SOL', 'ethereum': 'ETH', 'bsc': 'BNB' };
            symbol = chainMap[chain] || chain;
        }
        
        // Parse amount
        const depositAmount = parseFloat(amount);
        if (!depositAmount || depositAmount <= 0) {
            console.log(`Skip: Invalid amount ${amount}`);
            return;
        }
        
        // Get USD price
        const price = await getPrice(symbol);
        console.log(`Price for ${symbol}: $${price}`);
        
        const usdAmount = price ? (depositAmount * price).toFixed(2) : '0.00';
        console.log(`Deposit value: ${depositAmount} ${symbol} = $${usdAmount}`);
        
        // Check minimum deposit
        const minSetting = await redis.hGet('ghetto:deposit_withdraw_settings', 'min_deposit_usd');
        const minUSD = parseFloat(minSetting || '5');
        
        if (parseFloat(usdAmount) < minUSD) {
            console.log(`Skip: $${usdAmount} below min $${minUSD}`);
            await redis.hSet(txKey, {
                userId, amount: depositAmount.toString(), symbol, usdAmount,
                status: 'below_minimum', processedAt: new Date().toISOString()
            });
            return;
        }
        
        // Get user data and update balance
        const userKey = `ghetto:users:${userId}`;
        const userData = await redis.hGetAll(userKey);
        const firstName = userData?.first_name || 'User';
        const currentBalance = parseFloat(userData?.balance || '0');
        const newBalance = (currentBalance + parseFloat(usdAmount)).toFixed(2);
        
        console.log(`Updating balance: $${currentBalance} + $${usdAmount} = $${newBalance}`);
        
        await redis.hSet(userKey, 'balance', newBalance);
        
        // Mark TX as processed
        await redis.hSet(txKey, {
            userId,
            amount: depositAmount.toString(),
            symbol,
            usdAmount,
            newBalance,
            chain: chain || '',
            blockNumber: blockNumber?.toString() || '',
            status: 'completed',
            processedAt: new Date().toISOString()
        });
        
        // Send notifications
        const userMsg = `💰 *Deposit Confirmed!*\n\n` +
            `💵 Amount: \`${depositAmount} ${symbol}\`\n` +
            `💲 Value: \`$${usdAmount} USD\`\n` +
            `🔗 Network: \`${chain || 'Unknown'}\`\n\n` +
            `💳 New Balance: \`$${newBalance}\`\n\n` +
            `🏷️ TX: \`${txId}\``;
        
        await sendTelegram(userId, userMsg);
        
        const adminChatId = process.env.DEPOSIT_CHATID;
        if (adminChatId) {
            const adminMsg = `💰 *New Deposit*\n\n` +
                `👤 User: ${firstName} (\`${userId}\`)\n` +
                `💵 Amount: \`${depositAmount} ${symbol}\`\n` +
                `💲 Value: \`$${usdAmount} USD\`\n` +
                `🔗 Network: \`${chain || 'Unknown'}\`\n` +
                `💳 New Balance: \`$${newBalance}\`\n\n` +
                `🏷️ TX: \`${txId}\``;
            
            await sendTelegram(adminChatId, adminMsg);
        }
        
        console.log(`✅ Deposit complete: ${depositAmount} ${symbol} ($${usdAmount}) → User ${userId}`);
        
    } finally {
        await redis.del(lockKey);
    }
}
