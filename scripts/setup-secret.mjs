import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function getGcloudCmd() {
  const customPath = path.join(
    process.env.LOCALAPPDATA || 'C:\\Users\\mrfhs\\AppData\\Local',
    'Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd',
  );
  if (fs.existsSync(customPath)) {
    return `"${customPath}"`;
  }
  return 'gcloud';
}

const gcloud = getGcloudCmd();

// Read GEMINI_API_KEY from .env safely
const envFile = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envFile)) {
  console.error('.env file not found.');
  process.exit(1);
}

const envContent = fs.readFileSync(envFile, 'utf8');
const match = envContent.match(/^GEMINI_API_KEY=(.+)$/m);
if (!match || !match[1]?.trim()) {
  console.error('GEMINI_API_KEY not found in .env.');
  process.exit(1);
}

const apiKey = match[1].trim();

console.log('Ensuring secret "gemini-api-key" in Secret Manager...');

// Check if secret already exists
let secretExists = false;
try {
  execFileSync(gcloud, ['secrets', 'describe', 'gemini-api-key'], { stdio: 'ignore', shell: true });
  secretExists = true;
} catch {
  secretExists = false;
}

if (!secretExists) {
  const proc = spawnSync(gcloud, ['secrets', 'create', 'gemini-api-key', '--data-file=-'], {
    input: apiKey,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: true,
  });
  if (proc.status !== 0) {
    console.error('Failed to create secret.');
    process.exit(1);
  }
  console.log('Created secret "gemini-api-key".');
} else {
  // Add new version
  const proc = spawnSync(
    gcloud,
    ['secrets', 'versions', 'add', 'gemini-api-key', '--data-file=-'],
    {
      input: apiKey,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
    },
  );
  if (proc.status !== 0) {
    console.error('Failed to add version to secret.');
    process.exit(1);
  }
  console.log('Updated secret "gemini-api-key" with new version.');
}

// Grant access to Cloud Run compute service account
const serviceAccount = '382237748096-compute@developer.gserviceaccount.com';
console.log(`Binding secretAccessor IAM role to ${serviceAccount}...`);
execFileSync(
  gcloud,
  [
    'secrets',
    'add-iam-policy-binding',
    'gemini-api-key',
    `--member=serviceAccount:${serviceAccount}`,
    '--role=roles/secretmanager.secretAccessor',
  ],
  { stdio: 'inherit', shell: true },
);

console.log('Secret Manager setup successfully completed.');
