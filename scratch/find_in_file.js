const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../src/lib/bot-engine.ts');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

const query = process.argv[2] || 'buyToken';
console.log(`Searching for "${query}" in ${filePath}...`);

let count = 0;
lines.forEach((line, index) => {
    if (line.toLowerCase().includes(query.toLowerCase())) {
        console.log(`${index + 1}: ${line.trim()}`);
        count++;
    }
});
console.log(`Found ${count} occurrences.`);
