const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSIENT_MARKERS = [
  '-1009',
  'connection appears to be offline',
  'HTTPError',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'connection reset',
  'request timed out',
  'temporary failure',
  'Could not resolve host',
  // Apple-side processing-timeout (submission still in queue, just slow):
  'was reached before processing completed',
  'Timeout of',
];

const BACKOFF_SECONDS = [30, 90, 180];

function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function isTransient(text) {
  if (!text) return false;
  return TRANSIENT_MARKERS.some(marker => text.includes(marker));
}

function extractSubmissionId(text) {
  if (!text) return null;
  const m = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}

function parseStatus(stdout) {
  if (!stdout) return null;
  try {
    const json = JSON.parse(stdout);
    if (json && typeof json.status === 'string') return json;
  } catch (_) {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const json = JSON.parse(trimmed);
          if (json && typeof json.status === 'string') return json;
        } catch (_) { /* keep scanning */ }
      }
    }
  }
  return null;
}

function runNotarytool(args, { appleId, appPassword, teamId }) {
  const fullArgs = [
    'notarytool',
    ...args,
    '--apple-id', appleId,
    '--password', appPassword,
    '--team-id', teamId,
    '--output-format', 'json',
  ];
  console.log(`+ xcrun ${fullArgs.join(' ').replace(appPassword, '***')}`);
  const res = spawnSync('xcrun', fullArgs, { encoding: 'utf8' });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

function runPlain(cmd, args) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'inherit' });
  return res.status;
}

async function notarizeApp(appPath) {
  if (!fs.existsSync(appPath)) {
    throw new Error(`App bundle not found at ${appPath}`);
  }

  const appleId = process.env.APPLE_ID;
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appPassword || !teamId) {
    throw new Error('Missing Apple credentials (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)');
  }

  console.log(`Notarizing ${appPath}...`);

  // Diagnostic: print recent submission history for this team so we can see
  // whether ANY past notarization has ever succeeded.
  console.log(`\n=== notarytool history (last 10) ===`);
  const histRes = runNotarytool(['history'], { appleId, appPassword, teamId });
  if (histRes.stdout) console.log(histRes.stdout);
  if (histRes.stderr) console.log(histRes.stderr);

  const appBaseName = path.basename(appPath, '.app');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saleside-notarize-'));
  const zipPath = path.join(tempDir, `${appBaseName}.zip`);
  console.log(`\n=== zipping app for submission ===`);
  console.log(`+ ditto -c -k --sequesterRsrc --keepParent ${appPath} ${zipPath}`);
  const dittoRes = spawnSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath],
    { encoding: 'utf8', stdio: 'inherit' },
  );
  if (dittoRes.status !== 0) {
    throw new Error(`ditto exited with code ${dittoRes.status} while zipping the .app`);
  }

  const creds = { appleId, appPassword, teamId };
  let submissionId = null;
  let accepted = false;
  let lastFailure = null;

  try {
    for (let attempt = 1; attempt <= BACKOFF_SECONDS.length + 1; attempt++) {
      let result;
      if (submissionId === null) {
        console.log(`\n=== notarytool submit, attempt ${attempt} ===`);
        result = runNotarytool(
          ['submit', zipPath, '--wait', '--timeout', '25m'],
          creds,
        );
      } else {
        console.log(`\n=== notarytool wait ${submissionId}, attempt ${attempt} ===`);
        result = runNotarytool(
          ['wait', submissionId, '--timeout', '25m'],
          creds,
        );
      }

      if (result.stdout && result.stdout.trim()) {
        console.log(`--- notarytool stdout ---\n${result.stdout.trim()}\n-------------------------`);
      }
      if (result.stderr && result.stderr.trim()) {
        console.log(`--- notarytool stderr ---\n${result.stderr.trim()}\n-------------------------`);
      }

      const idFromOutput =
        extractSubmissionId(result.stdout) || extractSubmissionId(result.stderr);
      if (idFromOutput && !submissionId) {
        submissionId = idFromOutput;
        console.log(`Captured submission id: ${submissionId}`);
      }

      const parsed = parseStatus(result.stdout);
      if (parsed) {
        console.log(`notarytool status: ${parsed.status} (${parsed.message || 'no message'})`);
        if (parsed.status === 'Accepted') {
          accepted = true;
          break;
        }
        if (parsed.status === 'In Progress') {
          const wait = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
          console.log(`Still in progress; sleeping ${wait}s before polling again.`);
          await sleep(wait);
          continue;
        }
        if (parsed.status === 'Invalid' || parsed.status === 'Rejected') {
          if (submissionId) {
            console.log(`\n=== notarytool log ${submissionId} ===`);
            const logRes = runNotarytool(['log', submissionId], creds);
            if (logRes.stdout) console.log(logRes.stdout);
            if (logRes.stderr) console.log(logRes.stderr);
          }
          throw new Error(`Notarization rejected by Apple with status "${parsed.status}".`);
        }
      }

      const combined = `${result.stdout}\n${result.stderr}`;
      lastFailure = combined.trim() || `exit code ${result.code}`;

      if (!isTransient(combined)) {
        console.log(`Non-transient notarytool failure (exit ${result.code}) — failing fast without retry.`);
        break;
      }

      if (attempt > BACKOFF_SECONDS.length) break;

      const wait = BACKOFF_SECONDS[attempt - 1];
      console.log(
        `Transient notarytool failure (exit ${result.code}). Retrying in ${wait}s — ` +
        `${submissionId ? `will reattach to submission ${submissionId}` : 'will resubmit'}.`,
      );
      await sleep(wait);
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  if (!accepted) {
    if (submissionId) {
      console.log(`\n=== notarytool info ${submissionId} (final) ===`);
      const infoRes = runNotarytool(['info', submissionId], creds);
      if (infoRes.stdout) console.log(infoRes.stdout);
      if (infoRes.stderr) console.log(infoRes.stderr);

      console.log(`\n=== notarytool log ${submissionId} (final) ===`);
      const logRes = runNotarytool(['log', submissionId], creds);
      if (logRes.stdout) console.log(logRes.stdout);
      if (logRes.stderr) console.log(logRes.stderr);
    }
    throw new Error(
      `Notarization failed after retries. Last failure: ${lastFailure || 'unknown'}`,
    );
  }

  console.log(`\n=== stapling ${appPath} ===`);
  const stapleCode = runPlain('xcrun', ['stapler', 'staple', appPath]);
  if (stapleCode !== 0) {
    throw new Error(`xcrun stapler staple exited with code ${stapleCode}`);
  }

  console.log(`\n=== spctl assessment (log-only) ===`);
  runPlain('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);

  console.log('Notarization complete.');
}

// electron-builder afterSign hook entry point.
// Set SKIP_NOTARIZE=1 to disable (used by CI when notarization runs in a separate job).
exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('Skipping notarization here (SKIP_NOTARIZE=1) — handled in separate CI job.');
    return;
  }
  if (!process.env.CI) {
    console.log('Skipping notarization — not in CI');
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  await notarizeApp(appPath);
};

// CLI entry point: `node notarize.js /path/to/SaleSide.app`
if (require.main === module) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Usage: node notarize.js <path-to-.app>');
    process.exit(1);
  }
  notarizeApp(path.resolve(appPath)).catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
