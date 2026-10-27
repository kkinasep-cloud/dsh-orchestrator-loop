/**
 * dsh-orchestrator-loop — shared primitives.
 *
 * Low-level helpers only: paths, ids, JSON/IO, path containment, report
 * parsing, and small formatters. Domain logic lives in loop.js; the tool
 * surface lives in index.js.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Plugin version reported in status.json and in the tool descriptions. */
export const VERSION = '0.6.0'

/** Config keys and their built-in defaults (identical to cordis.patch.yml). */
export const DEFAULTS = Object.freeze({
  maxTasksPerRound: 3,
  maxSelfTasksPerRound: 1,
  // Preview only: the full report always lands in reports/<task>_a<n>.md, so the
  // ledger keeps a 300-char head plus the file pointer instead of 2000 chars
  // (that copy was 34.8% of a real 850 KB ledger).
  reportKeepChars: 300,
  taskHistoryKeep: 5,
  minReportChars: 400,
  staleMinutes: 120,
  budgetMinutes: 0,
  maxRetries: 2,
  contextMode: 'memo',
  resumeAgents: true,
  workRoot: '',
  tidyMaxFiles: 2000,
})

/** Sub-folders created under every loop folder. */
export const SUBDIRS = Object.freeze({
  artifacts: 'artifacts',
  reports: 'reports',
  notes: 'notes',
})

/** Report sections a subagent must send back, in order. */
export const SECTIONS = Object.freeze([
  '结论',
  '做了什么',
  '产物',
  '证据',
  '未决问题',
  '建议下一步',
])

/** Folder names exempt from the unregistered-output audit. */
export const AUDIT_EXEMPT_DIRS = Object.freeze(['reports', 'notes'])

/* ------------------------------------------------------------------ time -- */

export function nowIso() {
  return new Date().toISOString()
}

/** Loop ids look like `Lmvdnlm0u`: `L` + a base36 millisecond stamp. */
export function newLoopId() {
  return `L${Date.now().toString(36)}`
}

export function minutesBetween(from, to) {
  const a = Date.parse(from ?? '')
  const b = Date.parse(to ?? '')
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0
  return Math.round(((b - a) / 60000) * 10) / 10
}

/* ----------------------------------------------------------------- paths -- */

export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Ledger, summaries and status live beside the plugin's runtime state. */
export function storePaths(home = resolveHome()) {
  const dir = join(home, 'plugins', 'orchestrator-loop')
  return {
    dir,
    file: join(dir, 'loops.json'),
    summaries: join(dir, 'summaries'),
    status: join(dir, 'status.json'),
  }
}

export function toPosix(value) {
  return String(value).replaceAll('\\', '/')
}

/** True when `target` is `root` or lies below it. */
export function isInside(root, target) {
  if (!root) return false
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Path relative to the loop folder, always with forward slashes. */
export function relativeTo(root, target) {
  return toPosix(relative(resolve(root), resolve(target)))
}

/** Resolve a reported artifact path against the loop folder. */
export function resolveArtifact(root, reported) {
  const raw = String(reported ?? '').trim()
  if (raw.length === 0) return ''
  return isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
}

/* ----------------------------------------------------------------- error -- */

/**
 * Expected, user-facing failure (bad args, closed loop, corrupt ledger…).
 * The tool layer renders these as `⚠️ …` text instead of throwing at the host.
 * Lives here so both `store.js` and `loop.js` can raise it without a cycle.
 */
export class LoopError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LoopError'
  }
}

/* -------------------------------------------------------------------- io -- */

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Read JSON without hiding damage.
 *
 * Returns `{status:'missing'}` when the file is absent, `{status:'ok', value}`
 * when it parses, and `{status:'corrupt', error}` when it exists but cannot be
 * read or parsed. Callers must never treat `corrupt` as an empty document.
 */
export function readJsonStrict(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' }
    return { status: 'corrupt', error: String(error?.message ?? error) }
  }
  if (text.trim().length === 0) return { status: 'corrupt', error: '文件是空的（0 字节或只有空白）' }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch (error) {
    return { status: 'corrupt', error: String(error?.message ?? error), bytes: text.length }
  }
}

/** Copy a damaged file aside before anything overwrites it. */
export function backupFile(file, tag = 'corrupt') {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const target = `${file}.${tag}-${stamp}`
  copyFileSync(file, target)
  return target
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * Every JSON artefact goes through here, so the format is decided once.
 * Compact (no indentation) is safe because nothing reads these files by eye:
 * `readJson`/`readJsonStrict` both `JSON.parse` them, and pretty-printing only
 * added 10.5% to a real 850 KB ledger.
 */
export function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value)}\n`)
}

/**
 * R7: same bytes as `writeJson`, but skips the write when the file already
 * holds exactly this text. `status.json` is a projection rebuilt on every save,
 * and most saves do not change it — skipping leaves its mtime intact for UI
 * pollers that watch the file instead of diffing its content.
 */
export function writeJsonIfChanged(file, value) {
  const text = `${JSON.stringify(value)}\n`
  try {
    if (readFileSync(file, 'utf8') === text) return false
  } catch {
    // Missing or unreadable: fall through and write.
  }
  atomicWrite(file, text)
  return true
}

export function writeText(file, text) {
  atomicWrite(file, text)
}

export function fileExists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/** True only for an existing directory (a path that is a file does not count). */
export function dirExists(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Per-directory listing cache backing `scanTree`.
 *
 * Invalidation (all three must hold for a hit):
 *  1. the directory's own `mtimeMs` is unchanged,
 *  2. the entry-name signature is unchanged (same names, same order),
 *  3. the entry is younger than `SCAN_CACHE_TTL_MS`.
 * Adding, removing or renaming anything in a directory bumps (1) and (2); an
 * in-place rewrite of an existing file only bumps (3), which is why the TTL is
 * the backstop. `clearScanCache()` drops everything.
 */
const SCAN_CACHE_TTL_MS = 5000
const SCAN_CACHE_MAX_DIRS = 4096
const scanCache = new Map()

/** Drop every cached directory listing (tests, and callers that just wrote). */
export function clearScanCache() {
  scanCache.clear()
}

function readDirSignature(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const names = entries.map((entry) => entry.name)
  return { entries, names, signature: names.join('\u0000') }
}

/**
 * Walk a directory, skipping dot-files and dot-directories.
 * Stops after `maxFiles` entries and reports the overflow instead of grinding.
 */
export function scanTree(root, maxFiles = 2000) {
  const files = []
  let overflow = false
  const now = Date.now()
  const walk = (dir) => {
    if (overflow) return
    const listing = readDirSignature(dir)
    if (listing === undefined) return
    const { entries, names, signature } = listing
    const cached = scanCache.get(dir)
    if (cached !== undefined
      && cached.signature === signature
      && now - cached.at < SCAN_CACHE_TTL_MS
      && (cached.mtimeMs === undefined || cached.mtimeMs === dirMtimeMs(dir))) {
      for (const entry of entries) {
        if (overflow) return
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.isFile()) continue
        if (files.length >= maxFiles) {
          overflow = true
          return
        }
        const known = cached.files.get(entry.name)
        if (known === undefined) {
          const stat = safeStat(full)
          if (stat === undefined) continue
          files.push({ path: relativeTo(root, full), ...stat })
          continue
        }
        files.push({ path: relativeTo(root, full), ...known })
      }
      return
    }
    const mtimeMs = dirMtimeMs(dir)
    const fresh = new Map()
    for (const entry of entries) {
      if (overflow) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        overflow = true
        return
      }
      const stat = safeStat(full)
      if (stat === undefined) continue
      fresh.set(entry.name, stat)
      files.push({ path: relativeTo(root, full), ...stat })
    }
    if (scanCache.size >= SCAN_CACHE_MAX_DIRS) scanCache.clear()
    scanCache.set(dir, { signature, mtimeMs, at: now, files: fresh })
  }
  walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, overflow }
}

function dirMtimeMs(dir) {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return undefined
  }
}

function safeStat(full) {
  try {
    const stat = statSync(full)
    return { size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() }
  } catch {
    return undefined
  }
}

/* --------------------------------------------------------------- reports -- */

const TASK_MARKER = /^\s*TASK\s*[:：]\s*([A-Za-z0-9_-]+)\s*$/m

/** Task id from a `TASK: t1-1` first line, or undefined. */
export function parseTaskMarker(text) {
  const match = TASK_MARKER.exec(String(text ?? ''))
  return match?.[1]
}

function normalizeHeading(text) {
  return String(text ?? '')
    .trim()
    .replace(/^[\s#*]+/, '')
    .replace(/[：:。.\s]+$/, '')
}

/** Which of the six required sections appear in a report. */
export function parseSections(report) {
  const found = new Set()
  for (const line of String(report ?? '').split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const title = normalizeHeading(heading[1])
      for (const section of SECTIONS) {
        if (title === section || title.startsWith(section)) found.add(section)
      }
      continue
    }
    const inline = /^\s*(?:[-*]\s*)?([^\s：:]{1,10})\s*[：:]/.exec(line)
    if (inline) {
      const title = normalizeHeading(inline[1])
      for (const section of SECTIONS) {
        if (title === section) found.add(section)
      }
    }
  }
  return {
    present: SECTIONS.filter((section) => found.has(section)),
    missing: SECTIONS.filter((section) => !found.has(section)),
  }
}

/** Section body text with its heading stripped. */
export function sectionBody(report, section) {
  const collected = []
  let active = false
  for (const line of String(report ?? '').split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const title = normalizeHeading(heading[1])
      active = title === section || title.startsWith(section)
      if (active) {
        const rest = title.slice(section.length).trim()
        if (rest.length > 0) collected.push(rest)
      }
      continue
    }
    const inline = /^\s*(?:[-*]\s*)?([^\s：:]{1,10})\s*[：:]\s*(.*)$/.exec(line)
    if (inline && normalizeHeading(inline[1]) === section) {
      active = true
      collected.push(inline[2])
      continue
    }
    if (active && line.trim().length > 0) collected.push(line)
  }
  return collected.join('\n').trim()
}

/** One-line conclusion: the 结论 body, else the first substantive line. */
export function deriveSummary(report, fallback = '') {
  const body = sectionBody(report, '结论')
  const source = body.length > 0 ? body : String(report ?? '')
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*-]+/, '').trim()
    if (line.length === 0) continue
    if (/^\s*TASK\s*[:：]/i.test(line)) continue
    if (/^#{1,6}\s/.test(line)) continue
    return line.length > 240 ? `${line.slice(0, 240)}…` : line
  }
  return fallback
}

const BACKTICK_PATH = /`([^`\n]{1,200})`/g
const WINDOWS_PATH = /(?:^|[\s(（])([A-Za-z]:[\\/][^\s，。；、)）]+)/g
const RELATIVE_PATH = /(?:^|[\s(（])((?:\.{0,2}\/)?[\w.\u4e00-\u9fa5-]+(?:\/[\w.\u4e00-\u9fa5-]+)*\.[A-Za-z0-9]{1,8})/g

// `v2.3`, `12.5`, `1.0` and `3.14` are versions/measurements, not files. A real
// artifact either carries a directory separator or ends in a known-ish
// extension that contains at least one letter.
const FILE_EXTENSION = /^[A-Za-z][A-Za-z0-9]{0,7}$/
const VERSION_LIKE = /^v?\d+(?:\.\d+)+$/iu
const KNOWN_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'jsonl', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'log',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'ps1', 'sh',
  'bat', 'cmd', 'sql', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'tgz', '7z', 'rar',
  'tar', 'exe', 'dll', 'so', 'dylib', 'wasm', 'map', 'lock', 'env', 'diff', 'patch',
])

/** Does this token plausibly name a file on disk? */
function looksLikePath(token) {
  const value = String(token ?? '').trim()
  if (value.length === 0) return false
  if (/^https?:/iu.test(value)) return false
  if (VERSION_LIKE.test(value)) return false
  const hasSeparator = /[\\/]/u.test(value)
  const ext = /\.([A-Za-z0-9]{1,8})$/u.exec(value)?.[1] ?? ''
  if (!FILE_EXTENSION.test(ext)) return false
  if (KNOWN_EXTENSIONS.has(ext.toLowerCase())) return true
  // Unknown extension: only trust it when it is clearly a path.
  return hasSeparator
}

/** Path-looking tokens from the 产物 section (empty when that section is absent). */
export function extractArtifacts(report) {
  const body = sectionBody(report, '产物')
  if (body.length === 0) return []
  const out = new Set()
  for (const match of body.matchAll(BACKTICK_PATH)) out.add(match[1].trim())
  for (const match of body.matchAll(WINDOWS_PATH)) out.add(match[1].trim())
  for (const match of body.matchAll(RELATIVE_PATH)) out.add(match[1].trim())
  return [...out].filter((value) => {
    if (value.length === 0) return false
    if (/^https?:/iu.test(value)) return false
    // Backticked/WINDOWS tokens are explicit; the relative scan is the noisy one.
    if (value.length <= 1) return false
    return looksLikePath(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('`')
  })
}

/* ----------------------------------------------------------- formatting -- */

export function formatBytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function bulletList(items, empty = '无') {
  if (!Array.isArray(items) || items.length === 0) return `- ${empty}`
  return items.map((item) => `- ${item}`).join('\n')
}

export function uniqueStrings(list) {
  const seen = new Set()
  const out = []
  for (const raw of list ?? []) {
    const value = String(raw ?? '').trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  const int = Math.trunc(num)
  if (int < min) return min
  if (int > max) return max
  return int
}
