import fs from 'fs';
import readline from 'readline';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

const AUTH_DIR = './store/auth';
const QR_FILE = './store/qr-data.txt';
const STATUS_FILE = './store/auth-status.txt';

const logger = {
  level: 'warn',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => logger,
};

const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered && !isReconnect) {
    fs.writeFileSync(STATUS_FILE, 'already_authenticated');
    console.log('Already authenticated with WhatsApp');
    process.exit(0);
  }

  const { version } = await fetchLatestWaWebVersion({}).catch(() => {
    return { version: undefined };
  });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  if (usePairingCode && phoneNumber && !state.creds.me) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`Pairing code: ${code}`);
        fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to request pairing code:', message);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      fs.writeFileSync(QR_FILE, qr);
      console.log('Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        process.exit(1);
      } else if (reason === 515) {
        console.log('Stream error after pairing, reconnecting...');
        void connectSocket(phoneNumber, true);
      } else {
        fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        process.exit(1);
      }
    }

    if (connection === 'open') {
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      try {
        fs.unlinkSync(QR_FILE);
      } catch {}
      console.log('Successfully authenticated with WhatsApp');
      setTimeout(() => process.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  try {
    fs.unlinkSync(QR_FILE);
  } catch {}
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (country code, no + or spaces): ',
    );
  }

  await connectSocket(phoneNumber);
}

authenticate().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Authentication failed:', message);
  process.exit(1);
});
