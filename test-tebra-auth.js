import { getProviders } from './src/clients/tebraClient.js';

async function main() {
  try {
    const result = await getProviders();
    console.log('AUTH SUCCESS — Tebra accepted the new credentials.');
  } catch (err) {
    console.error('AUTH FAILED:', err.message);
    process.exit(1);
  }
}
main();
