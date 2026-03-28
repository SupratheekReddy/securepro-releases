const fs = require('fs');

const fixFile = (path, isHtml) => {
  let content = fs.readFileSync(path, 'utf8');
  
  // High-level emoji/mojibake map
  const mojiMap = {
    'ðŸŸ¢': isHtml ? '&#x1f7e2;' : '\\ud83d\\udfe2',  // 🟢
    'âœ“': isHtml ? '&checkmark;' : '\\u2713',       // ✓
    'â€¢': isHtml ? '&bull;' : '\\u2022',           // •
    'â °': isHtml ? '&#x23f0;' : '\\u23f0',          // ⏰
    'â›”': isHtml ? '&#x26d4;' : '\\u26d4',          // ⛔
    'ðŸ“…': isHtml ? '&#x1f4c5;' : '\\ud83d\\udcc5', // 📅
    'â†’': isHtml ? '&rarr;' : '\\u2192',           // →
    'ðŸ§ª': isHtml ? '&#x1f9ea;' : '\\ud83e\\uddea', // 🧪
    'âœ…': isHtml ? '&#x2705;' : '\\u2705',          // ✅
    'â€”': '-',
    'â”€': '-',
    'ðŸ–¤': isHtml ? '&#x1f5a4;' : '\\ud83d\\udda4', // 🖤
    'ðŸ”«': isHtml ? '&#x1f52b;' : '\\ud83d\\udd2b', // 🔫
    'ðŸ•°': isHtml ? '&#x23f0;' : '\\u23f0',          // ⏰
    'ðŸ’»': isHtml ? '&#x1f4bb;' : '\\ud83d\\udcbb', // 💻
    'ðŸ“': isHtml ? '&#x1f4c4;' : '\\ud83d\\udcc4',  // 📄
    'ðŸ“…': isHtml ? '&#x1f4c5;' : '\\ud83d\\udcc5'  // 📅
  };

  Object.keys(mojiMap).forEach(k => {
    content = content.split(k).join(mojiMap[k]);
  });

  // Final catch-all for any character >= 128
  content = content.replace(/[^\x00-\x7f]/g, (char) => {
    const code = char.charCodeAt(0);
    if (isHtml) return `&#${code};`;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });

  fs.writeFileSync(path, content, 'utf8');
  console.log(`Fixed ${path}`);
};

fixFile('js/app.js', false);
fixFile('index.html', true);
