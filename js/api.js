// ==========================================
// SecurePro — Code Execution Engine (Local)
// Uses Node.js child_process for real compilation & execution
// ==========================================

const { exec } = require('child_process');
const fs = require('fs');
const pathMod = require('path');
const os = require('os');

// Language boilerplate templates
function getBoilerplate(lang) {
    const templates = {
        'javascript': 'const input = require("fs").readFileSync("/dev/stdin", "utf8").trim();\n\n// Write your solution below\nconsole.log(input);',
        'python': 'import sys\ninput_data = sys.stdin.read().strip()\n\n# Write your solution below\nprint(input_data)',
        'c': '#include <stdio.h>\n\nint main() {\n    char input[1024];\n    scanf("%[^\\n]", input);\n\n    // Write your solution below\n    printf("%s\\n", input);\n    return 0;\n}',
        'c++': '#include <iostream>\nusing namespace std;\n\nint main() {\n    string input;\n    getline(cin, input);\n\n    // Write your solution below\n    cout << input << endl;\n    return 0;\n}'
    };
    return templates[lang] || templates['javascript'];
}

const LANG_EXT = { 'javascript': '.js', 'python': '.py', 'c': '.c', 'c++': '.cpp' };

function cleanupFiles(files) {
    files.forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } });
}

// Execute code locally using child_process
function executeCode(code, lang, stdin) {
    return new Promise((resolve) => {
        const tmpDir = os.tmpdir();
        const basename = 'exam_code_' + Date.now();
        const srcFile = pathMod.join(tmpDir, basename + LANG_EXT[lang]);

        try { fs.writeFileSync(srcFile, code, 'utf8'); }
        catch (e) { resolve({ success: false, output: '', error: 'Write failed: ' + e.message, exitCode: 1 }); return; }

        const timeout = 10000;

        if (lang === 'javascript') {
            const child = exec(`node "${srcFile}"`, { timeout, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
                cleanupFiles([srcFile]);
                if (err && err.killed) resolve({ success: false, output: '', error: 'Time Limit Exceeded (10s)', exitCode: 1 });
                else if (err && !stdout) resolve({ success: false, output: '', error: stderr || err.message, exitCode: 1 });
                else resolve({ success: true, output: (stdout || '').trimEnd(), error: stderr || '', exitCode: 0 });
            });
            if (stdin) child.stdin.write(stdin);
            child.stdin.end();

        } else if (lang === 'python') {
            const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
            const child = exec(`${pyCmd} "${srcFile}"`, { timeout, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
                cleanupFiles([srcFile]);
                if (err && err.killed) resolve({ success: false, output: '', error: 'Time Limit Exceeded (10s)', exitCode: 1 });
                else if (err && !stdout) resolve({ success: false, output: '', error: stderr || err.message, exitCode: 1 });
                else resolve({ success: true, output: (stdout || '').trimEnd(), error: stderr || '', exitCode: 0 });
            });
            if (stdin) child.stdin.write(stdin);
            child.stdin.end();

        } else if (lang === 'c' || lang === 'c++') {
            const outFile = pathMod.join(tmpDir, basename + (process.platform === 'win32' ? '.exe' : ''));
            const compiler = lang === 'c' ? 'gcc' : 'g++';
            exec(`${compiler} "${srcFile}" -o "${outFile}" -lm`, { timeout: 15000 }, (compErr, _, compStderr) => {
                if (compErr) {
                    cleanupFiles([srcFile, outFile]);
                    resolve({ success: false, output: '', error: 'Compilation Error:\n' + (compStderr || compErr.message), exitCode: 1 });
                    return;
                }
                const child = exec(`"${outFile}"`, { timeout, maxBuffer: 512 * 1024 }, (runErr, stdout, stderr) => {
                    cleanupFiles([srcFile, outFile]);
                    if (runErr && runErr.killed) resolve({ success: false, output: '', error: 'Time Limit Exceeded (10s)', exitCode: 1 });
                    else if (runErr && !stdout) resolve({ success: false, output: '', error: stderr || runErr.message, exitCode: 1 });
                    else resolve({ success: true, output: (stdout || '').trimEnd(), error: stderr || '', exitCode: 0 });
                });
                if (stdin) child.stdin.write(stdin);
                child.stdin.end();
            });
        } else {
            cleanupFiles([srcFile]);
            resolve({ success: false, output: '', error: 'Unsupported language: ' + lang, exitCode: 1 });
        }
    });
}

// Run button handler
async function runCode(i, lang) {
    const code = document.getElementById('code_' + i).value;
    const consoleEl = document.getElementById('console_' + i);
    const statusEl = document.getElementById('run-status_' + i);

    consoleEl.innerText = '\u23f3 Running locally...';
    consoleEl.style.color = '#94a3b8';
    if (statusEl) { statusEl.innerText = 'Running...'; statusEl.style.color = '#f59e0b'; }

    const result = await executeCode(code, lang, '');

    if (result.success) {
        consoleEl.style.color = '#10b981';
        consoleEl.innerText = result.output || '(No output)';
        if (statusEl) { statusEl.innerText = '\u2705 Success'; statusEl.style.color = '#10b981'; }
    } else {
        consoleEl.style.color = '#ef4444';
        consoleEl.innerText = '\u274c Error:\n' + (result.error || 'Unknown error');
        if (statusEl) { statusEl.innerText = '\u274c Error'; statusEl.style.color = '#ef4444'; }
    }
}

// Test button handler — runs with stdin, compares to expected
async function checkCode(i, lang, expected, stdin) {
    const code = document.getElementById('code_' + i).value;
    const consoleEl = document.getElementById('console_' + i);
    const statusEl = document.getElementById('run-status_' + i);
    const resultEl = document.getElementById('test-result_' + i);

    consoleEl.innerText = '\u23f3 Testing...';
    consoleEl.style.color = '#94a3b8';
    if (statusEl) { statusEl.innerText = 'Testing...'; statusEl.style.color = '#f59e0b'; }

    const result = await executeCode(code, lang, stdin || '');

    if (!result.success) {
        consoleEl.style.color = '#ef4444';
        consoleEl.innerText = '\u274c Error:\n' + (result.error || 'Unknown');
        if (resultEl) resultEl.innerHTML = '<span style="color:#ef4444;">\u274c Error</span>';
        if (statusEl) { statusEl.innerText = '\u274c Error'; statusEl.style.color = '#ef4444'; }
        document.getElementById('pass_' + i).value = 'false';
        return;
    }

    const actual = (result.output || '').trim();
    const expect = (expected || '').trim();
    const passed = actual === expect;
    document.getElementById('pass_' + i).value = passed ? 'true' : 'false';

    if (passed) {
        consoleEl.style.color = '#10b981';
        consoleEl.innerText = '\u2705 Test passed!\n\nOutput:\n' + actual;
        if (resultEl) resultEl.innerHTML = '<span style="color:#10b981;font-weight:600;">\u2705 PASSED</span>';
        if (statusEl) { statusEl.innerText = '\u2705 Passed'; statusEl.style.color = '#10b981'; }
    } else {
        consoleEl.style.color = '#f59e0b';
        consoleEl.innerText = '\u274c Output mismatch!\n\nExpected:\n' + expect + '\n\nGot:\n' + actual;
        if (resultEl) resultEl.innerHTML = '<span style="color:#ef4444;font-weight:600;">\u274c FAILED</span>';
        if (statusEl) { statusEl.innerText = '\u274c Failed'; statusEl.style.color = '#ef4444'; }
    }
}

// ==========================================
// Phase 4: AI-Generated Answer Detection (Groq)
// ==========================================
async function detectAIGenerated(text) {
    if (!text || text.trim().length < 50) return { isAI: false, confidence: 0 };

    const prompt = `Analyze this exam response for AI generation. Look for unnatural vocabulary, perfect sentence uniformity, and lack of human voice. Reply strictly in JSON: {"isAI": true/false, "confidence": 0-100}.

Response to analyze:
"""
${text.substring(0, 1500)}
"""`;

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 150
            })
        });

        if (!response.ok) return { isAI: false, confidence: 0, error: 'API error ' + response.status };

        const data = await response.json();
        let reply = (data.choices?.[0]?.message?.content || '').trim();
        if (reply.startsWith('```')) reply = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const result = JSON.parse(reply);

        return { isAI: !!result.isAI, confidence: Math.min(100, Math.max(0, result.confidence || 0)) };
    } catch (e) {
        return { isAI: false, confidence: 0, error: 'Network error or parse error' };
    }
}

// ==========================================
// Phase 4: Pairwise Plagiarism Detection (Cosine Similarity)
// ==========================================
function tokenize(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function cosineSimilarity(text1, text2) {
    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);
    if (tokens1.length === 0 || tokens2.length === 0) return 0;

    const freqMap = {};
    tokens1.forEach(t => { if (!freqMap[t]) freqMap[t] = { a: 0, b: 0 }; freqMap[t].a++; });
    tokens2.forEach(t => { if (!freqMap[t]) freqMap[t] = { a: 0, b: 0 }; freqMap[t].b++; });

    let dotProduct = 0, magA = 0, magB = 0;
    for (const t of Object.values(freqMap)) {
        dotProduct += t.a * t.b;
        magA += t.a * t.a;
        magB += t.b * t.b;
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    return magnitude === 0 ? 0 : Math.round((dotProduct / magnitude) * 100);
}
