const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ limit: '2mb' }));

/* ── Static assets ── */
app.use(express.static(path.join(__dirname, 'public')));

/* ── Stack-trace parser ── */

/**
 * Parse a raw stack-trace string into a unified array of frames.
 * Each frame: { fn, file, line, col, raw, lang }
 */
function parseStackTrace(text) {
  if (!text || typeof text !== 'string') return [];

  // Detect language from first matching line
  const lang = detectLanguage(text);
  const frames = [];

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let frame = null;

    // ── Java ──
    // at com.example.MyClass.myMethod(MyClass.java:42)
    // at com.example.MyClass.myMethod(Unknown Source)
    // at com.example.MyClass.myMethod(Native Method)
    const javaMatch1 = trimmed.match(
      /^at\s+([\w.$]+(?:<init>|<clinit>)?)\(([^)]*)\)$/
    );
    if (javaMatch1) {
      const fn = javaMatch1[1];
      const loc = javaMatch1[2];
      let file = null, line = null;
      const jFileLine = loc.match(/^([\w.$]+\.(?:java|kt|scala|groovy)):(\d+)$/);
      if (jFileLine) {
        file = jFileLine[1];
        line = parseInt(jFileLine[2], 10);
      } else if (loc === 'Unknown Source' || loc === 'Native Method') {
        file = loc;
      } else if (loc.includes(':')) {
        // e.g. "MyClass.java:42" without package prefix
        const parts = loc.split(':');
        file = parts[0];
        line = parts.length > 1 ? parseInt(parts[1], 10) : null;
      }
      frame = { fn, file, line, col: null, raw: trimmed, lang: 'java' };
    }

    // Java "Caused by:" — skip the message line but note it
    if (!frame) {
      const causedBy = trimmed.match(/^Caused\s+by:\s+(.+)$/);
      if (causedBy) {
        frame = { fn: null, file: null, line: null, col: null, raw: trimmed, lang: 'java', kind: 'cause' };
      }
    }

    // ── Python ──
    // File "path/to/file.py", line 42, in my_function
    if (!frame) {
      const pyMatch = trimmed.match(
        /^File\s+"([^"]+)",\s*line\s+(\d+),?\s*in\s+(.+)$/
      );
      if (pyMatch) {
        frame = {
          fn: pyMatch[3].trim(),
          file: pyMatch[1],
          line: parseInt(pyMatch[2], 10),
          col: null,
          raw: trimmed,
          lang: 'python'
        };
      }
    }

    // ── .NET / C# ──
    // at MyNamespace.MyClass.MyMethod() in C:\path\to\file.cs:line 42
    // at MyNamespace.MyClass.MyMethod()
    if (!frame) {
      const dotnetMatch = trimmed.match(
        /^at\s+([\w.<>`]+(?:\([^)]*\))?)\s+in\s+(.+):line\s+(\d+)$/
      );
      if (dotnetMatch) {
        frame = {
          fn: dotnetMatch[1],
          file: dotnetMatch[2],
          line: parseInt(dotnetMatch[3], 10),
          col: null,
          raw: trimmed,
          lang: 'dotnet'
        };
      } else {
        // at MyNamespace.MyClass.MyMethod() — without file info (only if already .NET context)
        const dn2Match = trimmed.match(/^at\s+([\w.<>]+\([^)]*\))$/);
        if (dn2Match && lang === 'dotnet') {
          frame = {
            fn: dn2Match[1],
            file: null,
            line: null,
            col: null,
            raw: trimmed,
            lang: 'dotnet'
          };
        }
      }
    }

    // ── JavaScript V8 / Node ──
    // at myFunction (/path/to/file.js:42:15)
    // at myFunction (file:///path/to/file.js:42:15)
    // at /path/to/file.js:42:15
    if (!frame) {
      // Step 1: match the "at" prefix pattern with optional function name
      const jsAtMatch = trimmed.match(/^at\s+(.+)$/);
      if (jsAtMatch) {
        const inner = jsAtMatch[1];
        // Case: myFunction (path:line:col)  or  path:line:col
        const withFn = inner.match(/^(.+?)\s+\((.+):(\d+):(\d+)\)$/);
        const withFn2 = inner.match(/^(.+?)\s+\((.+):(\d+)\)$/);
        const noFn = inner.match(/^(.+):(\d+):(\d+)$/);
        const noFn2 = inner.match(/^(.+):(\d+)$/);
        if (withFn) {
          frame = { fn: withFn[1].trim(), file: withFn[2], line: parseInt(withFn[3], 10), col: parseInt(withFn[4], 10), raw: trimmed, lang: 'javascript' };
        } else if (withFn2) {
          frame = { fn: withFn2[1].trim(), file: withFn2[2], line: parseInt(withFn2[3], 10), col: null, raw: trimmed, lang: 'javascript' };
        } else if (noFn) {
          frame = { fn: '<anonymous>', file: noFn[1], line: parseInt(noFn[2], 10), col: parseInt(noFn[3], 10), raw: trimmed, lang: 'javascript' };
        } else if (noFn2) {
          frame = { fn: '<anonymous>', file: noFn2[1], line: parseInt(noFn2[2], 10), col: null, raw: trimmed, lang: 'javascript' };
        }
      }
    }

    // ── JavaScript Browser (Firefox-style) ──
    // myFunction@http://example.com/file.js:42:15
    // @http://example.com/file.js:42:15
    if (!frame) {
      const jsFfMatch = trimmed.match(
        /^(.+)?@(.+?):(\d+)(?::(\d+))?$/
      );
      if (jsFfMatch) {
        const fn = jsFfMatch[1] || '<anonymous>';
        const filePath = jsFfMatch[2];
        // Exclude lines that look like Java "at" or Python
        if (!trimmed.startsWith('at ') && !trimmed.startsWith('File ')) {
          frame = {
            fn: fn.trim(),
            file: filePath,
            line: parseInt(jsFfMatch[3], 10),
            col: jsFfMatch[4] ? parseInt(jsFfMatch[4], 10) : null,
            raw: trimmed,
            lang: 'javascript'
          };
        }
      }
    }

    if (frame) {
      frames.push(frame);
    }
  }

  return frames;
}

function detectLanguage(text) {
  if (/^\s*at\s+[\w.$]+\([\w.$]+\.(?:java|kt|scala):\d+\)/m.test(text)) return 'java';
  if (/^\s*File\s+"/m.test(text)) return 'python';
  if (/^\s*at\s+[\w.<>]+\(?[^)]*\)?\s+in\s+.+:line\s+\d+/m.test(text)) return 'dotnet';
  if (/^\s*at\s+/m.test(text)) {
    // Could be JS V8 or Java without file extension — check for JS patterns
    if (/at\s+.*\(.*:(\d+):(\d+)\)/m.test(text)) return 'javascript';
    if (/at\s+.*\(.*\.(?:java|kt|scala)/m.test(text)) return 'java';
    // Default to java for "at" patterns with no clear JS marker
    if (/at\s+.*\(Unknown Source\)/m.test(text) || /at\s+.*\(Native Method\)/m.test(text)) return 'java';
    return 'java';
  }
  if (/@.*:\d+:\d+/m.test(text)) return 'javascript';
  return 'unknown';
}

/* ── API ── */

app.post('/api/parse', (req, res) => {
  try {
    const input = typeof req.body === 'object' && req.body.text ? req.body.text : req.body;
    const frames = parseStackTrace(input);
    const lang = frames.length > 0 ? frames[0].lang : detectLanguage(input);
    // Separate exception header lines from frames
    const exceptionLine = extractExceptionLine(input);
    res.json({
      ok: true,
      language: lang,
      exception: exceptionLine,
      frameCount: frames.length,
      frames
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

function extractExceptionLine(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Java exception header
    if (/^[\w.]+(Exception|Error|Throwable)/.test(trimmed)) return trimmed;
    // Python exception
    if (/^Traceback\s/.test(trimmed)) return trimmed;
    if (/^\w+Error:/.test(trimmed) || /^\w+Exception:/.test(trimmed)) return trimmed;
  }
  return null;
}

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// SPA fallback — serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Start ── */

const PORT = process.env.PORT || 4599;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LogSniffer running on http://0.0.0.0:${PORT}`);
});

module.exports = { app, parseStackTrace, detectLanguage, extractExceptionLine };
