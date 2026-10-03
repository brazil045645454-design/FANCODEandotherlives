// Storage layer. Replace load/save to use another persistent store later.
const fs = require('fs');
const FILE = process.env.DATA_FILE || 'data.json';

exports.load = () => {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return d && typeof d.streamUrl === 'string' && d.streamUrl ? d : null;
  } catch { return null; }
};

exports.save = (d) => {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(d));
    fs.renameSync(FILE + '.tmp', FILE);
    return true;
  } catch (e) {
    console.error('store: save failed:', e.code || e.message);
    return false;
  }
};
