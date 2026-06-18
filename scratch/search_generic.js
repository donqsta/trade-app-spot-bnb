const fs = require('fs');
const path = require('path');

const targetFile = process.argv[2];
const query = process.argv[3];

if (!targetFile || !query) {
    console.error("Usage: node search_generic.js <file_path> <query>");
    process.exit(1);
}

const filePath = path.resolve(process.cwd(), targetFile);
if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log(`Searching for "${query}" in ${targetFile}...`);
let count = 0;
lines.forEach((line, index) => {
    if (line.toLowerCase().includes(query.toLowerCase())) {
        console.log(`${index + 1}: ${line.trim()}`);
        count++;
    }
});
console.log(`Found ${count} occurrences.`);
