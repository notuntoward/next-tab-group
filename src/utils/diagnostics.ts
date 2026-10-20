import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { isLeafDetached } from 'commons/workspace';

/**
 * Flight recorder for diagnosing Obsidian freezes.
 *
 * Every line is written SYNCHRONOUSLY (appendFileSync) so that the last line
 * on disk is the last thing that happened before a hang, even if the renderer
 * never returns to its event loop. After a freeze + restart, read the end of
 * the previous session in the log: an `BEGIN x` with no matching `END x` shows
 * which operation was in flight, and trailing events show what Obsidian was
 * doing. `STALL` lines show main-thread blocks that eventually recovered.
 */

const MAX_BYTES = 2 * 1024 * 1024;

export class DiagLog {
    private seq = 0;
    private ok = true;
    private lastSignature = '';
    private repeats = 0;
    private reported = 0;
    readonly session = Math.random().toString(36).slice(2, 7);

    constructor(private readonly path: string | null) {
        if (!path) return;
        try {
            mkdirSync(dirname(path), { recursive: true });
            try {
                if (statSync(path).size > MAX_BYTES) renameSync(path, path + '.1');
            } catch {
                // no existing log
            }
        } catch {
            this.ok = false;
        }
    }

    get filePath(): string | null {
        return this.path;
    }

    log(tag: string, msg: string, data?: unknown): void {
        if (!this.ok || !this.path) return;
        let extra = '';
        if (data !== undefined) {
            try {
                extra = ' ' + JSON.stringify(data);
            } catch {
                extra = ' <unserializable>';
            }
        }
        // Collapse back-to-back identical records (e.g. tens of thousands of
        // "ResizeObserver loop" errors in a layout storm) into the first line
        // plus a REPEAT summary at the next different record and at counts of
        // 10, 100, 1000, ... so a freeze mid-storm still leaves a count.
        const signature = `${tag} ${msg}${extra}`;
        if (signature === this.lastSignature) {
            this.repeats++;
            if (/^10+$/.test(String(this.repeats))) this.writeRepeat();
            return;
        }
        this.flushRepeats();
        this.lastSignature = signature;
        this.write(signature);
    }

    private writeRepeat(): void {
        this.write(`REPEAT previous record x${this.repeats} so far (identical, suppressed)`);
        this.reported = this.repeats;
    }

    private flushRepeats(): void {
        if (this.repeats === 1) this.write(this.lastSignature);
        else if (this.repeats > 1 && this.reported !== this.repeats) this.writeRepeat();
        this.repeats = 0;
        this.reported = 0;
    }

    private write(body: string): void {
        try {
            appendFileSync(this.path as string, `${new Date().toISOString()} [${this.session}#${++this.seq}] ${body}\n`);
        } catch {
            this.ok = false;
        }
    }

    /** Logs BEGIN now and returns a function that logs END with duration. */
    begin(op: string, data?: unknown): (result?: unknown) => void {
        const start = Date.now();
        const key = ++this.opId;
        this.inflight.set(key, op);
        this.log('BEGIN', op, data);
        return (result?: unknown) => {
            this.inflight.delete(key);
            this.log('END', op, { ms: Date.now() - start, result });
        };
    }

    private opId = 0;
    private readonly inflight = new Map<number, string>();
    lastEvent = '';

    /** Short description of what the plugin was doing, for the watchdog. */
    context(): string {
        return `inflight=[${[...this.inflight.values()].join('; ')}] lastEvent=${this.lastEvent}`;
    }
}


/** Structural summary of the live layout tree plus any suspicious shapes. */
export function summarizeLayout(workspace: any): { text: string; anomalies: string[] } {
    const anomalies: string[] = [];
    const seen = new Set<unknown>();

    const walk = (node: any, parent: any, depth: number): string => {
        if (!node) return 'null';
        if (depth > 40) {
            anomalies.push('depth>40');
            return '...';
        }
        if (seen.has(node)) {
            anomalies.push('duplicate-or-cyclic');
            return 'DUP';
        }
        seen.add(node);
        if (parent && node.parent !== parent) anomalies.push(`parent-mismatch@${depth}`);

        const children = Array.isArray(node.children) ? node.children : null;
        if (!children) {
            let vt = '?';
            try {
                vt = node.view?.getViewType?.() ?? '?';
            } catch {
                // view mid-teardown
            }
            return `L(${vt}${isLeafDetached(node) ? ',detached' : ''})`;
        }
        const dir = typeof node.direction === 'string' ? node.direction[0] : '';
        if (children.length === 0) anomalies.push(`empty-${node.type}@${depth}`);
        if (dir && typeof parent?.direction === 'string' && parent.direction === node.direction) {
            anomalies.push(`same-direction-nesting@${depth}`);
        }
        return `${node.type}${dir ? ':' + dir : ''}[${children.map((c: any) => walk(c, node, depth + 1)).join(',')}]`;
    };

    const parts: string[] = [];
    try {
        for (const key of ['rootSplit', 'leftSplit', 'rightSplit', 'floatingSplit']) {
            parts.push(`${key}=${walk(workspace?.[key], null, 0)}`);
        }
    } catch (e) {
        anomalies.push(`summarize-threw:${String(e)}`);
    }
    return { text: parts.join(' '), anomalies };
}

/**
 * Out-of-process freeze detector. A hung renderer cannot log about itself, so
 * a PowerShell process (Obsidian's binary cannot run as plain Node: the
 * RunAsNode fuse is off) watches a heartbeat file the plugin rewrites every
 * second. If it goes stale while the window is visible, the watcher appends a
 * FREEZE report to the log: what the plugin was doing, plus per-process CPU
 * deltas over 2 s and Windows' own "Responding" verdict (busy loop = high CPU
 * delta; deadlock/blocked I/O = ~0). Hidden windows are exempt: Chromium
 * throttles their timers to ~1/minute, which would look like a freeze.
 * Windows only; silently disabled elsewhere.
 */
export const DEBUG_PORT = 9222;
const WATCHDOG_PS = `
$hb = '__HB__'; $log = '__LOG__'; $parentPid = __PID__
$frozenSince = $null; $lastReport = 0
function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [watchdog] ' + $m) }
function NowMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$script:cdpNote = $false
$script:conns = @{}
$script:lastScan = 0
$none = [Threading.CancellationToken]::None
function CdpSend($c, $json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $c.ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, $none).GetAwaiter().GetResult()
}
# Returns the complete messages received so far, waiting at most waitMs for the first one.
function CdpPoll($c, [int]$waitMs) {
  $out = @()
  try {
    while ($true) {
      if (-not $c.recv) { $c.buf = New-Object byte[] 65536; $c.recv = $c.ws.ReceiveAsync([ArraySegment[byte]]$c.buf, $none) }
      if (-not $c.recv.Wait($waitMs)) { break }
      $r = $c.recv.Result; $c.recv = $null
      if ($r.MessageType -eq 'Close') { $c.dead = $true; break }
      $c.text += [Text.Encoding]::UTF8.GetString($c.buf, 0, $r.Count)
      if ($r.EndOfMessage) { $out += $c.text; $c.text = '' }
      $waitMs = 0
    }
  } catch { $c.dead = $true }
  return ,$out
}
# Attach to every page while Obsidian is still healthy: a hung page cannot accept a NEW debugger session,
# but an already-attached session can still interrupt a busy loop with Debugger.pause.
function CdpScan {
  $script:lastScan = NowMs
  $targets = $null
  try { $targets = Invoke-RestMethod -Uri 'http://127.0.0.1:__PORT__/json' -TimeoutSec 2 } catch {
    if (-not $script:cdpNote) { Log 'no debugger port: start Obsidian with --remote-debugging-port=__PORT__ to capture the looping stack'; $script:cdpNote = $true }
    return
  }
  foreach ($k in @($script:conns.Keys)) { if ($script:conns[$k].dead) { $script:conns.Remove($k) } }
  foreach ($t in @($targets | Where-Object { ($_.type -eq 'page' -or $_.type -eq 'node') -and $_.webSocketDebuggerUrl })) {
    if ($script:conns.ContainsKey($t.id)) { continue }
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource 5000
    try {
      $ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
      $c = @{ ws = $ws; recv = $null; buf = $null; text = ''; dead = $false; title = $t.title }
      CdpSend $c '{"id":1,"method":"Debugger.enable"}'
      $script:conns[$t.id] = $c
      Log ('debugger attached to page "' + $t.title + '"')
    } catch { try { $ws.Dispose() } catch {} }
  }
}
# Keep sockets drained; resume if something other than us paused the page (e.g. a debugger statement).
function CdpDrain {
  foreach ($k in @($script:conns.Keys)) {
    $c = $script:conns[$k]
    foreach ($m in (CdpPoll $c 0)) {
      if ($m.Contains('"method":"Debugger.paused"')) { try { CdpSend $c '{"id":4,"method":"Debugger.resume"}' } catch {} }
    }
  }
}
function CdpStacks {
  if ($script:conns.Count -eq 0) { Log 'no debugger session was attached before the freeze, so no stack is available'; return }
  foreach ($k in @($script:conns.Keys)) {
    $c = $script:conns[$k]
    for ($n = 1; $n -le 3; $n++) {
      try {
        CdpSend $c '{"id":2,"method":"Debugger.pause"}'
        $found = $false
        for ($i = 0; $i -lt 40 -and -not $found; $i++) {
          foreach ($m in (CdpPoll $c 250)) {
            if ($m.Contains('"method":"Debugger.paused"')) {
              $found = $true
              $o = $m | ConvertFrom-Json
              $frames = @($o.params.callFrames | Select-Object -First 15 | ForEach-Object { '  at ' + $_.functionName + ' ' + $_.url + ':' + ($_.location.lineNumber + 1) + ':' + ($_.location.columnNumber + 1) })
              Log ('STACK ' + $n + ' of page "' + $c.title + '"' + [Environment]::NewLine + ($frames -join [Environment]::NewLine))
              CdpSend $c '{"id":3,"method":"Debugger.resume"}'
            }
          }
        }
        if (-not $found) { Log ('page "' + $c.title + '": pause not delivered within 10s (main thread not running JS?)'); break }
      } catch { Log ('stack capture failed for "' + $c.title + '": ' + $_.Exception.Message); $c.dead = $true; break }
      Start-Sleep -Milliseconds 700
    }
  }
}
Log ('started pid=' + $PID + ' watching renderer pid=' + $parentPid)
while ($true) {
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {
    if ($frozenSince) { Log 'renderer process is gone while frozen (killed?)' } else { Log 'renderer process exited' }
    break
  }
  try { $parts = ([IO.File]::ReadAllText($hb)).Split('|', 3) } catch { continue }
  if ($parts.Count -lt 3) { continue }
  $age = ((NowMs) - [int64]$parts[0]) / 1000
  if ($parts[1] -ne 'visible') { $frozenSince = $null; continue }
  if ($age -le 8) {
    CdpDrain
    if (((NowMs) - $script:lastScan) -gt 15000) { CdpScan }
    if ($frozenSince) { Log ('FREEZE ENDED, heartbeat resumed after ' + [int]((NowMs) - $frozenSince) / 1000 + 's') ; $frozenSince = $null }
    continue
  }
  if (-not $frozenSince) { $frozenSince = [int64]$parts[0] }
  if (((NowMs) - $lastReport) -lt 20000) { continue }
  Log ('FREEZE DETECTED: no heartbeat for ' + [int]$age + 's while visible. ctx: ' + $parts[2])
  $a = Get-Process Obsidian -ErrorAction SilentlyContinue | Select-Object Id, CPU, Responding, @{n='MB';e={[int]($_.WorkingSet64/1MB)}}, @{n='Thr';e={$_.Threads.Count}}, @{n='Prio';e={$_.PriorityClass}}
  Start-Sleep -Seconds 2
  $b = Get-Process Obsidian -ErrorAction SilentlyContinue
  $lines = $a | ForEach-Object { $x = $_; $y = $b | Where-Object { $_.Id -eq $x.Id }; 'pid=' + $x.Id + ' cpuDelta2s=' + [math]::Round($y.CPU - $x.CPU, 2) + ' responding=' + $x.Responding + ' MB=' + $x.MB + ' threads=' + $x.Thr + ' prio=' + $x.Prio }
  Log ("process sample:\`n" + ($lines -join "\`n"))
  CdpStacks
  $lastReport = NowMs
}
`;

export class FreezeWatchdog {
    private child: any = null;
    private cancelHeartbeat: (() => void) | null = null;

    start(logPath: string, heartbeatPath: string, getContext: () => string, onProblem: (m: string) => void, win: Window): void {
        if (process.platform !== 'win32') return;
        const script = WATCHDOG_PS.replace('__HB__', heartbeatPath.replace(/'/g, "''"))
            .replace('__LOG__', logPath.replace(/'/g, "''"))
            .replace('__PID__', String(process.pid))
            .split('__PORT__').join(String(DEBUG_PORT));
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            stdio: 'ignore',
            windowsHide: true,
        });
        this.child.on('error', (e: Error) => onProblem(`watchdog spawn error: ${e.message}`));
        this.child.on('exit', (code: number) => onProblem(`watchdog exited code=${code}`));
        const beat = () => {
            try {
                writeFileSync(
                    heartbeatPath,
                    `${Date.now()}|${win.document.visibilityState}|${getContext().replace(/\|/g, '/')}`,
                );
            } catch {
                // ignore
            }
        };
        beat();
        const timer = win.setInterval(beat, 1000);
        this.cancelHeartbeat = () => win.clearInterval(timer);
    }

    stop(): void {
        this.cancelHeartbeat?.();
        this.cancelHeartbeat = null;
        try {
            this.child?.kill();
        } catch {
            // already gone
        }
        this.child = null;
    }
}
