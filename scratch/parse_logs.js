const fs = require('fs');

const logPath = 'D:\\download\\l8aksf5yes0y9n1sn4r7zkcp-074539225241-all-logs-2026-06-13-17-07-29.txt';
const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n');

console.log('--- Successful auto-closes / exits ---');
lines.forEach((line, index) => {
    if (line.includes('closed position') || line.includes('Auto-Exit') || line.includes('Auto-Close') || line.includes('sellToken') || line.includes('Exit Long')) {
        console.log(`Line ${index + 1}: ${line}`);
    }
});

console.log('--- Failed closes / errors count ---');
let failCount = 0;
lines.forEach((line, index) => {
    if (line.includes('position close failed') || line.includes('auto-closing position failed')) {
        failCount++;
        if (failCount <= 20) {
            console.log(`Line ${index + 1}: ${line}`);
        }
    }
});
console.log('Total failed closes:', failCount);
