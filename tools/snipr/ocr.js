'use strict';

// Text from a snip, Windows only. Uses the OCR engine that ships with
// Windows 10 / 11 (Windows.Media.Ocr, the one PowerToys' Text Extractor uses),
// reached through Windows PowerShell 5.1, which every Windows 10 / 11 machine
// has. Nothing to install, nothing leaves the machine.
//
// The engine gives words with their boxes, in no useful order (a right-hand
// column comes after the whole left one). layout() puts them back the way they
// sat on screen: rows top to bottom, columns lined up, indentation kept (code),
// a blank line between paragraphs.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const available = process.platform === 'win32';

// Small UI text reads far better enlarged: "quit snipr" comes back as "smpr"
// at 1x and right at 2x. The engine's limit is 10000 px a side.
const MAX_SIDE = 10000;
const upscale = (width, height, scale) => {
  const want = scale >= 2 ? 1 : 2;
  return Math.max(1, Math.min(want, MAX_SIDE / Math.max(width, height)));
};

// Reads $env:SNIPR_OCR_IN (a png), scales it by $env:SNIPR_OCR_SCALE and
// prints one word per line, "line<TAB>x<TAB>y<TAB>w<TAB>h<TAB>text", as base64
// UTF-8 so no console code page can mangle it. "ERR <message>" on failure.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) {
    $lang = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)[0]
    if ($lang -eq $null) { [Console]::Out.Write('ERR no-language'); exit 2 }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SNIPR_OCR_IN)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $k = [double]$env:SNIPR_OCR_SCALE
    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tf.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($dec.PixelWidth * $k))
    $tf.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($dec.PixelHeight * $k))
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose() }

  $sb = New-Object System.Text.StringBuilder
  $i = 0
  foreach ($line in $res.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $null = $sb.Append($i).Append("${'`'}t").Append([int]$r.X).Append("${'`'}t").Append([int]$r.Y).Append("${'`'}t").Append([int]$r.Width).Append("${'`'}t").Append([int]$r.Height).Append("${'`'}t").Append($w.Text).Append("${'`'}n")
    }
    $i++
  }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sb.ToString())))
} catch {
  [Console]::Out.Write('ERR ' + $_.Exception.Message)
  exit 1
}
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function run(file, scale, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], {
      windowsHide: true,
      env: { ...process.env, SNIPR_OCR_IN: file, SNIPR_OCR_SCALE: String(scale) },
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('ocr timed out')); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      out = out.trim();
      if (out.startsWith('ERR ')) return reject(new Error(out.slice(4)));
      if (!/^[A-Za-z0-9+/=]*$/.test(out)) return reject(new Error('ocr: ' + (err || out).slice(0, 300)));
      resolve(Buffer.from(out, 'base64').toString('utf8'));
    });
  });
}

// png buffer -> [{ words: [{ text, x, y, w, h }] }], in the image's own pixels
async function recognize(png, { width, height, scale = 1 } = {}) {
  if (!available) throw new Error('ocr is windows only');
  const k = upscale(width || 1, height || 1, scale);
  const dir = path.join(os.tmpdir(), 'snipr');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ocr-' + crypto.randomBytes(6).toString('hex') + '.png');
  fs.writeFileSync(file, png);
  let raw;
  try { raw = await run(file, k); } finally { try { fs.unlinkSync(file); } catch (_) {} }
  const lines = [];
  for (const row of raw.split('\n')) {
    const p = row.split('\t');
    if (p.length < 6) continue;
    const i = +p[0];
    const text = p.slice(5).join('\t').trim();
    if (!text) continue;
    (lines[i] = lines[i] || { words: [] }).words.push({ text, x: +p[1] / k, y: +p[2] / k, w: +p[3] / k, h: +p[4] / k });
  }
  return lines.filter(Boolean);
}

// ---------------------------------------------------------------------------
// layout: words back into text that looks like the snip
// ---------------------------------------------------------------------------

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const BULLET = /^[•●▪◦‣■□➢►▸-]$/;

function layout(lines, eol = '\n') {
  // the engine's lines, each a run of words on one baseline
  const segs = [];
  for (const l of lines) {
    const ws = (l.words || []).filter((w) => w.text && w.w > 0 && w.h > 0);
    if (!ws.length) continue;
    const y0 = Math.min(...ws.map((w) => w.y)), y1 = Math.max(...ws.map((w) => w.y + w.h));
    segs.push({ words: ws, y0, y1 });
  }
  if (!segs.length) return '';

  // one character's width, for turning gaps and indents into spaces: the
  // snip's typical one (indents, columns) and each line's own (word gaps, so a
  // bigger font's ordinary spaces don't look wide)
  const charW = (ws) => median(ws.filter((w) => [...w.text].length >= 2).map((w) => w.w / [...w.text].length));
  const cw = charW(segs.flatMap((s) => s.words)) || median(segs.flatMap((s) => s.words.map((w) => w.h))) * 0.55 || 8;
  for (const s of segs) {
    const own = charW(s.words) || cw;
    for (const w of s.words) w.cw = own;
  }

  // segments that share a band of height are one row (the engine splits
  // columns into separate lines: "auto save" and its "off" far to the right)
  segs.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows = [];
  for (const s of segs) {
    let best = null, bestOver = 0;
    for (const r of rows) {
      const over = Math.min(r.y1, s.y1) - Math.max(r.y0, s.y0);
      const need = 0.5 * Math.min(r.y1 - r.y0, s.y1 - s.y0);
      if (over > need && over > bestOver) { best = r; bestOver = over; }
    }
    if (best) {
      best.words.push(...s.words);
      best.y0 = Math.min(best.y0, s.y0);
      best.y1 = Math.max(best.y1, s.y1);
    } else rows.push({ words: [...s.words], y0: s.y0, y1: s.y1 });
  }
  rows.sort((a, b) => a.y0 - b.y0);

  const left = Math.min(...rows.map((r) => Math.min(...r.words.map((w) => w.x))));
  const col = (x) => Math.max(0, Math.round((x - left) / cw));

  // a row: words in x order. A normal word gap is one space; a wide one
  // (columns, aligned code) pads out to where that word sits on screen.
  const texts = rows.map((r) => {
    const ws = r.words.sort((a, b) => a.x - b.x);
    const first = ws[0];
    const indent = first.x - left > 0.6 * cw ? col(first.x) : 0;
    let line = ' '.repeat(indent);
    let end = first.x;
    ws.forEach((w, i) => {
      if (i > 0) {
        const gap = w.x - end;
        const n = gap > 1.8 * Math.max(w.cw, ws[i - 1].cw) ? Math.max(2, col(w.x) - [...line].length) : 1;
        line += ' '.repeat(n);
      }
      line += w.text;
      end = Math.max(end, w.x + w.w);
    });
    // a bullet glyph on its own at the start of a row -> "- "
    const m = /^(\s*)(\S+)(\s+)/.exec(line);
    if (m && BULLET.test(m[2])) line = m[1] + '- ' + line.slice(m[0].length);
    return line.replace(/\s+$/, '');
  });

  // a blank line where the gap between rows is clearly bigger than usual
  const hMed = median(rows.map((r) => r.y1 - r.y0));
  const gaps = rows.slice(1).map((r, i) => r.y0 - rows[i].y1);
  const gMed = median(gaps);
  const out = [texts[0]];
  gaps.forEach((g, i) => {
    if (g > 2.5 * hMed || (g > 0.8 * hMed && g > 1.6 * gMed)) out.push('');
    out.push(texts[i + 1]);
  });
  return out.join(eol);
}

// png -> { text, lines } ready for the clipboard
async function textOf(png, size) {
  const lines = await recognize(png, size);
  const text = layout(lines, process.platform === 'win32' ? '\r\n' : '\n');
  return { text, lines: text ? text.split(/\r?\n/).filter((l) => l.trim()).length : 0 };
}

module.exports = { available, recognize, layout, textOf, upscale };
