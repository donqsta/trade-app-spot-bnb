const { execFile } = require('child_process');
const fs = require('fs');

const envContent = fs.readFileSync('.env.local', 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
    const parts = line.trim().split('=');
    if (parts.length >= 2 && !line.trim().startsWith('#')) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        env[key] = val;
    }
});

const fullEnv = { ...process.env, ...env };

// Get portfolio balance
execFile('npx', ['@trustwallet/cli', 'wallet', 'portfolio', '--chains', 'bsc', '--json'], { env: fullEnv, shell: true }, (err, stdout, stderr) => {
    console.log('--- TEST 5: Portfolio ---');
    if (err) {
        console.error('Error:', err.message);
    }
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
});
