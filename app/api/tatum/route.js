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

// Health check and debug endpoint
export async function GET(request) {
    const url = new URL(request.url);
    const debug = url.searchParams.get('debug');
    const address = url.searchParams.get('address');
    
    let redis = null;
    let redisStatus = 'not tested';
    let debugInfo = null;
    
    try {
        redis = await getRedis();
        if (redis) {
            redisStatus = 'connected';
            
            // Debug mode - check address mapping
            if (debug === '1' && address) {
                const userId = await redis.get(`ghetto:tatum:address:${address.toLowerCase()}`);
                const allKeys = await redis.keys('ghetto:tatum:address:*');
                debugInfo = {
                    address: address,
                    addressLower: address.toLowerCase(),
                    userId: userId,
                    totalAddresses: allKeys.length,
                    sampleAddresses: allKeys.slice(0, 5)
                };
            } else if (debug === '1') {
                const allKeys = await redis.keys('ghetto:tatum:address:*');
                const webhookLogs = await redis.keys('ghetto:webhook_debug:*');
                const recentPayloads = [];
                for (const k of webhookLogs.slice(-5)) {
                    const data = await redis.get(k);
                    recentPayloads.push({ key: k, payload: JSON.parse(data || '{}') });
                }
                debugInfo = {
                    totalAddresses: allKeys.length,
                    addresses: allKeys.slice(0, 10),
                    recentWebhooks: recentPayloads
                };
            }
        } else {
            redisStatus = 'failed - check env vars';
        }
    } catch (e) {
        redisStatus = `error: ${e.message}`;
    } finally {
        if (redis) try { await redis.disconnect(); } catch(e) {}
    }
    
    return NextResponse.json({
        status: 'ok',
        service: 'deposit-webhook',
        redis: redisStatus,
        debug: debugInfo,
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
        
        // Store raw payload for debugging (keep last 20)
        const debugKey = `ghetto:webhook_debug:${Date.now()}`;
        await redis.set(debugKey, JSON.stringify(payload), { EX: 3600 }); // expires in 1 hour
        
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

// Known token contract addresses (lowercase) -> symbol
const TOKEN_CONTRACTS = {
    // USDT
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', // ETH USDT
    '0x55d398326f99059ff775485246999027b3197955': 'USDT', // BSC USDT  
    'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnYb': 'USDT', // SOL USDT
    // USDC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', // ETH USDC
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC', // BSC USDC
};

async function processWebhook(payload, redis) {
    console.log('========== WEBHOOK RECEIVED ==========');
    console.log('Raw payload:', JSON.stringify(payload, null, 2));
    
    // Extract fields - Tatum ADDRESS_TRANSACTION format:
    // For native: address = recipient (our address)
    // For token: address = sender, counterAddress = recipient (our address)
    const txId = payload.txId || payload.transactionId || payload.hash;
    const txType = payload.type; // 'native' or 'token'
    const chain = payload.chain;
    const blockNumber = payload.blockNumber;
    
    // For token transfers, the deposit address is in counterAddress, not address
    // For native transfers, the deposit address is in address
    let depositAddress = payload.address;
    if (txType === 'token' && payload.counterAddress) {
        depositAddress = payload.counterAddress;
        console.log(`Token transfer: using counterAddress ${depositAddress} as deposit address`);
    }
    
    // Amount - Tatum sends human-readable format
    const amount = payload.amount;
    
    // Token symbol - Tatum sends tokenSymbol for some, asset (contract address) for others
    let symbol = payload.tokenSymbol || payload.asset || payload.currency;
    
    // Check if symbol/asset is a contract address and map to token name
    if (symbol && (symbol.startsWith('0x') || symbol.startsWith('0X'))) {
        const tokenName = TOKEN_CONTRACTS[symbol.toLowerCase()];
        if (tokenName) {
            console.log(`✅ Mapped contract ${symbol} to ${tokenName}`);
            symbol = tokenName;
        } else {
            console.log(`⚠️ Unknown token contract: ${symbol}`);
            symbol = 'UNKNOWN_TOKEN';
        }
    }
    
    // If no symbol or it matches chain name, it's a native transfer
    // Chain names from Tatum: "bsc-mainnet", "ethereum-mainnet", "solana-mainnet", etc.
    if (!symbol || symbol === chain || symbol === 'BSC' || symbol === 'ETH' || symbol === 'SOL' || symbol === 'LTC' || symbol === 'BTC') {
        const nativeSymbols = {
            'ETH': 'ETH',
            'BSC': 'BNB',
            'BTC': 'BTC',
            'LTC': 'LTC',
            'SOL': 'SOL',
            'ethereum-mainnet': 'ETH',
            'bsc-mainnet': 'BNB',
            'solana-mainnet': 'SOL',
            'litecoin-core-mainnet': 'LTC',
            'bitcoin-mainnet': 'BTC',
            'MATIC': 'MATIC',
            'TRON': 'TRX'
        };
        symbol = nativeSymbols[chain] || nativeSymbols[symbol] || chain;
    }
    
    console.log(`Parsed: txId=${txId}, depositAddress=${depositAddress}, amount=${amount}, chain=${chain}, txType=${txType}, symbol=${symbol}`);
    
    // Validate required fields
    if (!txId) {
        console.log('❌ Skip: No txId');
        return;
    }
    if (!depositAddress) {
        console.log('❌ Skip: No deposit address');
        return;
    }
    if (!amount || parseFloat(amount) <= 0) {
        console.log(`❌ Skip: Invalid amount: ${amount}`);
        return;
    }
    
    // Skip outgoing transactions
    if (txType === 'outgoing') {
        console.log('⏭️ Skip: outgoing transaction');
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
        // Find user by deposit address (try both cases)
        let userId = await redis.get(`ghetto:tatum:address:${depositAddress.toLowerCase()}`);
        if (!userId) {
            userId = await redis.get(`ghetto:tatum:address:${depositAddress}`);
        }
        
        if (!userId) {
            console.log(`❌ Skip: No user for deposit address ${depositAddress}`);
            // List all registered addresses for debugging
            const keys = await redis.keys('ghetto:tatum:address:*');
            console.log(`Registered addresses: ${keys.length}`, keys.slice(0, 3));
            return;
        }
        
        console.log(`✅ Found user ${userId} for deposit address ${depositAddress}`);
        
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
