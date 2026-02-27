import path from 'path';
import process from 'process';
import cp from 'child_process';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import os from 'os';
import readline from 'readline';

const inputArgs = process.argv.slice(2);

// =============================================
// Constants
// =============================================

/** Port for the persistent VRCVidFix service control API. */
const VIDFIX_SERVICE_PORT = 6419;
/** Starting port for HLS stream servers. */
const VidFixStartPort = 6420;
/** Timeout for idle streams (ms). */
const VidFixStreamProcessTimeout = 60000;
/** HLS segment duration (seconds). */
const HLS_SEGMENT_DURATION = 6;

// VRCVidFix watcher / service constants
const VIDFIX_TASK_NAME = 'VRCVidFix';
const VIDFIX_SAFE_DIR = path.join(os.homedir(), '.vrcvidfix');
const VIDFIX_SAFE_EXE = path.join(VIDFIX_SAFE_DIR, 'vrcvidfix.exe');
const VRCHAT_YTDLP_PATH = path.join(
  os.homedir(), 'AppData', 'LocalLow', 'VRChat', 'VRChat', 'Tools', 'yt-dlp.exe'
);

// Service dependencies — all stored in the safe directory alongside the service exe.
const SERVICE_DEPS_DIR = VIDFIX_SAFE_DIR;
const SERVICE_YTDLP_PATH = path.join(SERVICE_DEPS_DIR, 'yt-dlp-original.exe');
const SERVICE_FFMPEG_PATH = path.join(SERVICE_DEPS_DIR, 'ffmpeg.exe');

/** Local temp directory for downloads and HLS segments. */
const localTmpDir = path.join(SERVICE_DEPS_DIR, '.tmp');

/** Debug log file path. */
const DEBUG_LOG_PATH = path.join(SERVICE_DEPS_DIR, 'vrcvidfix-debug.log');

// =============================================
// Debug Logging
// =============================================

/** Append a timestamped line to the debug log file. */
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${msg}\n`); } catch { }
}

/**
 * Redirect all console output to debug log only (no stdout/stderr writes).
 * Launcher mode uses this so VRChat receives only the playlist URL on stdout.
 */
function enableFileOnlyLogging(): void {
  try { fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true }); } catch { }
  try { fs.writeFileSync(DEBUG_LOG_PATH, ''); } catch { }
  console.log = (...args: any[]) => { debugLog(args.map(String).join(' ')); };
  console.error = (...args: any[]) => { debugLog('[ERROR] ' + args.map(String).join(' ')); };
  console.warn = (...args: any[]) => { debugLog('[WARN] ' + args.map(String).join(' ')); };
}

// =============================================
// Global Error Handlers
// =============================================

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  debugLog(`[FATAL] Uncaught exception: ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
  debugLog(`[FATAL] Unhandled rejection: ${err}`);
});

// =============================================
// Main
// =============================================

async function main() {
  // ==================== SERVICE MODE (persistent background service) ====================
  if (inputArgs[0] === '--vidfix-service') {
    process.title = 'VRCVidFix - Service';
    await runServiceMode();
    return;
  }

  // ==================== WATCHER MODE ====================
  if (inputArgs[0] === '--vidfix-watcher') {
    process.title = 'VRCVidFix - Watcher';
    await runWatcherMode();
    return;
  }

  // ==================== DEP CHECK MODE ====================
  if (inputArgs[0] === '--vidfix-check-deps') {
    const targetDir = inputArgs[1] ? path.resolve(inputArgs[1]) : SERVICE_DEPS_DIR;
    process.title = 'vrcvidfix - Dep Update';
    console.log(`[DEPS] Starting dependency update in: ${targetDir}`);
    try {
      await runDepUpdate(targetDir);
      console.log('[DEPS] Dependency check complete.');
      process.exit(0);
    } catch (err) {
      console.error('[DEPS] Dependency update failed:', err);
      process.exit(1);
    }
    return;
  }

  // ==================== LAUNCHER MODE (thin — talks to service) ====================
  if (inputArgs.length > 0) {
    enableFileOnlyLogging();
    console.log(`[LAUNCHER] args: ${JSON.stringify(inputArgs)}`);
    console.log(`[LAUNCHER] execPath: ${process.execPath}`);
    console.log(`[LAUNCHER] cwd: ${process.cwd()}`);

    const videoUrl = extractVideoUrl(inputArgs);
    if (!videoUrl) {
      console.log("[DEBUG] Raw argv:", JSON.stringify(process.argv));
      process.exit(0);
    }

    console.log(`[LAUNCHER] Video URL: ${videoUrl}`);

    // Send the request to the persistent VRCVidFix service.
    // The service runs in a completely separate process tree (started by the
    // watcher/scheduled task), so VRChat cannot kill it when it terminates us.
    try {
      const res = await fetch(`http://127.0.0.1:${VIDFIX_SERVICE_PORT}/api/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl,
          originalArgs: inputArgs,
          cwd: process.cwd(),
        }),
        signal: AbortSignal.timeout(120_000), // yt-dlp lookup can take time
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const body = await res.json() as any; errMsg = body.error || errMsg; } catch { }
        console.error(`[LAUNCHER] Service error: ${errMsg}`);
        process.exit(1);
      }

      const body = await res.json() as any;
      const playlistUrl = body.playlistUrl;
      if (!playlistUrl) {
        console.error('[LAUNCHER] No playlistUrl in service response');
        process.exit(1);
      }

      // Output the playlist URL for VRChat to consume.
      process.stdout.write(`${playlistUrl}\n`);
      await new Promise(resolve => setTimeout(resolve, 500));
      process.exit(0);
    } catch (err: any) {
      console.error(`[LAUNCHER] Could not reach VRCVidFix service: ${err.message || err}`);
      console.error('[LAUNCHER] Make sure VRCVidFix watcher is running (it starts the service).');
      process.exit(1);
    }
  }

  // ==================== INTERACTIVE SETUP MODE (double-click / no args) ====================
  process.title = 'VRCVidFix - Setup';
  await interactiveSetup();
}

main().catch(async (err) => {
  console.error('[FATAL] main() error:', err);
  debugLog(`[FATAL] main() error: ${err?.stack || err}`);
  console.error(`[INFO] Full debug log: ${DEBUG_LOG_PATH}`);
  try { await readLine('\n[FATAL] Press ENTER to exit...'); } catch { }
  process.exit(1);
});

// =============================================
// Service Mode
// =============================================
//
// The persistent background service handles ALL heavy work:
//   - Running yt-dlp to resolve video URLs
//   - Encoding video via ffmpeg
//   - Serving HLS playlists and segments
//
// It runs in a separate process tree (started by the watcher / scheduled task)
// so VRChat's process-tree kill cannot reach it.
//
// Control API on port 6419:
//   POST /api/stream  — create a new HLS stream, returns playlist URL
//   GET  /health      — health check
//
// Each stream gets its own Bun.serve() on a dynamic port (6420+).
// =============================================

type CachedSegment = {
  data: Buffer;
  ready: boolean;
  chunks: Buffer[];
  proc: cp.ChildProcess | null;
  resolve: ((buf: Buffer) => void) | null;
  promise: Promise<Buffer>;
};

interface ActiveStream {
  hash: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  isLive: boolean;
  createdAt: number;
  ffmpegProcs: cp.ChildProcess[];
  tempDir?: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  liveEnded?: boolean;
  // VOD specific
  segmentCache?: Map<number, CachedSegment>;
  segmentCount?: number;
  totalDuration?: number;
  sourceUrl?: string;
}

const activeStreams = new Map<string, ActiveStream>();

async function runServiceMode(): Promise<void> {
  console.log('[SERVICE] VRCVidFix service starting...');
  console.log(`[SERVICE] Deps dir: ${SERVICE_DEPS_DIR}`);

  // Ensure directories exist
  fs.mkdirSync(SERVICE_DEPS_DIR, { recursive: true });
  fs.mkdirSync(localTmpDir, { recursive: true });

  // Check and download deps if needed
  const depsExist = fs.existsSync(SERVICE_YTDLP_PATH) && fs.existsSync(SERVICE_FFMPEG_PATH);
  if (!depsExist) {
    console.log('[SERVICE] Dependencies missing, downloading...');
    try {
      await runDepUpdate(SERVICE_DEPS_DIR);
    } catch (err) {
      console.error('[SERVICE] Failed to download dependencies:', err);
      process.exit(1);
    }
  }

  // Environment for child processes — ensure yt-dlp can find bun, ffmpeg, etc.
  const serviceEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: SERVICE_DEPS_DIR + path.delimiter + (process.env['PATH'] || ''),
  };

  // Start control API server
  Bun.serve({
    port: VIDFIX_SERVICE_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      // ===== Health Check =====
      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          activeStreams: activeStreams.size,
          uptime: process.uptime(),
        });
      }

      // ===== Create Stream =====
      if (url.pathname === '/api/stream' && req.method === 'POST') {
        try {
          const body = await req.json() as {
            videoUrl: string;
            originalArgs: string[];
            cwd: string;
          };
          const { videoUrl, originalArgs, cwd } = body;

          if (!videoUrl || !originalArgs || !cwd) {
            return Response.json({ error: 'Missing required fields' }, { status: 400 });
          }

          const argsHash = sha256(originalArgs.join(' '));

          // Reuse existing stream if still alive
          const existing = activeStreams.get(argsHash);
          if (existing) {
            console.log(`[SERVICE] Reusing existing stream ${argsHash.substring(0, 8)} on port ${existing.port}`);
            const playlistUrl = `http://localhost.youtube.com:${existing.port}/playlist.m3u8?hash=${argsHash}`;
            return Response.json({ playlistUrl });
          }

          // Resolve cookies path from the launcher's CWD
          const cookiesPath = path.resolve(cwd, 'cookies.txt');
          const cookiesArg = fs.existsSync(cookiesPath) ? `--cookies "${cookiesPath}"` : '';

          console.log(`[SERVICE] Processing: ${videoUrl.substring(0, 80)}...`);
          console.log(`[SERVICE] Cookies: ${cookiesArg ? cookiesPath : 'none'}`);

          // Run yt-dlp to get metadata + stream URL
          const safeVideoUrl = videoUrl.replaceAll('"', '');
          const safeArgs = originalArgs.map((i: string) => `"${i.replaceAll('"', '')}"`).join(' ');

          const [jsonResult, m3u8Result] = await Promise.all([
            execWithOpts(
              `"${SERVICE_YTDLP_PATH}" --js-runtimes "bun" ${cookiesArg} -j "${safeVideoUrl}"`,
              { env: serviceEnv, maxBuffer: 50 * 1024 * 1024 }
            ),
            execWithOpts(
              `"${SERVICE_YTDLP_PATH}" --js-runtimes "bun" ${cookiesArg} ${safeArgs}`,
              { env: serviceEnv, maxBuffer: 50 * 1024 * 1024 }
            ),
          ]);

          let videoInfo: any;
          try {
            videoInfo = JSON.parse(jsonResult.stdout);
          } catch {
            console.error('[SERVICE] Failed to parse yt-dlp JSON output');
            console.error('[SERVICE] Raw output:', jsonResult.stdout.substring(0, 500));
            return Response.json({ error: 'Failed to parse video metadata' }, { status: 500 });
          }

          const m3u8Url = m3u8Result.stdout.trim();
          const duration = videoInfo.duration || 0;
          const isLive = videoInfo.is_live === true;

          if (!isLive && duration <= 0) {
            return Response.json({ error: 'Could not determine video duration' }, { status: 400 });
          }

          const hlsPort = await findAvailablePort(VidFixStartPort);

          if (isLive) {
            startLiveStream(argsHash, hlsPort, m3u8Url);
          } else {
            startVodStream(argsHash, hlsPort, m3u8Url, duration);
          }

          const playlistUrl = `http://localhost.youtube.com:${hlsPort}/playlist.m3u8?hash=${argsHash}`;
          console.log(`[SERVICE] Stream ${argsHash.substring(0, 8)} ready: ${playlistUrl}`);
          return Response.json({ playlistUrl });
        } catch (err: any) {
          console.error('[SERVICE] Stream creation error:', err);
          const msg = err?.stderr?.toString?.().trim?.() || err?.message || String(err);
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.log(`[SERVICE] Control API listening on 127.0.0.1:${VIDFIX_SERVICE_PORT}`);

  // Periodic dep update check (every 6 hours)
  setInterval(async () => {
    try {
      console.log('[SERVICE] Periodic dep check...');
      await runDepUpdate(SERVICE_DEPS_DIR);
    } catch (err) {
      console.warn('[SERVICE] Periodic dep update failed:', err);
    }
  }, 6 * 60 * 60 * 1000);

  // Keep alive
  setInterval(() => { }, 60000);
}

// =============================================
// Stream Cleanup
// =============================================

function cleanupStream(hash: string): void {
  const stream = activeStreams.get(hash);
  if (!stream) return;

  console.log(`[SERVICE] Cleaning up stream ${hash.substring(0, 8)} on port ${stream.port}`);

  try { stream.server.stop(true); } catch { }

  for (const proc of stream.ffmpegProcs) {
    if (!proc.killed) try { proc.kill(); } catch { }
  }

  if (stream.tempDir) cleanupTempDir(stream.tempDir);
  if (stream.timeoutHandle) clearTimeout(stream.timeoutHandle);

  activeStreams.delete(hash);
  console.log(`[SERVICE] Stream ${hash.substring(0, 8)} cleaned up`);
}

// =============================================
// Live Stream HLS (within service)
// =============================================

function startLiveStream(hash: string, port: number, sourceUrl: string): void {
  const tempDir = path.join(localTmpDir, `live-${hash.substring(0, 12)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const hlsPlaylistPath = path.join(tempDir, 'playlist.m3u8');
  const segmentPattern = path.join(tempDir, 'segment_%d.ts');

  let liveEnded = false;
  let isRequested = false;

  // Auto-cleanup if nobody requests within timeout
  const idleTimeout = setTimeout(() => {
    if (!isRequested) {
      console.log(`[LIVE] No request for stream ${hash.substring(0, 8)} within timeout, cleaning up`);
      cleanupStream(hash);
    }
  }, VidFixStreamProcessTimeout);

  const ffmpegArgs: string[] = [
    '-i', sourceUrl,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', HLS_SEGMENT_DURATION.toString(),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', segmentPattern,
    hlsPlaylistPath
  ];

  console.log(`[LIVE] Starting ffmpeg for live stream on port ${port}`);
  console.log(`[LIVE] Source: ${sourceUrl.substring(0, 80)}...`);

  const ffmpegProc = cp.spawn(SERVICE_FFMPEG_PATH, ffmpegArgs, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  ffmpegProc.stderr?.on('data', () => { });

  ffmpegProc.on('exit', (code) => {
    liveEnded = true;
    console.log(`[LIVE] FFmpeg exited code=${code} for stream ${hash.substring(0, 8)}`);
    // Cleanup after timeout so already-requested segments can still be served
    const cleanupTimeout = setTimeout(() => cleanupStream(hash), VidFixStreamProcessTimeout);
    const stream = activeStreams.get(hash);
    if (stream) {
      stream.timeoutHandle = cleanupTimeout;
      stream.liveEnded = true;
    }
  });

  ffmpegProc.on('error', (err) => {
    console.error(`[LIVE] FFmpeg spawn error for ${hash.substring(0, 8)}:`, err.message);
    cleanupStream(hash);
  });

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const reqHash = url.searchParams.get('hash');

        if (reqHash !== hash) {
          return new Response("Not Found", { status: 404 });
        }

        isRequested = true;

        // ===== M3U8 Playlist =====
        if (url.pathname === '/playlist.m3u8') {
          console.log(`[REQ] ${req.method} /playlist.m3u8 (live, ${hash.substring(0, 8)})`);
          try {
            let playlistContent = fs.readFileSync(hlsPlaylistPath, 'utf-8');
            playlistContent = playlistContent.replace(
              /^(segment_\d+\.ts)$/gm,
              `$1?hash=${hash}`
            );
            return new Response(playlistContent, {
              status: 200,
              headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
              }
            });
          } catch {
            // Playlist not yet created by ffmpeg — return empty EVENT playlist
            const emptyPlaylist = [
              '#EXTM3U',
              '#EXT-X-VERSION:3',
              `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION}`,
              '#EXT-X-MEDIA-SEQUENCE:0',
              '#EXT-X-PLAYLIST-TYPE:EVENT',
              ''
            ].join('\n');
            return new Response(emptyPlaylist, {
              status: 200,
              headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
              }
            });
          }
        }

        // ===== TS Segment =====
        const segMatch = url.pathname.match(/^\/segment_(\d+)\.ts$/);
        if (segMatch) {
          const segIndex = parseInt(segMatch[1]!, 10);
          const segFile = path.join(tempDir, `segment_${segIndex}.ts`);

          console.log(`[REQ] segment_${segIndex}.ts (live, ${hash.substring(0, 8)})`);

          try {
            const data = fs.readFileSync(segFile);
            if (data.length > 0) {
              console.log(`[REQ] segment_${segIndex} served (${(data.length / 1024).toFixed(0)}KB)`);
              return new Response(data, {
                status: 200,
                headers: {
                  'Content-Type': 'video/mp2t',
                  'Content-Length': data.length.toString(),
                  'Cache-Control': 'no-store',
                  'Access-Control-Allow-Origin': '*',
                }
              });
            }
          } catch { }

          if (liveEnded) {
            return new Response("Segment not found", { status: 404 });
          }

          const buf = await waitForSegmentFile(segFile, 30000);
          if (!buf) {
            return new Response("Segment timeout", { status: 504 });
          }
          console.log(`[REQ] segment_${segIndex} served after wait (${(buf.length / 1024).toFixed(0)}KB)`);
          return new Response(buf, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp2t',
              'Content-Length': buf.length.toString(),
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error('[FETCH] Handler error:', err);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
  });

  const streamInfo: ActiveStream = {
    hash, port, server, isLive: true,
    createdAt: Date.now(),
    ffmpegProcs: [ffmpegProc],
    tempDir,
    timeoutHandle: idleTimeout,
    liveEnded: false,
  };
  activeStreams.set(hash, streamInfo);

  console.log(`[LIVE] Listening on port ${port}`);
}

// =============================================
// VOD Stream HLS (within service)
// =============================================

function startVodStream(hash: string, port: number, sourceUrl: string, totalDuration: number): void {
  const segmentCount = Math.ceil(totalDuration / HLS_SEGMENT_DURATION);
  const playlist = generateM3U8Playlist(totalDuration, segmentCount, hash);

  let isRequested = false;
  let firstSegmentServed = false;

  // Auto-cleanup if nobody requests within timeout
  const idleTimeout = setTimeout(() => {
    if (!isRequested) {
      console.log(`[VOD] No request for stream ${hash.substring(0, 8)} within timeout, cleaning up`);
      cleanupStream(hash);
    }
  }, VidFixStreamProcessTimeout);

  // Auto-cleanup after video duration + buffer
  const durationTimeout = setTimeout(() => {
    console.log(`[VOD] Stream ${hash.substring(0, 8)} duration expired, cleaning up`);
    cleanupStream(hash);
  }, totalDuration * 1000 + VidFixStreamProcessTimeout);

  // Segment cache
  const segmentCache = new Map<number, CachedSegment>();
  const allFfmpegProcs: cp.ChildProcess[] = [];

  function evictCacheBefore(currentIndex: number) {
    for (const [idx, cached] of segmentCache) {
      if (idx < currentIndex) {
        if (cached.proc && !cached.proc.killed) {
          cached.proc.kill();
        }
        segmentCache.delete(idx);
        console.log(`[CACHE] Evicted segment_${idx} (${hash.substring(0, 8)})`);
      }
    }
  }

  function prepareSegment(segIndex: number): CachedSegment {
    const existing = segmentCache.get(segIndex);
    if (existing) return existing;

    if (segIndex < 0 || segIndex >= segmentCount) {
      const entry: CachedSegment = {
        data: Buffer.alloc(0),
        ready: true,
        chunks: [],
        proc: null,
        resolve: null,
        promise: Promise.resolve(Buffer.alloc(0)),
      };
      return entry;
    }

    const startSec = segIndex * HLS_SEGMENT_DURATION;
    const segDuration = Math.min(HLS_SEGMENT_DURATION, totalDuration - startSec);

    let resolvePromise: ((buf: Buffer) => void) | null = null;
    const promise = new Promise<Buffer>((resolve) => { resolvePromise = resolve; });

    const entry: CachedSegment = {
      data: Buffer.alloc(0),
      ready: false,
      chunks: [],
      proc: null,
      resolve: resolvePromise,
      promise,
    };

    const ffmpegArgs: string[] = [
      '-ss', startSec.toFixed(3),
      '-t', segDuration.toFixed(3),
      '-i', sourceUrl,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'mpegts',
      '-mpegts_copyts', '1',
      '-output_ts_offset', startSec.toFixed(3),
      'pipe:1'
    ];

    const proc = cp.spawn(SERVICE_FFMPEG_PATH, ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    entry.proc = proc;
    allFfmpegProcs.push(proc);

    proc.stdout?.on('data', (chunk: Buffer) => {
      entry.chunks.push(chunk);
    });

    proc.stderr?.on('data', () => { }); // suppress

    proc.on('exit', (code) => {
      entry.data = Buffer.concat(entry.chunks);
      entry.chunks = [];
      entry.ready = true;
      if (entry.resolve) {
        entry.resolve(entry.data);
        entry.resolve = null;
      }
      if (code === 0) {
        console.log(`[CACHE] segment_${segIndex} ready (${(entry.data.length / 1024).toFixed(0)}KB) (${hash.substring(0, 8)})`);
      } else {
        console.error(`[CACHE] segment_${segIndex} ffmpeg exit=${code} (${hash.substring(0, 8)})`);
      }
    });

    proc.on('error', (err) => {
      console.error(`[CACHE] segment_${segIndex} spawn error (${hash.substring(0, 8)}):`, err.message);
      entry.ready = true;
      entry.data = Buffer.alloc(0);
      if (entry.resolve) {
        entry.resolve(entry.data);
        entry.resolve = null;
      }
    });

    segmentCache.set(segIndex, entry);
    console.log(`[CACHE] Preparing segment_${segIndex} (start=${startSec}s dur=${segDuration.toFixed(3)}s) (${hash.substring(0, 8)})`);
    return entry;
  }

  // Prewarm first segment immediately so players can start deterministically.
  prepareSegment(0);

  console.log(`[VOD] HLS on port ${port}, duration=${totalDuration}s, segments=${segmentCount}`);
  console.log(`[VOD] Source: ${sourceUrl.substring(0, 80)}...`);

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const reqHash = url.searchParams.get('hash');

        if (reqHash !== hash) {
          return new Response("Not Found", { status: 404 });
        }

        isRequested = true;

        // ===== M3U8 Playlist =====
        if (url.pathname === '/playlist.m3u8') {
          console.log(`[REQ] ${req.method} /playlist.m3u8 (${hash.substring(0, 8)})`);
          return new Response(playlist, {
            status: 200,
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }

        // ===== TS Segment =====
        const segMatch = url.pathname.match(/^\/segment_(\d+)\.ts$/);
        if (segMatch) {
          const segIndex = parseInt(segMatch[1]!, 10);
          if (segIndex < 0 || segIndex >= segmentCount) {
            return new Response("Segment out of range", { status: 404 });
          }

          console.log(`[REQ] segment_${segIndex}.ts (${hash.substring(0, 8)})`);

          // Ensure segment_0 is served first to avoid startup ordering glitches
          // observed on some players.
          if (segIndex > 0 && !firstSegmentServed) {
            const first = prepareSegment(0);
            const firstBuf = first.ready ? first.data : await first.promise;
            if (firstBuf.length === 0) {
              return new Response("First segment not ready", { status: 503 });
            }
          }

          // Evict old segments from cache
          evictCacheBefore(segIndex);

          // Prepare this and next segment
          const cached = prepareSegment(segIndex);
          if (segIndex + 1 < segmentCount) {
            prepareSegment(segIndex + 1);
          }

          if (cached.ready) {
            console.log(`[REQ] segment_${segIndex} served from cache (${(cached.data.length / 1024).toFixed(0)}KB)`);
            if (segIndex === 0) firstSegmentServed = true;
            return new Response(cached.data, {
              status: 200,
              headers: {
                'Content-Type': 'video/mp2t',
                'Content-Length': cached.data.length.toString(),
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
              }
            });
          }

          // Wait for ffmpeg to finish encoding segment
          const buf = await cached.promise;
          console.log(`[REQ] segment_${segIndex} served after wait (${(buf.length / 1024).toFixed(0)}KB)`);
          if (segIndex === 0) firstSegmentServed = true;
          return new Response(buf, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp2t',
              'Content-Length': buf.length.toString(),
              'Cache-Control': 'no-store',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error('[FETCH] Handler error:', err);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
  });

  const streamInfo: ActiveStream = {
    hash, port, server, isLive: false,
    createdAt: Date.now(),
    ffmpegProcs: allFfmpegProcs,
    segmentCache,
    segmentCount,
    totalDuration,
    sourceUrl,
    timeoutHandle: durationTimeout,
  };
  activeStreams.set(hash, streamInfo);

  console.log(`[VOD] Listening on port ${port}`);
}

// =============================================
// Service Health Check
// =============================================

async function checkServiceHealth(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${VIDFIX_SERVICE_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServiceRunning(): Promise<void> {
  if (await checkServiceHealth()) {
    console.log('[WATCHER] Service already running.');
    return;
  }

  console.log('[WATCHER] Starting VRCVidFix service...');
  const proc = cp.spawn(
    VIDFIX_SAFE_EXE,
    ['--vidfix-service'],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  proc.unref();

  // Wait for service to become ready (downloads deps on first start)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await checkServiceHealth()) {
      console.log('[WATCHER] Service started successfully.');
      return;
    }
  }
  console.error('[WATCHER] Service failed to start within 60 seconds.');
}

// =============================================
// Interactive Setup (no-args / double-click)
// =============================================

async function interactiveSetup(): Promise<void> {
  console.log('============================================');
  console.log('           VRCVidFix Setup');
  console.log('============================================');
  console.log('  Created by  : Armagan');
  console.log('  GitHub      : https://github.com/TheArmgan/vrcvidfix');
  console.log('  Discord     : https://discord.gg/spfmB7S78n');
  console.log('============================================');
  console.log('');

  const installed = checkTaskExists(VIDFIX_TASK_NAME);

  // Detect if the running exe differs from the installed safe exe (new version)
  let updateAvailable = false;
  if (installed && fs.existsSync(VIDFIX_SAFE_EXE)) {
    try {
      const runningHash = fileSha256(process.execPath);
      const safeHash = fileSha256(VIDFIX_SAFE_EXE);
      updateAvailable = runningHash !== safeHash;
    } catch { }
  }

  if (installed) {
    console.log('VRCVidFix watcher is currently INSTALLED as a startup task.');
    console.log('  Safe exe : ' + VIDFIX_SAFE_EXE);
    console.log('  Watching : ' + VRCHAT_YTDLP_PATH);
    if (updateAvailable) {
      console.log('');
      console.log('  ** UPDATE AVAILABLE — this exe differs from the installed version **');
    }
    console.log('');
    if (updateAvailable) {
      console.log('[1] Update');
      console.log('[2] Uninstall / Remove');
      console.log('[3] Exit');
    } else {
      console.log('[1] Uninstall / Remove');
      console.log('[2] Exit');
    }
    console.log('');
    const choice = await readLine('Choice: ');

    if (updateAvailable) {
      // Menu: 1=Update, 2=Uninstall, 3=Exit
      if (choice.trim() === '1') {
        try {
          console.log('[UPDATE] Killing running VRCVidFix processes...');
          await killAllVrcvidfix();
          console.log('[UPDATE] Updating safe exe...');
          fs.mkdirSync(VIDFIX_SAFE_DIR, { recursive: true });
          await retryCopy(process.execPath, VIDFIX_SAFE_EXE, 5, 1000);
          console.log(`[UPDATE] Copied exe -> ${VIDFIX_SAFE_EXE}`);
          await replaceVRChatYtDlp();
          // Restart the watcher after update (watcher will restart service too)
          cp.spawn(
            VIDFIX_SAFE_EXE,
            ['--vidfix-watcher'],
            { detached: true, stdio: 'ignore', windowsHide: true }
          ).unref();
          console.log('[OK] VRCVidFix updated successfully.');
          console.log('[OK] Watcher restarted with the new version.');
        } catch (err) {
          console.error('[ERR] Update failed:', err);
        }
      } else if (choice.trim() === '2') {
        try {
          await uninstallWatcherTask(VIDFIX_TASK_NAME);
          console.log('[OK] VRCVidFix startup task removed.');
        } catch (err) {
          console.error('[ERR] Failed to remove task:', err);
        }
      } else {
        console.log('Cancelled.');
      }
    } else {
      // Menu: 1=Uninstall, 2=Exit
      if (choice.trim() === '1') {
        try {
          await uninstallWatcherTask(VIDFIX_TASK_NAME);
          console.log('[OK] VRCVidFix startup task removed.');
        } catch (err) {
          console.error('[ERR] Failed to remove task:', err);
        }
      } else {
        console.log('Cancelled.');
      }
    }
  } else {
    console.log('VRCVidFix watcher is NOT installed.');
    console.log('');
    console.log('This will:');
    console.log('  1. Copy vrcvidfix.exe -> ' + VIDFIX_SAFE_EXE);
    console.log('  2. Register a startup task to watch VRChat Tools folder');
    console.log('  3. Start a background service for video processing');
    console.log('  4. Download dependencies (yt-dlp, ffmpeg, bun) to ' + SERVICE_DEPS_DIR);
    console.log('  5. Automatically keep yt-dlp.exe replaced with vrcvidfix.exe');
    console.log('  6. Watching: ' + VRCHAT_YTDLP_PATH);
    console.log('');
    console.log('[1] Install');
    console.log('[2] Exit');
    console.log('');
    const choice = await readLine('Choice: ');
    if (choice.trim() === '1') {
      try {
        await installWatcherTask();
        console.log('[OK] VRCVidFix installed successfully.');
        console.log('[OK] Watcher started and will auto-start on next login.');
        console.log('[OK] Background service started for video processing.');
      } catch (err) {
        console.error('[ERR] Installation failed:', err);
      }
    } else {
      console.log('Cancelled.');
    }
  }

  console.log('');
  await readLine('Press ENTER to exit...');
  process.exit(0);
}

// =============================================
// Watcher Mode (--vidfix-watcher)
// =============================================

async function runWatcherMode(): Promise<void> {
  console.log(`[WATCHER] VRCVidFix watcher started.`);
  console.log(`[WATCHER] Monitoring: ${VRCHAT_YTDLP_PATH}`);
  console.log(`[WATCHER] Safe exe  : ${VIDFIX_SAFE_EXE}`);

  // Grant permissions on Tools dir
  ensureToolsDirPermissions();

  // Initial replace on startup
  await replaceVRChatYtDlp();

  // Start the background service (downloads deps on first run)
  await ensureServiceRunning();

  // Monitor service health — restart if it crashes
  setInterval(async () => {
    const healthy = await checkServiceHealth();
    if (!healthy) {
      console.log('[WATCHER] Service is down, restarting...');
      await ensureServiceRunning();
    }
  }, 15000);

  // Watch for file changes
  fs.watchFile(VRCHAT_YTDLP_PATH, { interval: 3000, persistent: true }, async (_curr, _prev) => {
    console.log(`[WATCHER] Change detected in ${path.basename(VRCHAT_YTDLP_PATH)} — replacing...`);
    await replaceVRChatYtDlp();
  });

  // Poll dir creation in case VRChat Tools folder doesn't exist yet
  const pollDirInterval = setInterval(async () => {
    const toolsDir = path.dirname(VRCHAT_YTDLP_PATH);
    if (fs.existsSync(toolsDir) && !fs.existsSync(VRCHAT_YTDLP_PATH)) {
      console.log(`[WATCHER] yt-dlp.exe missing from Tools dir — replacing...`);
      await replaceVRChatYtDlp();
    }
  }, 10000);

  // Keep alive
  const keepAlive = setInterval(() => { }, 60000);

  process.on('SIGTERM', () => {
    clearInterval(pollDirInterval);
    clearInterval(keepAlive);
    fs.unwatchFile(VRCHAT_YTDLP_PATH);
    process.exit(0);
  });
}

async function replaceVRChatYtDlp(): Promise<void> {
  if (!fs.existsSync(VIDFIX_SAFE_EXE)) {
    console.warn(`[WATCHER] Safe exe not found: ${VIDFIX_SAFE_EXE} — skipping replace.`);
    return;
  }

  const toolsDir = path.dirname(VRCHAT_YTDLP_PATH);
  if (!fs.existsSync(toolsDir)) {
    return;
  }

  // Check if already our exe
  if (fs.existsSync(VRCHAT_YTDLP_PATH)) {
    const srcHash = fileSha256(VIDFIX_SAFE_EXE);
    const dstHash = fileSha256(VRCHAT_YTDLP_PATH);
    if (srcHash === dstHash) {
      return;
    }
  }

  // Retry loop for file locking
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.copyFileSync(VIDFIX_SAFE_EXE, VRCHAT_YTDLP_PATH);
      console.log(`[WATCHER] Replaced yt-dlp.exe with vrcvidfix.exe successfully.`);
      return;
    } catch (err: any) {
      if (attempt < 4) {
        console.warn(`[WATCHER] Replace attempt ${attempt + 1} failed (${err.message}) — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.error(`[WATCHER] Failed to replace yt-dlp.exe after 5 attempts:`, err.message);
      }
    }
  }
}

// =============================================
// VRChat Tools Directory Permissions
// =============================================

function ensureToolsDirPermissions(): void {
  const toolsDir = path.dirname(VRCHAT_YTDLP_PATH);
  if (!fs.existsSync(toolsDir)) return;

  const username = os.userInfo().username;
  console.log(`[PERMS] Granting Full Control to '${username}' on ${toolsDir}`);

  const result = cp.spawnSync('icacls', [
    toolsDir,
    '/grant', `${username}:(OI)(CI)F`,
    '/T', '/Q',
  ], {
    stdio: 'pipe',
    windowsHide: true,
  });

  if (result.status === 0) {
    console.log(`[PERMS] Permissions updated successfully.`);
  } else {
    const stderr = result.stderr?.toString().trim() || '';
    console.warn(`[PERMS] icacls failed (exit ${result.status})${stderr ? ': ' + stderr : ''}`);
  }
}

// =============================================
// Task Scheduler Helpers
// =============================================

function checkTaskExists(taskName: string): boolean {
  const result = cp.spawnSync('schtasks', ['/query', '/tn', taskName], {
    stdio: 'pipe',
    windowsHide: true,
  });
  return result.status === 0;
}

async function installWatcherTask(): Promise<void> {
  // 0. Kill any running vrcvidfix processes
  console.log('[INSTALL] Killing running VRCVidFix processes...');
  await killAllVrcvidfix();

  // 1. Copy self to safe location
  fs.mkdirSync(VIDFIX_SAFE_DIR, { recursive: true });
  await retryCopy(process.execPath, VIDFIX_SAFE_EXE, 5, 1000);
  console.log(`[INSTALL] Copied exe -> ${VIDFIX_SAFE_EXE}`);

  // 2. Register scheduled task via elevated PowerShell
  const safeExeEscaped = VIDFIX_SAFE_EXE.replace(/'/g, "''");
  const taskNameEscaped = VIDFIX_TASK_NAME.replace(/'/g, "''");
  const innerCmd = [
    `schtasks /create`,
    `/tn '${taskNameEscaped}'`,
    `/tr '"${safeExeEscaped}" --vidfix-watcher'`,
    `/sc onlogon`,
    `/rl highest`,
    `/f`,
  ].join(' ');

  console.log(`[INSTALL] Requesting administrator privileges to register startup task...`);
  await runElevatedPowerShell(innerCmd);
  if (!checkTaskExists(VIDFIX_TASK_NAME)) {
    throw new Error(`schtasks /create failed or UAC was cancelled`);
  }
  console.log(`[INSTALL] Scheduled task '${VIDFIX_TASK_NAME}' created.`);

  // 3. Grant permissions on VRChat Tools dir
  ensureToolsDirPermissions();

  // 4. Ensure hosts file has localhost.youtube.com entry
  await ensureHostsEntry();

  // 5. Download dependencies to service directory
  console.log('[INSTALL] Downloading dependencies...');
  try {
    await runDepUpdate(SERVICE_DEPS_DIR);
    console.log('[INSTALL] Dependencies downloaded.');
  } catch (err) {
    console.warn('[INSTALL] Dep download failed (service will retry on start):', err);
  }

  // 6. Initial replace of VRChat yt-dlp.exe
  await replaceVRChatYtDlp();

  // 7. Start the watcher (which also starts the service)
  cp.spawn(
    VIDFIX_SAFE_EXE,
    ['--vidfix-watcher'],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref();
  console.log(`[INSTALL] Watcher process started.`);
}

async function uninstallWatcherTask(taskName: string): Promise<void> {
  console.log('[UNINSTALL] Killing running VRCVidFix processes...');
  await killAllVrcvidfix();

  const taskNameEscaped = taskName.replace(/'/g, "''");
  const safeExeEscaped = VIDFIX_SAFE_EXE.replace(/'/g, "''").replace(/\\/g, '\\\\');

  const innerCmd = [
    `schtasks /end /tn '${taskNameEscaped}' 2>$null;`,
    `Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -eq '${safeExeEscaped}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } 2>$null;`,
    `schtasks /delete /tn '${taskNameEscaped}' /f`,
  ].join(' ');

  console.log(`[UNINSTALL] Requesting administrator privileges to remove startup task...`);
  await runElevatedPowerShell(innerCmd);
  if (checkTaskExists(taskName)) {
    throw new Error(`schtasks /delete failed or UAC was cancelled`);
  }
  console.log(`[UNINSTALL] Scheduled task '${taskName}' removed.`);
  console.log(`[UNINSTALL] Watcher and service processes killed.`);
}

/**
 * Kill all running VRCVidFix-related processes except the current one.
 */
async function killAllVrcvidfix(): Promise<void> {
  const myPid = process.pid;

  const safeExeEscaped = VIDFIX_SAFE_EXE.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const vrchatYtdlpEscaped = VRCHAT_YTDLP_PATH.replace(/\\/g, '\\\\').replace(/'/g, "''");

  const psCmd = [
    `Get-WmiObject Win32_Process | Where-Object {`,
    `  $_.ProcessId -ne ${myPid} -and (`,
    `    $_.ExecutablePath -eq '${safeExeEscaped}' -or`,
    `    $_.ExecutablePath -eq '${vrchatYtdlpEscaped}' -or`,
    `    ($_.Name -eq 'vrcvidfix.exe')`,
    `  )`,
    `} | ForEach-Object {`,
    `  Write-Host "Killing PID $($_.ProcessId) ($($_.ExecutablePath))"`,
    `  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue`,
    `}`,
  ].join(' ');

  return new Promise<void>((resolve) => {
    const proc = cp.spawn('powershell', [
      '-NonInteractive', '-NoProfile', '-Command', psCmd,
    ], {
      stdio: 'pipe',
      windowsHide: true,
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[KILL] ${msg}`);
    });
    proc.stderr?.on('data', () => { });

    proc.on('exit', () => {
      setTimeout(resolve, 500);
    });
    proc.on('error', () => resolve());
  });
}

/**
 * Retry fs.copyFileSync with delay — handles transient EBUSY after killing processes.
 */
async function retryCopy(src: string, dest: string, attempts: number, delayMs: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err: any) {
      if (i < attempts - 1 && (err.code === 'EBUSY' || err.code === 'EPERM')) {
        console.warn(`[COPY] Attempt ${i + 1}/${attempts} failed (${err.code}) — retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

function runElevatedPowerShell(command: string): Promise<void> {
  const escaped = command.replace(/'/g, "''");
  const outerArgs = [
    '-NonInteractive',
    '-NoProfile',
    '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NonInteractive','-NoProfile','-Command','${escaped}'`,
  ];
  return new Promise((resolve, reject) => {
    const proc = cp.spawn('powershell', outerArgs, {
      stdio: 'inherit',
      windowsHide: false,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Elevated PowerShell exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// =============================================
// Stdin helper
// =============================================

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// =============================================
// HLS Playlist Generator
// =============================================

function generateM3U8Playlist(totalDuration: number, segmentCount: number, hash: string): string {
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${HLS_SEGMENT_DURATION}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];

  for (let i = 0; i < segmentCount; i++) {
    const startSec = i * HLS_SEGMENT_DURATION;
    const segDuration = Math.min(HLS_SEGMENT_DURATION, totalDuration - startSec);
    lines.push(`#EXTINF:${segDuration.toFixed(3)},`);
    lines.push(`segment_${i}.ts?hash=${hash}`);
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// =============================================
// Utilities
// =============================================

/**
 * Strip surrounding quotes (single or double) and trim whitespace.
 */
function stripQuotes(s: string): string {
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Extract the video URL from yt-dlp-style arguments.
 *
 * VRChat passes arguments like:
 *   --no-check-certificate --no-cache-dir --rm-cache-dir -f
 *   "(mp4/best)[height<=?4320][height>=?64][width>=?64]"
 *   --get-url "https://www.youtube.com/watch?v=XXXXXXXXXXX"
 *
 * Strategy:
 *  1. Find `--get-url` and return the next argument (the URL).
 *  2. Fallback: scan all args after `--get-url` for anything that looks like a URL.
 *  3. Last resort: scan all args for a URL pattern.
 */
function extractVideoUrl(args: string[]): string | null {
  const urlRegex = /^https?:\/\/.+/i;

  // --- Strategy 1: find --get-url and take the next arg ---
  const getUrlIdx = args.indexOf('--get-url');
  if (getUrlIdx !== -1 && getUrlIdx + 1 < args.length) {
    const candidate = stripQuotes(args[getUrlIdx + 1]!);
    if (candidate.length > 0) {
      return candidate;
    }
  }

  // --- Strategy 2: scan args after --get-url for a URL pattern ---
  if (getUrlIdx !== -1) {
    for (let i = getUrlIdx + 1; i < args.length; i++) {
      const candidate = stripQuotes(args[i]!);
      if (urlRegex.test(candidate)) {
        return candidate;
      }
    }
  }

  // --- Strategy 3 (last resort): scan all args for a URL pattern ---
  for (const arg of args) {
    const candidate = stripQuotes(arg);
    if (urlRegex.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function sha256(data: string) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (true) {
    if (await checkPort(port)) return port;
    port++;
  }
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function cleanupTempDir(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

function waitForSegmentFile(filePath: string, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        const data = fs.readFileSync(filePath);
        if (data.length > 0) {
          resolve(data);
          return;
        }
      } catch { }

      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }

      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Execute a command and return stdout/stderr as strings. Replacement for
 * stuffs/execAsync with proper options support (env, cwd, maxBuffer).
 */
function execWithOpts(cmd: string, opts?: cp.ExecOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { maxBuffer: 50 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

// =============================================
// Dependency Update
// =============================================

interface DepRecord { version: string; sha256?: string; }
type VersionStore = Record<string, DepRecord>;

function readDepStore(dir: string): VersionStore {
  const p = path.join(dir, 'deps-versions.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as VersionStore; } catch { }
  }
  return {};
}

function saveDepStore(dir: string, store: VersionStore): void {
  fs.writeFileSync(path.join(dir, 'deps-versions.json'), JSON.stringify(store, null, 2));
}

interface GHRelease { tag_name: string; assets: Array<{ name: string; browser_download_url: string }>; }

async function ghLatestRelease(repo: string): Promise<GHRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'vrcvidfix/1.0', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}`);
  return res.json() as Promise<GHRelease>;
}

function ghFindAsset(release: GHRelease, pattern: RegExp): { tag: string; url: string } {
  const asset = release.assets.find(a => pattern.test(a.name));
  if (!asset) throw new Error(`No asset matching ${pattern} in ${release.tag_name}`);
  return { tag: release.tag_name, url: asset.browser_download_url };
}

async function downloadFile(url: string, dest: string): Promise<void> {
  console.log(`[DEPS]   ↓ ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'vrcvidfix/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body!.getReader();
  const fd = fs.openSync(dest, 'w');
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fs.writeSync(fd, value);
    received += value.length;
    if (total > 0) {
      try { process.stdout.write(`\r[DEPS]   ${((received / total) * 100).toFixed(1)}% (${(received / 1_048_576).toFixed(1)}/${(total / 1_048_576).toFixed(1)} MB)  `); } catch { }
    }
  }
  fs.closeSync(fd);
  if (total > 0) { try { process.stdout.write('\n'); } catch { } }
}

function extractZipToDir(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const r = cp.spawnSync('powershell', [
    '-NonInteractive', '-NoProfile', '-Command',
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
  ], { stdio: 'pipe', windowsHide: true });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim();
    throw new Error(`Expand-Archive failed (exit ${r.status})${stderr ? ': ' + stderr : ''}`);
  }
}

function copyDirTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findFileInDir(dir: string, pred: (name: string) => boolean): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFileInDir(full, pred); if (f) return f; }
    else if (pred(e.name)) return full;
  }
  return null;
}

function fileSha256(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function depUpdateYtDlp(dir: string, store: VersionStore): Promise<boolean> {
  console.log('[DEPS] [yt-dlp] Checking...');
  const release = await ghLatestRelease('yt-dlp/yt-dlp');
  const { tag, url } = ghFindAsset(release, /^yt-dlp_win\.zip$/);
  if (store['yt-dlp']?.version === tag) { console.log(`[DEPS] [yt-dlp] Up-to-date (${tag})`); return false; }
  console.log(`[DEPS] [yt-dlp] Updating → ${tag}`);
  const tmp = fs.mkdtempSync(path.join(localTmpDir, 'ytdlp-'));
  try {
    const zipPath = path.join(tmp, 'yt-dlp_win.zip');
    await downloadFile(url, zipPath);
    extractZipToDir(zipPath, path.join(tmp, 'x'));

    const srcExe = findFileInDir(path.join(tmp, 'x'), n => n === 'yt-dlp.exe');
    if (!srcExe) throw new Error('yt-dlp.exe not found in zip');

    const dest = path.join(dir, 'yt-dlp-original.exe');
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
      } catch {
        const bakPath = path.join(dir, 'yt-dlp-original.exe.bak');
        try { fs.unlinkSync(bakPath); } catch { }
        fs.renameSync(dest, bakPath);
      }
    }
    fs.copyFileSync(srcExe, dest);

    // Copy _internal directory alongside yt-dlp-original.exe
    const srcExeDir = path.dirname(srcExe);
    const internalSrc = path.join(srcExeDir, '_internal');
    if (fs.existsSync(internalSrc)) {
      const internalDest = path.join(dir, '_internal');
      if (fs.existsSync(internalDest)) {
        try { fs.rmSync(internalDest, { recursive: true, force: true }); } catch { }
      }
      copyDirTree(internalSrc, internalDest);
      console.log(`[DEPS] [yt-dlp] Copied _internal directory`);
    }

    store['yt-dlp'] = { version: tag, sha256: fileSha256(dest) };
    console.log(`[DEPS] [yt-dlp] Done (${tag})`);
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function depUpdateFfmpeg(dir: string, store: VersionStore): Promise<boolean> {
  console.log('[DEPS] [ffmpeg] Checking...');
  const release = await ghLatestRelease('yt-dlp/FFmpeg-Builds');
  const { tag, url } = ghFindAsset(release, /^ffmpeg-master-latest-win64-gpl\.zip$/);
  if (store['ffmpeg']?.version === tag) { console.log(`[DEPS] [ffmpeg] Up-to-date (${tag})`); return false; }
  console.log(`[DEPS] [ffmpeg] Updating → ${tag}`);
  const tmp = fs.mkdtempSync(path.join(localTmpDir, 'ffmpeg-'));
  try {
    const zipPath = path.join(tmp, 'ffmpeg.zip');
    await downloadFile(url, zipPath);
    extractZipToDir(zipPath, path.join(tmp, 'x'));
    const src = findFileInDir(path.join(tmp, 'x'), n => n === 'ffmpeg.exe');
    if (!src) throw new Error('ffmpeg.exe not found in zip');
    const dest = path.join(dir, 'ffmpeg.exe');
    fs.copyFileSync(src, dest);
    store['ffmpeg'] = { version: tag, sha256: fileSha256(dest) };
    console.log(`[DEPS] [ffmpeg] Done (${tag})`);
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function depUpdateBun(dir: string, store: VersionStore): Promise<boolean> {
  console.log('[DEPS] [bun] Checking...');
  const release = await ghLatestRelease('oven-sh/bun');
  const { tag, url } = ghFindAsset(release, /^bun-windows-x64\.zip$/);
  if (store['bun']?.version === tag) { console.log(`[DEPS] [bun] Up-to-date (${tag})`); return false; }
  console.log(`[DEPS] [bun] Updating → ${tag}`);
  const tmp = fs.mkdtempSync(path.join(localTmpDir, 'bun-'));
  try {
    const zipPath = path.join(tmp, 'bun.zip');
    await downloadFile(url, zipPath);
    extractZipToDir(zipPath, path.join(tmp, 'x'));
    const src = findFileInDir(path.join(tmp, 'x'), n => n === 'bun.exe');
    if (!src) throw new Error('bun.exe not found in zip');
    const dest = path.join(dir, 'bun.exe');
    fs.copyFileSync(src, dest);
    store['bun'] = { version: tag, sha256: fileSha256(dest) };
    console.log(`[DEPS] [bun] Done (${tag})`);
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function runDepUpdate(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(localTmpDir, { recursive: true });
  const store = readDepStore(dir);
  let changed = false;
  changed = (await depUpdateYtDlp(dir, store)) || changed;
  changed = (await depUpdateFfmpeg(dir, store)) || changed;
  changed = (await depUpdateBun(dir, store)) || changed;
  if (changed) {
    saveDepStore(dir, store);
    console.log('[DEPS] deps-versions.json updated.');
  } else {
    console.log('[DEPS] All dependencies already up-to-date.');
  }

  // Hosts entry requires UAC — do not let it crash the dep update.
  try {
    await ensureHostsEntry();
  } catch (err: any) {
    console.warn(`[DEPS] Could not patch hosts file (UAC may be unavailable): ${err.message}`);
  }

  // Self-update: copy current exe to safe watcher location
  try {
    fs.mkdirSync(VIDFIX_SAFE_DIR, { recursive: true });
    if (path.resolve(process.execPath) !== path.resolve(VIDFIX_SAFE_EXE)) {
      fs.copyFileSync(process.execPath, VIDFIX_SAFE_EXE);
      console.log(`[DEPS] Self-updated safe exe -> ${VIDFIX_SAFE_EXE}`);
      await replaceVRChatYtDlp();
    }
  } catch (err: any) {
    console.warn(`[DEPS] Could not update safe exe: ${err.message}`);
  }
}

// =============================================
// Hosts file patching
// =============================================

const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const HOSTS_MARKER_START = '# VRCVidFix - Start';
const HOSTS_MARKER_END = '# VRCVidFix - End';
const HOSTS_ENTRY = '127.0.0.1 localhost.youtube.com';

function hostsEntryExists(): boolean {
  try {
    const content = fs.readFileSync(HOSTS_PATH, 'utf-8');
    return content.includes('localhost.youtube.com');
  } catch {
    return false;
  }
}

async function ensureHostsEntry(): Promise<void> {
  if (hostsEntryExists()) {
    console.log('[HOSTS] localhost.youtube.com entry already present, skipping.');
    return;
  }

  console.log('[HOSTS] localhost.youtube.com not found in hosts file — requesting elevation to add it...');

  const block = `\`r\`n${HOSTS_MARKER_START}\`r\`n${HOSTS_ENTRY}\`r\`n${HOSTS_MARKER_END}`;

  const innerCmd = [
    `$h = '${HOSTS_PATH}';`,
    `$c = Get-Content $h -Raw -ErrorAction SilentlyContinue;`,
    `if ($c -notmatch 'localhost\\.youtube\\.com') {`,
    `  Add-Content -Path $h -Value "${block}" -Encoding ASCII`,
    `}`,
  ].join(' ');

  const outerArgs = [
    '-NonInteractive',
    '-NoProfile',
    '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NonInteractive','-NoProfile','-Command','${innerCmd.replace(/'/g, "''")}'`,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = cp.spawn('powershell', outerArgs, {
      stdio: 'inherit',
      windowsHide: false,
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        if (hostsEntryExists()) {
          console.log('[HOSTS] Entry added successfully.');
        } else {
          console.warn('[HOSTS] Elevated process exited 0 but entry not found — user may have cancelled UAC.');
        }
        resolve();
      } else {
        reject(new Error(`[HOSTS] Elevated hosts patch failed with exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}
