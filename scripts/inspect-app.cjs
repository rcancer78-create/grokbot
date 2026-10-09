// Read-only inspection of protocol declarations in an installed Electron ASAR.
const fs = require('node:fs');
const archive = process.argv[2];
const needle = new RegExp(process.argv[3]);
const radius = Number(process.argv[4] || 700);
const fd = fs.openSync(archive, 'r');
const header = Buffer.alloc(16);
fs.readSync(fd, header, 0, 16, 0);
const json = Buffer.alloc(header.readUInt32LE(12));
fs.readSync(fd, json, 0, json.length, 16);
const base = 8 + header.readUInt32LE(4);
function walk(files, prefix = '') {
  for (const [name, entry] of Object.entries(files)) {
    const file = prefix + name;
    if (entry.files) walk(entry.files, file + '/');
    else if (/\.(c?js|mjs|json)$/.test(file) && (!process.argv[5] || file.includes(process.argv[5])) && !file.includes('node_modules') && !entry.unpacked) {
      const data = Buffer.alloc(entry.size);
      fs.readSync(fd, data, 0, data.length, base + Number(entry.offset));
      const text = data.toString('utf8');
      const re = new RegExp(needle, 'g');
      for (const match of text.matchAll(re)) {
        console.log(file + ': ' + text.slice(Math.max(0, match.index - radius), match.index + match[0].length + radius));
      }
    }
  }
}
walk(JSON.parse(json).files);
fs.closeSync(fd);
