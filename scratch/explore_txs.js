const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

async function main() {
    const address = '0xfc655C096cA4B26d485466CE50Dd5226d7954A05';
    const chain = 'bsc';
    const limit = 100;
    
    console.log(`Fetching history for ${address}...`);
    try {
        const { stdout } = await execFileAsync('npx', [
            '@trustwallet/cli', 'history',
            '--address', address,
            '--chain', chain,
            '--limit', String(limit),
            '--json'
        ], { timeout: 45000, shell: true });
        
        const output = stdout.trim();
        const firstBrace = output.search(/[{[]/);
        const lastBraceChar = output[firstBrace] === '{' ? '}' : ']';
        const lastBrace = output.lastIndexOf(lastBraceChar);
        const jsonString = output.substring(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(jsonString);
        const txs = Array.isArray(parsed) ? parsed : (parsed.transactions || parsed.items || []);
        
        console.log(`Fetched ${txs.length} transactions.`);
        
        // Print distinct event assets and structures
        const assets = new Set();
        txs.forEach(tx => {
            const events = tx.events || [];
            events.forEach(ev => {
                if (ev.data && ev.data.asset) {
                    assets.add(ev.data.asset);
                }
            });
        });
        
        console.log("Distinct assets found in events:");
        console.log(Array.from(assets));
        
        // Let's print any transaction that has more than 1 event
        const multiEventTxs = txs.filter(tx => (tx.events || []).length > 1);
        console.log(`Found ${multiEventTxs.length} transactions with multiple events.`);
        if (multiEventTxs.length > 0) {
            console.log("Example multi-event transaction:");
            console.log(JSON.stringify(multiEventTxs[0], null, 2));
        } else {
            console.log("Example single-event transaction:");
            if (txs.length > 0) {
                console.log(JSON.stringify(txs[0], null, 2));
            }
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

main();
