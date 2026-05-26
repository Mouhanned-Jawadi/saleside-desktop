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
    // notarytool sometimes prints a banner before JSON; try line-by-line.
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

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (!process.env.CI) {
    console.log('Skipping notarization — not in CI');
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appPassword || !teamId) {
    console.log('Skipping notarization — missing Apple credentials');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  console.log(`Notarizing ${appPath}...`);

  // notarytool only accepts .zip / .pkg / .dmg — zip the .app with ditto first.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saleside-notarize-'));
  const zipPath = path.join(tempDir, `${appName}.zip`);
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
        console.log(`\n=== notarytool info ${submissionId}, attempt ${attempt} ===`);
        result = runNotarytool(['info', submissionId], creds);
      }

      // Always echo notarytool's output so failures are diagnosable from logs.
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

      // Only retry on TRANSIENT markers (network drops, DNS, timeouts).
      // Deterministic errors (bad bundle, auth failure, missing entitlements) fail fast.
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
      console.log(`\n=== notarytool log ${submissionId} (final) ===`);
      runNotarytool(['log', submissionId], creds);
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
};
