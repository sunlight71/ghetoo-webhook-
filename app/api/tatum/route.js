import { createClient } from 'redis';
import { NextResponse } from 'next/server';

const TATUM_API_KEY = process.env.TATUM_API_KEY;

// Admin wallet addresses for receiving deposits
const ADMIN_WALLETS = {
    ETH: process.env.DEPOSIT_WALLET_PUBLIC_KEY_ETH,
    BNB: process.env.DEPOSIT_WALLET_PUBLIC_KEY_BNB,
    SOL: process.env.DEPOSIT_WALLET_PUBLIC_KEY_SOL,
    BTC: process.env.DEPOSIT_WALLET_PUBLIC_KEY_BTC,
    LTC: process.env.DEPOSIT_WALLET_PUBLIC_KEY_LTC
};

// Native coins that should be auto-transferred
const NATIVE_COINS = ['ETH', 'BNB', 'SOL', 'BTC', 'LTC'];

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

// ============== AUTO-TRANSFER FUNCTIONS ==============

// Get wallet balance via Tatum API
async function getWalletBalance(chain, address) {
    const endpoints = {
        'ETH': `https://api.tatum.io/v3/ethereum/account/balance/${address}`,
        'BNB': `https://api.tatum.io/v3/bsc/account/balance/${address}`,
        'SOL': `https://api.tatum.io/v3/solana/account/balance/${address}`,
        'BTC': `https://api.tatum.io/v3/bitcoin/address/balance/${address}`,
        'LTC': `https://api.tatum.io/v3/litecoin/address/balance/${address}`
    };
    
    const url = endpoints[chain];
    if (!url) return null;
    
    try {
        const res = await fetch(url, {
            headers: { 'x-api-key': TATUM_API_KEY }
        });
        const data = await res.json();
        
        // EVM chains return { balance: "wei_value" }
        if (chain === 'ETH' || chain === 'BNB') {
            return parseFloat(data.balance) / 1e18;
        }
        // SOL returns { balance: "lamports" }
        if (chain === 'SOL') {
            return parseFloat(data.balance) / 1e9;
        }
        // UTXO chains return { incoming, outgoing } in satoshis
        if (chain === 'BTC' || chain === 'LTC') {
            const incoming = parseFloat(data.incoming || 0);
            const outgoing = parseFloat(data.outgoing || 0);
            return (incoming - outgoing) / 1e8;
        }
        return null;
    } catch (err) {
        console.error(`Balance fetch error for ${chain}:`, err.message);
        return null;
    }
}

// Get UTXOs for BTC/LTC
async function getUTXOs(chain, address) {
    const endpoints = {
        'BTC': `https://api.tatum.io/v3/bitcoin/utxo/${address}`,
        'LTC': `https://api.tatum.io/v3/litecoin/utxo/${address}`
    };
    
    try {
        const res = await fetch(endpoints[chain], {
            headers: { 'x-api-key': TATUM_API_KEY }
        });
        return await res.json();
    } catch (err) {
        console.error(`UTXO fetch error:`, err.message);
        return [];
    }
}

// Transfer EVM native coins (ETH/BNB)
async function transferEVM(chain, fromAddress, privateKey, toAddress, amount) {
    const endpoints = {
        'ETH': 'https://api.tatum.io/v3/ethereum/transaction',
        'BNB': 'https://api.tatum.io/v3/bsc/transaction'
    };
    
    try {
        // Convert to wei (string)
        const amountWei = (amount * 1e18).toFixed(0);
        
        const res = await fetch(endpoints[chain], {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': TATUM_API_KEY
            },
            body: JSON.stringify({
                to: toAddress,
                amount: amount.toString(),
                currency: chain === 'BNB' ? 'BSC' : 'ETH',
                fromPrivateKey: privateKey
            })
        });
        
        const data = await res.json();
        if (data.txId) {
            console.log(`✅ ${chain} transfer success: ${data.txId}`);
            return { success: true, txId: data.txId };
        } else {
            console.error(`❌ ${chain} transfer failed:`, data);
            return { success: false, error: data.message || JSON.stringify(data) };
        }
    } catch (err) {
        console.error(`❌ ${chain} transfer error:`, err.message);
        return { success: false, error: err.message };
    }
}

// Transfer SOL
async function transferSOL(fromAddress, privateKey, toAddress, amount) {
    try {
        const res = await fetch('https://api.tatum.io/v3/solana/transaction', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': TATUM_API_KEY
            },
            body: JSON.stringify({
                from: fromAddress,
                to: toAddress,
                amount: amount.toString(),
                fromPrivateKey: privateKey
            })
        });
        
        const data = await res.json();
        if (data.txId) {
            console.log(`✅ SOL transfer success: ${data.txId}`);
            return { success: true, txId: data.txId };
        } else {
            console.error(`❌ SOL transfer failed:`, data);
            return { success: false, error: data.message || JSON.stringify(data) };
        }
    } catch (err) {
        console.error(`❌ SOL transfer error:`, err.message);
        return { success: false, error: err.message };
    }
}

// Transfer UTXO coins (BTC/LTC)
async function transferUTXO(chain, address, privateKey, toAddress) {
    const endpoints = {
        'BTC': 'https://api.tatum.io/v3/bitcoin/transaction',
        'LTC': 'https://api.tatum.io/v3/litecoin/transaction'
    };
    
    try {
        // Get UTXOs
        const utxos = await getUTXOs(chain, address);
        if (!utxos || utxos.length === 0) {
            console.log(`No UTXOs for ${chain} address ${address}`);
            return { success: false, error: 'No UTXOs available' };
        }
        
        // Calculate total value
        let totalSats = 0;
        const fromUTXO = utxos.map(u => {
            totalSats += u.value;
            return {
                txHash: u.txHash,
                index: u.index,
                privateKey: privateKey
            };
        });
        
        // Estimate fee (simple: 10 sat/byte * ~250 bytes per input)
        const estimatedFee = Math.ceil(fromUTXO.length * 250 * 10);
        const sendAmount = (totalSats - estimatedFee) / 1e8;
        
        if (sendAmount <= 0) {
            console.log(`Insufficient balance after fees for ${chain}`);
            return { success: false, error: 'Insufficient balance after fees' };
        }
        
        const res = await fetch(endpoints[chain], {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': TATUM_API_KEY
            },
            body: JSON.stringify({
                fromUTXO,
                to: [{ address: toAddress, value: sendAmount }]
            })
        });
        
        const data = await res.json();
        if (data.txId) {
            console.log(`✅ ${chain} transfer success: ${data.txId}`);
            return { success: true, txId: data.txId };
        } else {
            console.error(`❌ ${chain} transfer failed:`, data);
            return { success: false, error: data.message || JSON.stringify(data) };
        }
    } catch (err) {
        console.error(`❌ ${chain} transfer error:`, err.message);
        return { success: false, error: err.message };
    }
}

// Main auto-transfer function
async function autoTransferToAdmin(symbol, chain, depositAddress, redis, userId) {
    // Only transfer native coins
    if (!NATIVE_COINS.includes(symbol)) {
        console.log(`⏭️ Skip auto-transfer: ${symbol} is not a native coin`);
        return null;
    }
    
    const adminWallet = ADMIN_WALLETS[symbol];
    if (!adminWallet) {
        console.log(`⏭️ Skip auto-transfer: No admin wallet configured for ${symbol}`);
        return null;
    }
    
    // Map symbol to blockchain key for wallet lookup
    const blockchainKey = symbol === 'ETH' || symbol === 'BNB' ? 'evm' : symbol.toLowerCase();
    
    // Get user wallet with private key from Redis
    const walletKey = `deposit:${userId}:${blockchainKey}`;
    const walletData = await redis.hGetAll(walletKey);
    
    if (!walletData || !walletData.privateKey) {
        console.log(`❌ No private key found for user ${userId} wallet ${blockchainKey}`);
        return null;
    }
    
    const privateKey = walletData.privateKey;
    console.log(`🔄 Auto-transfer: ${symbol} from ${depositAddress} to ${adminWallet}`);
    
    // Get current balance
    const balance = await getWalletBalance(symbol, depositAddress);
    if (!balance || balance <= 0) {
        console.log(`❌ No balance to transfer for ${symbol}`);
        return null;
    }
    
    console.log(`💰 Balance: ${balance} ${symbol}`);
    
    // Execute transfer based on chain type
    let result;
    if (symbol === 'ETH' || symbol === 'BNB') {
        // Reserve gas for transfer (0.001 ETH/BNB)
        const gasReserve = 0.001;
        const sendAmount = balance - gasReserve;
        if (sendAmount <= 0) {
            console.log(`❌ Balance too low to cover gas for ${symbol}`);
            return null;
        }
        result = await transferEVM(symbol, depositAddress, privateKey, adminWallet, sendAmount);
    } else if (symbol === 'SOL') {
        // Reserve gas for transfer (0.001 SOL)
        const gasReserve = 0.001;
        const sendAmount = balance - gasReserve;
        if (sendAmount <= 0) {
            console.log(`❌ Balance too low to cover gas for SOL`);
            return null;
        }
        result = await transferSOL(depositAddress, privateKey, adminWallet, sendAmount);
    } else if (symbol === 'BTC' || symbol === 'LTC') {
        result = await transferUTXO(symbol, depositAddress, privateKey, adminWallet);
    }
    
    return result;
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
    'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnYb': 'USDT', // SOL USDT (case-sensitive)
    'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb': 'USDT', // SOL USDT (lowercase)
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
    // EVM addresses start with 0x, Solana addresses are base58 encoded
    if (symbol && (symbol.startsWith('0x') || symbol.startsWith('0X') || (symbol.length > 30 && !symbol.includes('0x')))) {
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
        
        // Auto-transfer native coins to admin wallet
        if (NATIVE_COINS.includes(symbol)) {
            console.log(`🔄 Initiating auto-transfer for ${symbol}...`);
            const transferResult = await autoTransferToAdmin(symbol, chain, depositAddress, redis, userId);
            
            if (transferResult?.success) {
                // Notify admin about successful transfer
                const transferMsg = `🔄 *Auto-Transfer Complete*\n\n` +
                    `👤 From User: ${firstName} (\`${userId}\`)\n` +
                    `💵 Coin: \`${symbol}\`\n` +
                    `📤 To Admin: \`${ADMIN_WALLETS[symbol]}\`\n` +
                    `🏷️ TX: \`${transferResult.txId}\``;
                
                if (adminChatId) {
                    await sendTelegram(adminChatId, transferMsg);
                }
                
                // Update TX record with transfer info
                await redis.hSet(txKey, {
                    transferTxId: transferResult.txId,
                    transferStatus: 'completed',
                    transferredAt: new Date().toISOString()
                });
            } else if (transferResult?.error) {
                console.log(`⚠️ Auto-transfer failed: ${transferResult.error}`);
                await redis.hSet(txKey, {
                    transferStatus: 'failed',
                    transferError: transferResult.error
                });
            }
        }
        
    } finally {
        await redis.del(lockKey);
    }
}
